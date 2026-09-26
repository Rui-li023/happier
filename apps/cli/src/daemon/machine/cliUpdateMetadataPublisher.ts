import type { CliUpdateFacts } from '@happier-dev/protocol';
import { watchLastCliUpdateResult } from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { MachineMetadata } from '@/api/types';

import { refreshMachineMetadataForCurrentDaemon } from './metadata';

export type CliUpdateMetadataPublisher = Readonly<{
  /** Refresh the daemon-owned metadata, K5 included. Every (re)connect calls it. */
  publish: () => Promise<void>;
  /** Republish whenever this ring's `last-update.json` changes. */
  watch: (params: Readonly<{ channel: PublicReleaseRingId; processEnv?: NodeJS.ProcessEnv }>) => void;
  stop: () => void;
}>;

/**
 * The daemon's one path for publishing its daemon-owned machine metadata (plan R13 K5): on every
 * (re)connect, and when an update attempt records its end — which is how a remote update that
 * failed without restarting this daemon (download, verification, smoke) becomes visible.
 *
 * The watch is on the install-root DIRECTORY, so the writer's atomic rename-replace of the file
 * never ends it. A watch event can still be missed on some platforms, or the watch can end with the
 * directory itself; the connect publish is the fallback that always carries the current record.
 *
 * Publishes are coalesced: while one is in flight, any number of further requests collapse into one
 * trailing publish that reads the facts then current — run even when the in-flight one failed — and
 * an event whose facts equal the last ones published publishes nothing (one write can raise several
 * events). A (re)connect request always publishes.
 */
export function createCliUpdateMetadataPublisher(params: Readonly<{
  updateMachineMetadata: (handler: (metadata: MachineMetadata | null) => MachineMetadata) => Promise<void>;
  fallbackMetadata: () => Partial<MachineMetadata>;
  preferredHost: string;
  readFacts: () => CliUpdateFacts;
  onError: (message: string, error: unknown) => void;
  /** The record watch (`watchLastCliUpdateResult` — a directory watch — unless replaced). */
  watchRecord?: typeof watchLastCliUpdateResult;
}>): CliUpdateMetadataPublisher {
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let lastPublishedFacts: string | null = null;
  let stopWatching: (() => void) | null = null;

  const publishOnce = async (onlyIfFactsChanged: boolean): Promise<void> => {
    const facts = params.readFacts();
    const serialized = JSON.stringify(facts);
    if (onlyIfFactsChanged && serialized === lastPublishedFacts) return;
    await params.updateMachineMetadata((metadata) => {
      const base = (metadata ?? params.fallbackMetadata()) as Partial<MachineMetadata>;
      return refreshMachineMetadataForCurrentDaemon(base, params.preferredHost, facts);
    });
    lastPublishedFacts = serialized;
  };

  let pendingForced = false;
  const publishCoalesced = (onlyIfFactsChanged: boolean): Promise<void> => {
    if (inFlight) {
      pending = true;
      pendingForced ||= !onlyIfFactsChanged;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let onlyIfChanged = onlyIfFactsChanged;
        for (;;) {
          pending = false;
          pendingForced = false;
          try {
            await publishOnce(onlyIfChanged);
          } catch (error) {
            // A request that arrived meanwhile still runs; only the last attempt's failure is returned.
            if (!pending) throw error;
            params.onError('[DAEMON RUN] Failed to publish machine metadata; retrying the queued publish', error);
          }
          if (!pending) return;
          onlyIfChanged = !pendingForced;
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    publish: async () => await publishCoalesced(false),
    watch: (watchParams) => {
      stopWatching?.();
      stopWatching = (params.watchRecord ?? watchLastCliUpdateResult)({
        channel: watchParams.channel,
        processEnv: watchParams.processEnv,
        onChange: () => {
          publishCoalesced(true).catch((error: unknown) => params.onError('[DAEMON RUN] Failed to republish CLI update facts', error));
        },
        onError: (error) => {
          stopWatching = null;
          params.onError('[DAEMON RUN] Stopped watching the CLI update record; the next connect republishes it', error);
        },
      });
    },
    stop: () => {
      stopWatching?.();
      stopWatching = null;
    },
  };
}
