import type { AgentMessage } from './AgentBackend';

export type ModelOutputReconciliationState = {
  turnText: string;
  segmentText: string;
};

export function resetModelOutputSegment(state: ModelOutputReconciliationState): void {
  state.segmentText = '';
}

/**
 * Reconcile a provider output message into one turn buffer and return the newly observed delta.
 * Segment-scoped fullText is authoritative only for the current assistant segment; turn-scoped
 * fullText replaces the complete turn when it diverges from the accumulated response.
 */
export function reconcileModelOutput(
  state: ModelOutputReconciliationState,
  msg: Extract<AgentMessage, { type: 'model-output' }>,
): string {
  let delta = typeof msg.textDelta === 'string' ? msg.textDelta : '';
  const fullText = typeof msg.fullText === 'string' ? msg.fullText : '';

  if (!delta && fullText) {
    const fullTextScope = msg.fullTextScope ?? 'turn';
    const reconciledText = fullTextScope === 'segment' ? state.segmentText : state.turnText;
    if (fullText.startsWith(reconciledText)) {
      delta = fullText.slice(reconciledText.length);
    } else {
      if (fullTextScope === 'turn') state.turnText = '';
      state.segmentText = '';
      delta = fullText;
    }
  }

  if (delta) {
    state.turnText += delta;
    state.segmentText += delta;
  }
  return delta;
}
