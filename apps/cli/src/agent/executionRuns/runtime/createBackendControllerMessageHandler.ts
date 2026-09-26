import { randomUUID } from 'node:crypto';

import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import type { AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { reconcileModelOutput, resetModelOutputSegment } from '@/agent/core/reconcileModelOutput';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { computeSidechainStreamText } from '@/agent/executionRuns/runtime/sidechainStreamText';

function isExecutionRunActivityMessage(msg: AgentMessage): boolean {
  switch (msg.type) {
    case 'model-output':
    case 'tool-call':
    case 'tool-result':
    case 'status':
    case 'fs-edit':
    case 'terminal-output':
    case 'exec-approval-request':
    case 'patch-apply-begin':
    case 'patch-apply-end':
    case 'permission-request':
    case 'session-media':
      return true;
    case 'event':
      return msg.name === 'thinking';
    default:
      return false;
  }
}

function isModelOutputSegmentBoundary(msg: AgentMessage): boolean {
  switch (msg.type) {
    case 'tool-call':
    case 'tool-result':
    case 'fs-edit':
    case 'terminal-output':
    case 'patch-apply-begin':
    case 'patch-apply-end':
      return true;
    case 'status':
      return msg.status === 'starting' || msg.status === 'running';
    default:
      return false;
  }
}

function applyModelOutput(ctrl: ExecutionRunBackendController, msg: Extract<AgentMessage, { type: 'model-output' }>): void {
  const state = {
    turnText: ctrl.buffer,
    segmentText: ctrl.modelOutputSegmentSnapshot ?? '',
  };
  reconcileModelOutput(state, msg);
  ctrl.buffer = state.turnText;
  ctrl.modelOutputSegmentSnapshot = state.segmentText;
}

export function createBackendControllerMessageHandler(args: Readonly<{
  ctrl: ExecutionRunBackendController;
  runId: string;
  sidechainId: string;
  intent: ExecutionRunState['intent'];
  ioMode: ExecutionRunState['ioMode'];
  sendAcp: AcpSendFn;
  parentProvider: ACPProvider;
  runs: Map<string, ExecutionRunState>;
  backendSupportsResume: boolean;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  isCurrentController: () => boolean;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
}>): AgentMessageHandler {
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: args.sendAcp,
    provider: args.parentProvider,
    sidechainId: args.sidechainId,
    makeId: () => randomUUID(),
  });

  return (msg) => {
    // Backends may deliver queued messages after stop/dispose. A retired controller must not
    // overwrite a successor's resume handle, transcript, buffers, or activity markers.
    if (!args.isCurrentController()) return;

    if (msg.type === 'event' && msg.name === 'vendor_session_id') {
      const payload = msg.payload;
      const vendorSessionId = payload
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && 'sessionId' in payload
        ? payload.sessionId
        : undefined;
      if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
        args.ctrl.childSessionId = vendorSessionId as SessionId;
        const run = args.runs.get(args.runId);
        if (run?.retentionPolicy === 'resumable' && args.backendSupportsResume) {
          args.runs.set(args.runId, {
            ...run,
            resumeHandle: { kind: 'vendor_session.v1', backendTarget: run.backendTarget, vendorSessionId },
          });
          args.onPublicStateUpdated?.(args.runId);
        }
      }
      return;
    }

    const shouldWriteActivityMarker = isExecutionRunActivityMessage(msg);

    if (isModelOutputSegmentBoundary(msg)) {
      const state = {
        turnText: args.ctrl.buffer,
        segmentText: args.ctrl.modelOutputSegmentSnapshot ?? '',
      };
      resetModelOutputSegment(state);
      args.ctrl.modelOutputSegmentSnapshot = state.segmentText;
    }

    if (
      args.ctrl.streamWriter
      && (
        msg.type === 'tool-call'
        || msg.type === 'tool-result'
        || msg.type === 'fs-edit'
        || msg.type === 'terminal-output'
      )
    ) {
      args.ctrl.streamWriter.flushAll({ reason: 'tool-call-boundary' });
    }

    forwarder.forward(msg);

    if (msg.type === 'model-output') {
      const prevFullText = args.ctrl.buffer;
      applyModelOutput(args.ctrl, msg);

      // Streaming: emit best-effort sidechain transcript updates.
      const streamWriter = args.ctrl.streamWriter;
      if (args.ioMode === 'streaming' && streamWriter) {
        const streamKey = `${args.sidechainId}:turn:${args.ctrl.turnCount}`;
        if (!args.ctrl.sidechainStreamKey || args.ctrl.sidechainStreamKey !== streamKey) {
          args.ctrl.sidechainStreamKey = streamKey;
          args.ctrl.sidechainStreamBuffer = '';
        }

        const nextStreamText = computeSidechainStreamText(args.intent, args.ctrl.buffer);
        if (typeof nextStreamText === 'string') {
          const prevStreamText = args.ctrl.sidechainStreamBuffer;

          const delta = (() => {
            if (nextStreamText.startsWith(prevStreamText)) {
              return nextStreamText.slice(prevStreamText.length);
            }

            // Fallback: if the backend reports cumulative fullText but it diverges (vendor bug/restarts),
            // emit the delta between previous and current fullText as best-effort.
            if (args.ctrl.buffer === prevFullText) return '';
            return nextStreamText;
          })();

          if (delta && delta.length > 0) {
            args.ctrl.sidechainStreamBuffer = nextStreamText;
            streamWriter.appendAssistantDelta(delta, { sidechainId: args.sidechainId });
          }
        }
      }

      args.onModelOutput?.();
    }

    // Best-effort: reflect activity for machine-wide run listing.
    if (shouldWriteActivityMarker) {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    }
  };
}
