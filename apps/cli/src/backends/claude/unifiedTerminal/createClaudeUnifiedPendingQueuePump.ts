import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { DrainPendingOptions, DrainPendingResult, MessageBatch } from '@/agent/runtime/sessionInput/types';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { logger } from '@/ui/logger';

import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputArbiterSnapshot,
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedPendingQueuePump,
} from './_types';

function shouldPausePumpForArbiterBackpressure(snapshot: ClaudeUnifiedInputArbiterSnapshot): boolean {
  if (snapshot.pendingInjectionCount > 0) return true;
  return snapshot.providerAcceptancePendingCount > 0;
}

export type ClaudeUnifiedPendingDeliveryState = Pick<
  SessionClientPort, 'waitForPendingEligibilityUpdate' | 'reconcilePendingQueueState'
>;

type PumpOnceResult =
  | Readonly<{ kind: 'delivered' }>
  | Readonly<{ kind: 'stopped' }>;

export function createClaudeUnifiedPendingQueuePump<Mode = unknown>(opts: Readonly<{
  inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  pendingDeliveryState?: ClaudeUnifiedPendingDeliveryState;
  arbiter: Pick<
    ClaudeUnifiedInputArbiter<Mode>,
    'enqueueUiMessage' | 'drainWhenSafe' | 'snapshot' | 'waitForPendingQueuePumpStateChange'
  >;
  /**
   * Called when a batch was already pulled from the input consumer but the pump
   * can no longer deliver it (aborted/disposed mid-wait, e.g. host-death
   * unwind). Lets the owner return the message to its queue instead of
   * permanently dropping it into a dead session.
   */
  onUndeliverableBatch?: (batch: MessageBatch<Mode, string>) => void;
  /**
   * A provider-acceptance pending batch already has a durable pending row claiming ownership, but
   * the terminal may still show the same text in the composer while awaiting provider proof.
   * Let the terminal owner register that exact text before the draft guard runs.
   */
  onProviderAcceptancePendingPrompt?: (batch: MessageBatch<Mode, string>) => void;
}>): ClaudeUnifiedPendingQueuePump<Mode> {
  let disposed = false;
  let runPromise: Promise<void> | null = null;
  let pausedWaitAbortController: AbortController | null = null;

  const pumpOnceDetailed = async (pumpOpts: { abortSignal: AbortSignal }): Promise<PumpOnceResult> => {
    if (disposed || pumpOpts.abortSignal.aborted) {
      return { kind: 'stopped' };
    }
    let batch: MessageBatch<Mode, string> | null = null;
    try {
      batch = await opts.inputConsumer.waitForNextInput({ abortSignal: pumpOpts.abortSignal });
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        throw error;
      }
      logger.debug('[unified]: pending queue pump input wait stopped (non-fatal)', error);
      return { kind: 'stopped' };
    }
    if (!batch) {
      return { kind: 'stopped' };
    }
    if (pumpOpts.abortSignal.aborted || disposed) {
      opts.onUndeliverableBatch?.(batch);
      return { kind: 'stopped' };
    }
    if (batch.providerAcceptancePending === true) {
      opts.onProviderAcceptancePendingPrompt?.(batch);
    }
    try {
      await opts.arbiter.enqueueUiMessage({
        message: batch.message,
        mode: batch.mode,
        origin: { kind: 'ui_pending' },
        maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch.userMessageLocalIds ?? [],
        ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
        ...(batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
      });
      await opts.arbiter.drainWhenSafe();
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        throw error;
      }
      // The arbiter is internal to this runner. A rejection here is not a
      // materialization/wait delivery outage; it is an unexpected pump crash
      // and remains fatal under controller supervision. Hand the consumed
      // batch back first so that fatality never loses durable input.
      logger.debug('[unified]: pending queue pump arbiter delivery failed', error);
      opts.onUndeliverableBatch?.(batch);
      throw error;
    }
    return { kind: 'delivered' };
  };

  const pumpOnce = async (pumpOpts: { abortSignal: AbortSignal }): Promise<boolean> => {
    return (await pumpOnceDetailed(pumpOpts)).kind === 'delivered';
  };

  const run = async (runOpts: { abortSignal: AbortSignal }): Promise<void> => {
    while (!disposed && !runOpts.abortSignal.aborted) {
      // Backpressure is local to the terminal arbiter: while a prompt is still waiting to be
      // injected or the head is waiting for provider acceptance, do not claim another durable
      // pending row from the server. Terminal-custody entries are kept in their own ledger and do
      // not create backpressure, but they never offset a newer head that still awaits acceptance.
      const arbiterSnapshot = opts.arbiter.snapshot();
      if (shouldPausePumpForArbiterBackpressure(arbiterSnapshot)) {
        const waitAbortController = new AbortController();
        pausedWaitAbortController = waitAbortController;
        const onAbort = (): void => waitAbortController.abort(runOpts.abortSignal.reason);
        runOpts.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (disposed || runOpts.abortSignal.aborted) {
          waitAbortController.abort(runOpts.abortSignal.reason);
        }
        let keepGoing: boolean;
        try {
          // Arm both owner signals before reconciling: an externally retired head can already
          // be stale when this pass begins, and no further provider output need ever arrive.
          const stateChanges = [opts.arbiter.waitForPendingQueuePumpStateChange({
            afterVersion: arbiterSnapshot.pendingQueuePumpStateVersion,
            abortSignal: waitAbortController.signal,
          })];
          if (opts.pendingDeliveryState) {
            stateChanges.push(opts.pendingDeliveryState.waitForPendingEligibilityUpdate(waitAbortController.signal));
          }
          const changed = Promise.race(stateChanges);
          if (opts.pendingDeliveryState) {
            await opts.pendingDeliveryState.reconcilePendingQueueState?.();
            await opts.arbiter.drainWhenSafe();
          }
          keepGoing = await changed;
        } finally {
          // Cancel the losing wait as well as the winning one; neither may outlive this pass.
          waitAbortController.abort('claude-unified-pending-queue-state-pass-complete');
          runOpts.abortSignal.removeEventListener('abort', onAbort);
          if (pausedWaitAbortController === waitAbortController) {
            pausedWaitAbortController = null;
          }
        }
        if (!keepGoing) return;
        continue;
      }
      const pumped = await pumpOnceDetailed(runOpts);
      if (pumped.kind === 'stopped') return;
    }
  };

  return {
    pumpOnce,
    async drainPending(drainOpts?: DrainPendingOptions): Promise<DrainPendingResult | null> {
      return await (opts.inputConsumer.drainPending?.(drainOpts) ?? Promise.resolve(null));
    },
    start(startOpts) {
      if (runPromise) return runPromise;
      if (disposed) return Promise.resolve();
      runPromise = run(startOpts).finally(() => {
        runPromise = null;
      });
      return runPromise;
    },
    dispose() {
      disposed = true;
      pausedWaitAbortController?.abort('claude-unified-pending-queue-pump-dispose');
    },
  };
}
