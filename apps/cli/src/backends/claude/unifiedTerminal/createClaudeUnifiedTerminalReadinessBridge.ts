import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { delayUnrefAbortable } from '@/utils/time';

import {
  classifyClaudeStartupRefusal,
  type ClaudeStartupRefusal,
} from '../claudeStartupRefusal';

import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedStartableDisposable,
  ClaudeUnifiedTerminalScreenObservation,
} from './_types';
import {
  isClaudeScreenReadyForInput,
  parseClaudeScreenState,
  type ClaudeScreenState,
} from './tuiControls/screenState';

const DEFAULT_STARTUP_READINESS_POLL_MS = 250;
const DEFAULT_STARTUP_READINESS_TIMEOUT_MS = 15_000;

const DIAGNOSTICS_MAX_TAIL_LINES = 40;
const DIAGNOSTICS_MAX_TAIL_CHARS = 2_000;

/**
 * Sanitized diagnostics captured when startup readiness times out. Attached to the timeout error so a
 * live-host startup failure surfaces with actionable context (last normalized screen tail + liveness)
 * instead of dying as a silent, generic fatal command error. The screen tail is already ANSI-stripped
 * by the shared capture parser and is bounded in size here.
 */
export type ClaudeUnifiedReadinessTimeoutDiagnostics = Readonly<{
  elapsedMs: number;
  hostAlive: boolean;
  sessionStartObserved: boolean;
  lastLivenessPaneAlive: boolean | null;
  lastScreenTail: string | null;
}>;

export class ClaudeUnifiedTerminalReadinessTimeoutError extends Error {
  readonly code = 'claude_unified_terminal_readiness_timeout';
  readonly timeoutMs: number;
  readonly handle: TerminalHostHandle;
  readonly diagnostics: ClaudeUnifiedReadinessTimeoutDiagnostics | undefined;

  constructor(params: Readonly<{
    timeoutMs: number;
    handle: TerminalHostHandle;
    diagnostics?: ClaudeUnifiedReadinessTimeoutDiagnostics | undefined;
  }>) {
    super('Claude unified terminal did not become ready before startup timeout');
    this.name = 'ClaudeUnifiedTerminalReadinessTimeoutError';
    this.timeoutMs = params.timeoutMs;
    this.handle = params.handle;
    this.diagnostics = params.diagnostics;
  }
}

export function isClaudeUnifiedTerminalReadinessTimeoutError(
  error: unknown,
): error is ClaudeUnifiedTerminalReadinessTimeoutError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_readiness_timeout';
}

/**
 * Claude refused to start, so readiness will never arrive. This is not a timeout: waiting out the
 * readiness window would only delay a verdict the provider already gave, and relaunching with the
 * same arguments reproduces it exactly. Carries the classified refusal so the launcher can offer
 * the fix instead of spending relaunches on it.
 */
export class ClaudeUnifiedTerminalProviderRefusedStartError extends Error {
  readonly code = 'claude_unified_terminal_provider_refused_start';
  readonly refusal: ClaudeStartupRefusal;
  readonly handle: TerminalHostHandle;
  readonly diagnostics: Readonly<{ screenTail: string | null }> | undefined;

  constructor(params: Readonly<{
    refusal: ClaudeStartupRefusal;
    handle: TerminalHostHandle;
    diagnostics?: Readonly<{ screenTail: string | null }> | undefined;
  }>) {
    super(`Claude refused to start (${params.refusal.code})`);
    this.name = 'ClaudeUnifiedTerminalProviderRefusedStartError';
    this.refusal = params.refusal;
    this.handle = params.handle;
    this.diagnostics = params.diagnostics;
  }
}

export function isClaudeUnifiedTerminalProviderRefusedStartError(
  error: unknown,
): error is ClaudeUnifiedTerminalProviderRefusedStartError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_provider_refused_start';
}

function sanitizeScreenTail(text: string | null): string | null {
  if (!text) return null;
  const tail = text.split('\n').slice(-DIAGNOSTICS_MAX_TAIL_LINES).join('\n');
  return tail.length > DIAGNOSTICS_MAX_TAIL_CHARS ? tail.slice(-DIAGNOSTICS_MAX_TAIL_CHARS) : tail;
}

function isInputStateReady(
  state: Readonly<{ stable: boolean }>,
  screen: ClaudeScreenState,
): boolean {
  if (!state.stable) return false;
  return isClaudeScreenReadyForInput(screen);
}

