import { describe, expect, it } from 'vitest';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AgentBackend, AgentMessage, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { createBackendControllerMessageHandler } from './createBackendControllerMessageHandler';

function createBackendStub(): AgentBackend {
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId: 'child_session_1' as SessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {},
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(_handler): void {},
    async dispose(): Promise<void> {},
  };
}

function createController(): ExecutionRunBackendController {
  return {
    kind: 'backend',
    backend: createBackendStub(),
    backendSupportsResume: false,
    childSessionId: null,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: null,
    cancelled: false,
    turnCount: 1,
    turnEpoch: 1,
    turnInFlight: true,
    turnCancelReason: null,
    turnCancelEpoch: null,
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalPromise: Promise.resolve(),
    resolveTerminal: () => {},
  };
}

function createHandlerHarness() {
  const writes: Array<Readonly<{ runId: string; nowMs: number; force?: boolean }>> = [];
  const sent: Array<Readonly<{
    body: ACPMessageData;
    options?: Readonly<{ localId?: string; meta?: Record<string, unknown> }>;
  }>> = [];
  let nowMs = 1_700_000_000_000;
  const ctrl = createController();
  const handler = createBackendControllerMessageHandler({
    ctrl,
    runId: 'run_1',
    sidechainId: 'sidechain_1',
    intent: 'delegate',
    ioMode: 'request_response',
    sendAcp: (_provider: ACPProvider, body: ACPMessageData, options) => {
      sent.push({ body, ...(options ? { options } : {}) });
    },
    parentProvider: 'codex',
    runs: new Map(),
    backendSupportsResume: false,
    writeActivityMarker: async (runId, markerNowMs, opts) => {
      writes.push({ runId, nowMs: markerNowMs, ...(opts?.force ? { force: true } : {}) });
    },
    getNowMs: () => nowMs,
    isCurrentController: () => true,
  });

  return {
    writes,
    sent,
    ctrl,
    send(message: AgentMessage, nextNowMs = nowMs + 1_000): void {
      nowMs = nextNowMs;
      handler(message);
    },
  };
}

describe('createBackendControllerMessageHandler', () => {
  it('refreshes activity markers for meaningful non-output messages', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'tool-call', toolName: 'read', args: { file: 'README.md' }, callId: 'tool_1' });
    harness.send({ type: 'tool-result', toolName: 'read', result: 'ok', callId: 'tool_1' });
    harness.send({ type: 'status', status: 'running' });
    harness.send({ type: 'event', name: 'thinking', payload: { text: 'checking' } });

    expect(harness.writes).toEqual([
      { runId: 'run_1', nowMs: 1_700_000_001_000 },
      { runId: 'run_1', nowMs: 1_700_000_002_000 },
      { runId: 'run_1', nowMs: 1_700_000_003_000 },
      { runId: 'run_1', nowMs: 1_700_000_004_000 },
    ]);
  });

  it('continues to refresh activity markers for model output', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'model-output', textDelta: 'hello' });

    expect(harness.writes).toEqual([{ runId: 'run_1', nowMs: 1_700_000_001_000 }]);
  });

  it('accumulates distinct segment snapshots without duplicating cumulative snapshots', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'model-output', fullText: 'hel', fullTextScope: 'segment' });
    harness.send({ type: 'model-output', fullText: 'hello', fullTextScope: 'segment' });
    harness.send({ type: 'tool-call', toolName: 'read', args: {}, callId: 'tool_1' });
    harness.send({ type: 'model-output', fullText: 'hello', fullTextScope: 'segment' });

    expect(harness.ctrl.buffer).toBe('hellohello');
  });

  it('retains an artifact segment when a later segment only acknowledges completion', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'model-output', fullText: 'artifact payload', fullTextScope: 'segment' });
    harness.send({ type: 'tool-result', toolName: 'write', result: 'ok', callId: 'tool_1' });
    harness.send({ type: 'model-output', fullText: 'Done', fullTextScope: 'segment' });

    expect(harness.ctrl.buffer).toBe('artifact payloadDone');
  });

  it('lets a turn-scoped snapshot replace the accumulated turn output', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'model-output', fullText: 'stale segment', fullTextScope: 'segment' });
    harness.send({ type: 'model-output', fullText: 'authoritative turn', fullTextScope: 'turn' });

    expect(harness.ctrl.buffer).toBe('authoritative turn');
  });

  it('does not treat vendor session id bookkeeping as run activity', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'event', name: 'vendor_session_id', payload: { sessionId: 'vendor_1' } });

    expect(harness.writes).toEqual([]);
  });

  it('preserves stable transcript identity options for sidechain tool revisions', () => {
    const harness = createHandlerHarness();

    harness.send({ type: 'tool-call', toolName: 'other', args: {}, callId: 'opaque\ncall' });
    harness.send({ type: 'tool-call', toolName: 'read', args: { file: 'README.md' }, callId: 'opaque\ncall' });

    expect(harness.sent).toHaveLength(2);
    const first = harness.sent[0];
    const second = harness.sent[1];
    expect(first?.body.type).toBe('tool-call');
    expect(second?.body.type).toBe('tool-call');
    if (first?.body.type !== 'tool-call' || second?.body.type !== 'tool-call') {
      throw new Error('Expected tool-call transcript messages');
    }
    expect(first.body.id).toBe(second.body.id);
    expect(first.options?.localId).toBe(first.body.id);
    expect(second.options?.localId).toBe(first.body.id);
  });
});
