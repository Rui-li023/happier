import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import {
  ClaudeUnifiedTerminalProviderRefusedStartError,
  ClaudeUnifiedTerminalReadinessTimeoutError,
  createClaudeUnifiedTerminalReadinessBridge,
  isClaudeUnifiedTerminalProviderRefusedStartError,
  isClaudeUnifiedTerminalReadinessTimeoutError,
} from './createClaudeUnifiedTerminalReadinessBridge';
import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import { parseClaudeScreenState } from './tuiControls/screenState';
import { resolveClaudeUnifiedVisibleDialog } from './tuiControls/dialogRegistry';
import { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';

const handle: TerminalHostHandle = {
  kind: 'zellij',
  sessionName: 'happier-claude-unified-test',
  paneId: 'terminal_1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

function createArbiter() {
  return {
    observeLifecycle: vi.fn(),
    observeUserTypingState: vi.fn(),
    drainWhenSafe: vi.fn().mockResolvedValue(undefined),
  };
}

const interactiveClaudeScreen = [
  'Some previous Claude output',
  '',
  'What would you like to work on?',
  '> ',
].join('\n');

// Real Claude renders a boxed composer (`│ > │`); the previous narrow readiness regex missed it
// (no bare `> $` line, no "What would you like to work on?" in the tail), producing a false-negative
// "not ready" that killed the live host on heavy/xhigh startups (incident cmq7zi1y).
const boxedInteractiveClaudeScreen = [
  'Claude Code v2.1.170',
  ' Tips for getting started:',
  '  Run /init to create a CLAUDE.md file',
  '╭───────────────────────────────────────────────╮',
  '│ >                                               │',
  '╰───────────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n');

const resumeChoiceDialogScreen = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const effortChangeDialogHighScreen = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

const tmuxHandle: TerminalHostHandle = {
  kind: 'tmux',
  sessionName: 'happier-claude-unified-test',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

describe('createClaudeUnifiedTerminalReadinessBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles the poll promise on abort without waiting out the pending poll timer', async () => {
    vi.useFakeTimers();
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: false, observedAt: 0 });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      arbiter,
      pollIntervalMs: 250,
      timeoutMs: 15_000,
      nowMs: () => 0,
    });
    const abortController = new AbortController();

    let settled = false;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .then(() => { settled = true; });
    // Let the first probe resolve and the loop enter its poll wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);
    bridge.dispose();
    await started;
  });

  it('fails fast with the classified refusal when Claude refuses to start', async () => {
    // Observed 2026-09-19: the provider prints this and exits 1 before any session exists, so
    // readiness can never arrive. Waiting out the window would report a timeout the launcher then
    // retries, burning the whole relaunch budget on a verdict Claude already gave.
    // Deliberately real timers: the refusal must be raised on the first screen, before any poll
    // or timeout window, so this test needs no clock control and cannot hold a worker open.
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 10 });
    const captureInputState = vi.fn().mockResolvedValue({
      stable: true,
      currentInput: 'Error: Session 726be323 is running as a background session (726be323). '
        + 'Run `claude attach 726be323` to open it, or `claude stop 726be323` first to resume it here.',
      cursor: undefined,
      observedAt: 10,
    });
    const onStartupReady = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 250,
      timeoutMs: 15_000,
      nowMs: () => 0,
      onStartupReady,
    });

    const error = await Promise.resolve(bridge.start({ abortSignal: new AbortController().signal }))
      .then(() => null, (thrown: unknown) => thrown);
    expect(isClaudeUnifiedTerminalProviderRefusedStartError(error)).toBe(true);
    expect((error as ClaudeUnifiedTerminalProviderRefusedStartError).refusal).toMatchObject({
      code: 'session_held_by_background',
      retryable: false,
    });
    // The verdict arrives immediately, not after the readiness window.
    expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(false);
    expect(onStartupReady).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('retries after a transient liveness probe failure and still reports startup readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn()
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockResolvedValueOnce({ paneAlive: true, observedAt: 10 });
    const captureInputState = vi.fn().mockResolvedValue({
      stable: true,
      currentInput: interactiveClaudeScreen,
      observedAt: 10,
    });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });

  it('retries after a transient input-state capture failure and still reports startup readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 10 });
    const captureInputState = vi.fn()
      .mockRejectedValueOnce(new Error('capture unavailable'))
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeUserTypingState).toHaveBeenCalledWith({
      userTyping: false,
      observedAtMs: 10,
    });

    bridge.dispose();
  });

  it('returns a supervised promise when readiness drain fails', async () => {
    const arbiter = createArbiter();
    const drainError = new Error('readiness drain failed');
    arbiter.drainWhenSafe.mockRejectedValue(drainError);
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 10 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: interactiveClaudeScreen,
          observedAt: 10,
        }),
      },
      handle,
      arbiter,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });

    expect(started).toBeInstanceOf(Promise);
    await expect(started).rejects.toBe(drainError);

    bridge.dispose();
  });

  it('keeps retrying repeated liveness probe failures until startup timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockRejectedValue(new Error('control plane unavailable'));
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      onStartupReady: vi.fn(),
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(evaluateLiveness.mock.calls.length).toBeGreaterThan(1);
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();
    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('clears the quiet drain timer on disposal', async () => {
    vi.useFakeTimers();
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: interactiveClaudeScreen,
          observedAt: 1,
        }),
      },
      handle,
      arbiter,
      quietPeriodMs: 50,
      timeoutMs: 100,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(arbiter.drainWhenSafe).toHaveBeenCalledTimes(1);

    bridge.dispose();
    await vi.advanceTimersByTimeAsync(50);

    expect(arbiter.drainWhenSafe).toHaveBeenCalledTimes(1);
  });

  it('does not report readiness when the host stays non-live through timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: false, observedAt: 0 });
    const captureInputState = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();
    expect(captureInputState).not.toHaveBeenCalled();
    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('rejects the supervised startup task when readiness never arrives before timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: false,
          currentInput: '',
          observedAt: 0,
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('does not reject startup readiness after trusted provider progress is observed', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let providerProgressObserved = false;
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: 'Claude is working on your request',
          observedAt: 0,
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      hasTrustedProviderProgress: () => providerProgressObserved,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    providerProgressObserved = true;
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    await expect(started).resolves.toBeUndefined();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'output' }));

    bridge.dispose();
  });

  it('does not report zellij startup readiness for a stable but non-interactive resume screen', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: [
          'Resuming previous conversation...',
          'Rendering transcript messages and tools...',
        ].join('\n'),
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });

  it('lets a startup dialog resolver handle the resume-choice interstitial before reporting readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const resolveStartupDialog = vi.fn()
      .mockResolvedValueOnce({ status: 'handled' })
      .mockResolvedValue({ status: 'unhandled' });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: resumeChoiceDialogScreen,
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: boxedInteractiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
      resolveStartupDialog,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveStartupDialog).toHaveBeenCalledTimes(1);
    expect(onStartupReady).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });
    bridge.dispose();
  });

  it('re-observes after resolving an orphan effort dialog so queued delivery can drain', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const { session } = createPermissionHandlerSessionStub('readiness-effort-dialog-session');
    const port = createFakeControlPort({ captures: [effortChangeDialogHighScreen, boxedInteractiveClaudeScreen] });
    const resolveStartupDialog = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker: new ClaudeUnifiedDialogChoiceBroker(session),
      port,
      wait: async () => undefined,
      settleMs: 1,
      startupMode: { permissionMode: 'default', reasoningEffort: 'high' },
      isRuntimeControlInFlight: () => false,
    });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: effortChangeDialogHighScreen,
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: boxedInteractiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
      resolveStartupDialog,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });
    expect(arbiter.drainWhenSafe).toHaveBeenCalled();
    bridge.dispose();
  });

  it('pauses the readiness deadline while the exact live dialog waits for a user answer', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const abortController = new AbortController();
    let waitingForUser = true;
    const resolveStartupDialog = vi.fn().mockImplementation(() => (
      waitingForUser ? { status: 'waiting_for_user' as const } : { status: 'unhandled' as const }
    ));
    const captureInputState = vi.fn().mockImplementation(async () => ({
      stable: true,
      currentInput: waitingForUser ? resumeChoiceDialogScreen : interactiveClaudeScreen,
      observedAt: nowMs,
    }));
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 30,
      progressGraceMs: 1,
      nowMs: () => nowMs,
      resolveStartupDialog,
    });

    let rejection: unknown;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .catch((error: unknown) => { rejection = error; });

    try {
      await Promise.resolve();
      for (let i = 0; i < 5; i += 1) {
        nowMs += 10;
        await vi.advanceTimersByTimeAsync(10);
      }

      expect(rejection).toBeUndefined();
      expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

      waitingForUser = false;
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
      await started;

      expect(rejection).toBeUndefined();
      expect(resolveStartupDialog).toHaveBeenCalled();
      expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: nowMs });
    } finally {
      abortController.abort();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      bridge.dispose();
    }
  });

  it.each(['inconclusive', 'probe_failed', 'capture_failed', 'dead'] as const)(
    'keeps the human wait through %s observations unless host death is definitive',
    async (observation) => {
      vi.useFakeTimers();
      let nowMs = 0;
      let interrupted = false;
      const { session, client } = createPermissionHandlerSessionStub('startup-human-wait');
      const broker = new ClaudeUnifiedDialogChoiceBroker(session);
      const screen = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'].join('\n');
      const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(screen))!;
      void broker.requestDialogChoice({ dialog }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toHaveLength(1);
      const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
        choice: 'ask_every_time', broker,
        port: createFakeControlPort({ captures: [screen] }),
        wait: async () => undefined, settleMs: 1,
      });
      const abortController = new AbortController();
      let rejection: unknown;
      const bridge = createClaudeUnifiedTerminalReadinessBridge({
        hostAdapter: {
          async evaluateLiveness() {
            if (interrupted && observation === 'probe_failed') throw new Error('probe unavailable');
            return {
              paneAlive: !interrupted || observation === 'capture_failed',
              paneDead: interrupted && observation === 'dead' ? true : undefined,
              probeInconclusive: interrupted && observation === 'inconclusive',
              observedAt: nowMs,
            };
          },
          async captureInputState() {
            if (interrupted && observation === 'capture_failed') throw new Error('capture unavailable');
            return { stable: true, currentInput: screen, observedAt: nowMs };
          },
        },
        handle, arbiter: createArbiter(), resolveStartupDialog: resolver,
        pollIntervalMs: 10, timeoutMs: 20, extendedTimeoutMs: 20,
        nowMs: () => nowMs,
      });
      const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
        .catch((error: unknown) => { rejection = error; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        interrupted = true;
        for (let i = 0; i < 6; i += 1) {
          nowMs += 10;
          await vi.advanceTimersByTimeAsync(10);
        }
        if (observation === 'dead') {
          expect(isClaudeUnifiedTerminalReadinessTimeoutError(rejection)).toBe(true);
        } else {
          expect(rejection).toBeUndefined();
          interrupted = false;
          nowMs += 10;
          await vi.advanceTimersByTimeAsync(10);
          expect(rejection).toBeUndefined();
        }
      } finally {
        abortController.abort();
        await vi.advanceTimersByTimeAsync(0);
        await started;
        bridge.dispose();
        await broker.dispose();
      }
    },
  );

  it('resumes the readiness timeout after the human-wait dialog disappears without a ready composer', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let dialogVisible = true;
    let rejection: unknown;
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockImplementation(async () => ({
          stable: true,
          currentInput: dialogVisible ? resumeChoiceDialogScreen : 'Claude startup output without a composer',
          observedAt: nowMs,
        })),
      },
      handle,
      arbiter: createArbiter(),
      pollIntervalMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 20,
      progressGraceMs: 1,
      nowMs: () => nowMs,
      resolveStartupDialog: vi.fn().mockImplementation(() => (
        dialogVisible ? { status: 'waiting_for_user' as const } : { status: 'unhandled' as const }
      )),
    });
    const started = Promise.resolve(bridge.start({ abortSignal: new AbortController().signal }))
      .catch((error: unknown) => { rejection = error; });

    for (let i = 0; i < 5; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(rejection).toBeUndefined();

    dialogVisible = false;
    for (let i = 0; i < 3; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    await started;
    expect(isClaudeUnifiedTerminalReadinessTimeoutError(rejection)).toBe(true);
    bridge.dispose();
  });

  it('fails with diagnostics when input-state capture never settles before the readiness deadline', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const abortController = new AbortController();
    let releaseCapture: ((value: {
      stable: boolean;
      currentInput: string;
      observedAt: number;
    }) => void) | undefined;
    const captureInputState = vi.fn(() => new Promise<{
      stable: boolean;
      currentInput: string;
      observedAt: number;
    }>((resolve) => {
      releaseCapture = resolve;
    }));
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 30,
      progressGraceMs: 1,
      nowMs: () => nowMs,
    });

    let rejection: unknown;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .catch((error: unknown) => { rejection = error; });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(captureInputState).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 4; i += 1) {
        nowMs += 10;
        await vi.advanceTimersByTimeAsync(10);
      }

      expect(isClaudeUnifiedTerminalReadinessTimeoutError(rejection)).toBe(true);
      expect((rejection as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics).toMatchObject({
        hostAlive: true,
        lastLivenessPaneAlive: true,
      });
      expect(arbiter.observeLifecycle).not.toHaveBeenCalled();
    } finally {
      releaseCapture?.({
        stable: false,
        currentInput: '',
        observedAt: nowMs,
      });
      abortController.abort();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      bridge.dispose();
    }
  });

  it('reports startup readiness for a boxed interactive Claude composer via the shared parser (D15)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: boxedInteractiveClaudeScreen,
          observedAt: 1,
        }),
      },
      handle: tmuxHandle,
      arbiter,
      quietPeriodMs: 50,
      timeoutMs: 100,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await flushMicrotasks();

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'output' }));

    bridge.dispose();
  });

  it('extends the startup window for a live, progressing host until the interactive marker appears (D17)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let captures = 0;
    const captureInputState = vi.fn().mockImplementation(async () => {
      captures += 1;
      if (captures < 6) {
        return { stable: true, currentInput: `Rendering transcript chunk ${captures} of many…`, observedAt: Date.now() };
      }
      return { stable: true, currentInput: boxedInteractiveClaudeScreen, observedAt: Date.now() };
    });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      quietPeriodMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 1_000,
      progressGraceMs: 80,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(onStartupReady).toHaveBeenCalledTimes(1);
    }, { timeout: 2_000 });

    bridge.dispose();
    await expect(started).resolves.toBeUndefined();
    expect(captures).toBeGreaterThanOrEqual(6);
  });

  it('times out a live but stable unknown host past the base window and attaches sanitized diagnostics (D16/D18)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const stableUnknownScreen = 'Initializing Claude Code…\nLoading workspace configuration';
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: stableUnknownScreen,
          observedAt: Date.now(),
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      // With SessionStart observed, a static screen holds until the HARD ceiling (incident pid-15592:
      // a heavy-resume render stall >grace must not kill a confirmed provider session). Keep the
      // ceiling small here so the test stays fast.
      extendedTimeoutMs: 120,
      progressGraceMs: 40,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const error = await Promise.resolve(started).then(() => null, (rejection: unknown) => rejection);

    expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(true);
    expect(onStartupReady).not.toHaveBeenCalled();
    const diagnostics = (error as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics;
    expect(diagnostics?.hostAlive).toBe(true);
    expect(diagnostics?.sessionStartObserved).toBe(true);
    expect(diagnostics?.lastLivenessPaneAlive).toBe(true);
    expect(diagnostics?.lastScreenTail).toContain('Initializing Claude Code');

    bridge.dispose();
  });

  it('holds a SessionStart-confirmed host through a static render stall until the hard ceiling (D17 refinement, incident pid-15592)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let screen = 'Resumed conversation tail\n+canonical profile home with sh';
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState: vi.fn().mockImplementation(async () => ({
          stable: true,
          currentInput: screen,
          observedAt: Date.now(),
        })),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      extendedTimeoutMs: 400,
      progressGraceMs: 40,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    // Past base (20ms) + grace (40ms) the screen is still static — a confirmed provider session must
    // KEEP polling instead of fast-failing. Reveal the composer before the ceiling: readiness succeeds.
    setTimeout(() => {
      screen = '╭───╮\n│ ❯   │\n╰───╯\n  ? for shortcuts';
    }, 150);
    await started;

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('does not extend the window for a non-live host even if the screen keeps changing (D17 safety)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let captures = 0;
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: false, observedAt: Date.now() }),
        captureInputState: vi.fn().mockImplementation(async () => {
          captures += 1;
          return { stable: true, currentInput: `still booting ${captures}`, observedAt: Date.now() };
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      extendedTimeoutMs: 1_000,
      progressGraceMs: 80,
      hasHostAliveEvidence: () => false,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const error = await Promise.resolve(started).then(() => null, (rejection: unknown) => rejection);

    expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(true);
    expect((error as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics?.hostAlive).toBe(false);
    expect(onStartupReady).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('does not report tmux startup readiness for a stable but non-interactive resume screen', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: [
          'Resuming previous conversation...',
          'Rendering transcript messages and tools...',
        ].join('\n'),
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle: tmuxHandle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });
});