export type ClaudeUnifiedStartupDialogResolution =
  | Readonly<{ status: 'unhandled' }>
  | Readonly<{ status: 'handled' }>
  | Readonly<{ status: 'waiting_for_user' }>;

export type ClaudeUnifiedStartupDialogResolver = (input: Readonly<{
  screenState: ClaudeScreenState;
  observedAtMs: number;
  abortSignal: AbortSignal;
}>) => Promise<ClaudeUnifiedStartupDialogResolution> | ClaudeUnifiedStartupDialogResolution;

export function createClaudeUnifiedTerminalReadinessBridge(opts: Readonly<{
  hostAdapter: Pick<TerminalHostAdapter, 'captureInputState' | 'evaluateLiveness'>;
  handle: TerminalHostHandle;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'observeLifecycle' | 'observeUserTypingState' | 'drainWhenSafe'>;
  pollIntervalMs?: number | undefined;
  quietPeriodMs?: number | undefined;
  timeoutMs?: number | undefined;
  /**
   * Hard ceiling (D17). Past the base `timeoutMs`, a host that is alive AND still progressing keeps
   * polling until this ceiling so heavy/xhigh fresh startups are not killed before the interactive
   * marker renders. Defaults to `timeoutMs` (no extension) so existing callers are unaffected.
   */
  extendedTimeoutMs?: number | undefined;
  /**
   * Static-screen grace (D17). Past the base window, a live host whose screen has been unchanged for
   * this long is considered stuck and times out (with diagnostics). Defaults to `timeoutMs`.
   */
  progressGraceMs?: number | undefined;
  emitOutputReadiness?: boolean | undefined;
  nowMs?: (() => number) | undefined;
  onStartupReady?: (() => void) | undefined;
  hasTrustedProviderProgress?: (() => boolean) | undefined;
  /**
   * Host-alive evidence independent of injection-readiness (D17), e.g. the Claude `SessionStart` hook.
   * SessionStart proves the host process is alive but NOT that the interactive composer is ready, so it
   * extends the startup window instead of standing it down.
   */
  hasHostAliveEvidence?: (() => boolean) | undefined;
  canReportStartupReady?: (() => boolean) | undefined;
  /**
   * Known startup dialogs are blocking, but some can be resolved before the normal composer appears.
   * The resolver may auto-handle the dialog or publish a user action. While the exact dialog and
   * runtime stay live, the user wait pauses the readiness deadline; normal timeout accounting resumes
   * as soon as that dialog disappears, changes, or the host stops being live.
   */
  resolveStartupDialog?: ClaudeUnifiedStartupDialogResolver | undefined;
  onScreenObserved?: ((observation: ClaudeUnifiedTerminalScreenObservation) => void) | undefined;
}>): ClaudeUnifiedStartableDisposable {
  const pollIntervalMs = Math.max(1, Math.trunc(opts.pollIntervalMs ?? DEFAULT_STARTUP_READINESS_POLL_MS));
  const quietPeriodMs = Math.max(0, Math.trunc(opts.quietPeriodMs ?? TERMINAL_INPUT_QUIET_PERIOD_MS));
  const timeoutMs = Math.max(1, Math.trunc(opts.timeoutMs ?? DEFAULT_STARTUP_READINESS_TIMEOUT_MS));
  const extendedTimeoutMs = Math.max(timeoutMs, Math.trunc(opts.extendedTimeoutMs ?? timeoutMs));
  const progressGraceMs = Math.max(0, Math.trunc(opts.progressGraceMs ?? timeoutMs));
  const emitOutputReadiness = opts.emitOutputReadiness ?? true;
  const nowMs = opts.nowMs ?? Date.now;

  let disposed = false;
  let started = false;
  let quietDrainTimer: ReturnType<typeof setTimeout> | null = null;

  const clearQuietDrainTimer = (): void => {
    if (!quietDrainTimer) return;
    clearTimeout(quietDrainTimer);
    quietDrainTimer = null;
  };

  const scheduleQuietDrain = (): void => {
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(() => {
      void opts.arbiter.drainWhenSafe().catch(() => undefined);
    }, quietPeriodMs);
    quietDrainTimer.unref?.();
  };

  const observeReady = async (observedAtMs: number): Promise<void> => {
    opts.onStartupReady?.();
    if (!emitOutputReadiness) return;
    opts.arbiter.observeLifecycle({ type: 'output', observedAtMs });
    await opts.arbiter.drainWhenSafe();
    scheduleQuietDrain();
  };

  const pollUntilReady = async (abortSignal: AbortSignal): Promise<void> => {
    const startedAtMs = nowMs();
    let lastLivenessPaneAlive: boolean | null = null;
    let lastScreenText: string | null = null;
    let lastProgressAtMs = startedAtMs;
    let readinessPausedAtMs: number | null = null;
    let readinessPausedDurationMs = 0;

    const effectiveNowMs = (): number => {
      const current = nowMs();
      const activePauseDuration = readinessPausedAtMs === null ? 0 : Math.max(0, current - readinessPausedAtMs);
      return current - readinessPausedDurationMs - activePauseDuration;
    };
    const beginHumanDialogWait = (): void => {
      readinessPausedAtMs ??= nowMs();
    };
    const endHumanDialogWait = (): void => {
      if (readinessPausedAtMs === null) return;
      readinessPausedDurationMs += Math.max(0, nowMs() - readinessPausedAtMs);
      readinessPausedAtMs = null;
    };

    const hasTrustedProviderProgress = (): boolean => opts.hasTrustedProviderProgress?.() === true;
    const hasHostAliveEvidence = (): boolean => opts.hasHostAliveEvidence?.() === true;
    const canReportStartupReady = (): boolean => opts.canReportStartupReady?.() !== false;
    const isHostAlive = (): boolean => lastLivenessPaneAlive === true || hasHostAliveEvidence();

    const recordScreenProgress = (screenText: string): void => {
      if (screenText !== lastScreenText) {
        lastScreenText = screenText;
        lastProgressAtMs = effectiveNowMs();
      }
    };

    // Adaptive timeout (D17): before the base window, never time out. After the base window but within
    // the extended ceiling, keep a LIVE host alive while its output is still progressing (heavy/xhigh
    // fresh startups render the interactive composer slowly). A host whose provider session is CONFIRMED
    // (SessionStart observed) holds through static render stalls until the hard ceiling — a heavy-resume
    // replay can pause rendering longer than the progress grace while the TUI is healthy (incident
    // pid-15592). A pane-alive-only host static past the grace, a host past the hard ceiling, or any
    // non-live host, times out.
    const isTimedOut = (): boolean => {
      if (readinessPausedAtMs !== null) return false;
      const effectiveNow = effectiveNowMs();
      const elapsed = effectiveNow - startedAtMs;
      if (elapsed < timeoutMs) return false;
      if (elapsed >= extendedTimeoutMs) return true;
      if (!isHostAlive()) return true;
      if (hasHostAliveEvidence()) return false;
      return effectiveNow - lastProgressAtMs >= progressGraceMs;
    };

    const buildTimeoutError = (): ClaudeUnifiedTerminalReadinessTimeoutError =>
      new ClaudeUnifiedTerminalReadinessTimeoutError({
        timeoutMs,
        handle: opts.handle,
        diagnostics: {
          elapsedMs: Math.max(0, effectiveNowMs() - startedAtMs),
          hostAlive: isHostAlive(),
          sessionStartObserved: hasHostAliveEvidence(),
          lastLivenessPaneAlive,
          lastScreenTail: sanitizeScreenTail(lastScreenText),
        },
      });

    const stopped = Symbol('claudeUnifiedTerminalReadinessAwaitStopped');
    const awaitReadinessOperation = async <T>(operation: Promise<T> | T): Promise<T | typeof stopped> => {
      let operationSettled = false;
      const operationPromise = Promise.resolve(operation);
      const watchdogAbortController = new AbortController();
      const abortWatchdog = (): void => {
        if (!watchdogAbortController.signal.aborted) watchdogAbortController.abort();
      };
      abortSignal.addEventListener('abort', abortWatchdog, { once: true });
      void operationPromise
        .finally(() => {
          operationSettled = true;
          abortWatchdog();
          abortSignal.removeEventListener('abort', abortWatchdog);
        })
        .catch(() => undefined);
      const watchdogPromise = (async (): Promise<typeof stopped> => {
        try {
          while (!operationSettled) {
            if (disposed || abortSignal.aborted || hasTrustedProviderProgress()) return stopped;
            if (isTimedOut()) throw buildTimeoutError();
            await delayUnrefAbortable(pollIntervalMs, watchdogAbortController.signal);
          }
          return stopped;
        } finally {
          abortSignal.removeEventListener('abort', abortWatchdog);
        }
      })();
      return Promise.race([operationPromise, watchdogPromise]);
    };

    const waitForNextPoll = async (): Promise<'continue' | 'stopped' | 'timeout'> => {
      if (disposed || abortSignal.aborted) return 'stopped';
      if (hasTrustedProviderProgress()) return 'stopped';
      if (isTimedOut()) return 'timeout';
      await delayUnrefAbortable(pollIntervalMs, abortSignal);
      if (disposed || abortSignal.aborted) return 'stopped';
      if (hasTrustedProviderProgress()) return 'stopped';
      return isTimedOut() ? 'timeout' : 'continue';
    };
    const continueAfterDelay = async (): Promise<boolean> => {
      const next = await waitForNextPoll();
      if (next === 'timeout') {
        if (hasTrustedProviderProgress()) return false;
        throw buildTimeoutError();
      }
      return next === 'continue';
    };
    while (!disposed && !abortSignal.aborted) {
      if (hasTrustedProviderProgress()) return;
      const observedAtMs = nowMs();
      let liveness;
      try {
        liveness = await awaitReadinessOperation(opts.hostAdapter.evaluateLiveness(opts.handle));
      } catch (error: unknown) {
        // An unavailable observation does not resolve an outstanding human choice.
        if (isClaudeUnifiedTerminalReadinessTimeoutError(error)) throw error;
        if (!(await continueAfterDelay())) return;
        continue;
      }
      if (liveness === stopped) return;
      if (disposed || abortSignal.aborted) return;
      lastLivenessPaneAlive = liveness.paneAlive;
      if (!liveness.paneAlive) {
        if (!liveness.probeInconclusive) endHumanDialogWait();
        if (!(await continueAfterDelay())) return;
        continue;
      }

      if (opts.hostAdapter.captureInputState) {
        let inputState;
        try {
          inputState = await awaitReadinessOperation(opts.hostAdapter.captureInputState(opts.handle));
        } catch (error: unknown) {
          // Keep a confirmed human wait until a readable screen or definitive host death.
          if (isClaudeUnifiedTerminalReadinessTimeoutError(error)) throw error;
          if (!(await continueAfterDelay())) return;
          continue;
        }
        if (inputState === stopped) return;
        if (disposed || abortSignal.aborted) return;
        opts.arbiter.observeUserTypingState({
          userTyping: !inputState.stable,
          observedAtMs: inputState.observedAt,
        });
        const screenState = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
        opts.onScreenObserved?.({ screenState });
        recordScreenProgress(screenState.text);
        // A refusal is the provider's final answer for these launch arguments, printed before any
        // session exists. Readiness can never arrive, so fail now with the classified cause rather
        // than waiting out the window and reporting a timeout the launcher would then retry.
        const refusal = classifyClaudeStartupRefusal({ text: screenState.text });
        if (refusal) {
          throw new ClaudeUnifiedTerminalProviderRefusedStartError({
            refusal,
            handle: opts.handle,
            diagnostics: { screenTail: sanitizeScreenTail(screenState.text) },
          });
        }
        if (opts.resolveStartupDialog) {
          const resolution = await awaitReadinessOperation(opts.resolveStartupDialog({
            screenState,
            observedAtMs: inputState.observedAt,
            abortSignal,
          }));
          if (resolution === stopped) return;
          if (disposed || abortSignal.aborted) return;
          if (resolution.status === 'waiting_for_user') {
            beginHumanDialogWait();
            if (!(await continueAfterDelay())) return;
            continue;
          }
          endHumanDialogWait();
          if (resolution.status === 'handled') {
            if (!(await continueAfterDelay())) return;
            continue;
          }
        } else {
          endHumanDialogWait();
        }
        if (isInputStateReady(inputState, screenState)) {
          if (canReportStartupReady()) {
            const readyResult = await awaitReadinessOperation(observeReady(inputState.observedAt));
            if (readyResult === stopped) return;
            return;
          }
          if (!(await continueAfterDelay())) return;
          continue;
        }
      } else {
        if (canReportStartupReady()) {
          const readyResult = await awaitReadinessOperation(observeReady(observedAtMs));
          if (readyResult === stopped) return;
          return;
        }
        if (!(await continueAfterDelay())) return;
        continue;
      }

      if (!(await continueAfterDelay())) return;
    }
  };

  return {
    start({ abortSignal }) {
      if (disposed || started) return;
      started = true;
      return pollUntilReady(abortSignal);
    },
    dispose() {
      disposed = true;
      clearQuietDrainTimer();
    },
  };
}
