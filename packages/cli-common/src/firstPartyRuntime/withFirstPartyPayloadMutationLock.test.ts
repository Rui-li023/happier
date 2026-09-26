import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The file system is real; only `rm` of the lock file itself is gated, to hold two reclaimers of
 * the same stale lock at the exact interleaving that used to let the second delete the first's
 * fresh lock.
 */
const gate = vi.hoisted(() => ({
  lockfilePath: '',
  /** The first removal proceeds once this settles. */
  firstMayProceed: null as Promise<void> | null,
  signalSecondArrived: () => {},
  /** The second removal proceeds once this settles. */
  secondMayProceed: null as Promise<void> | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  let lockRemovalCalls = 0;
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (gate.lockfilePath && String(args[0]) === gate.lockfilePath) {
        lockRemovalCalls += 1;
        const call = lockRemovalCalls;
        if (call === 1 && gate.firstMayProceed) await gate.firstMayProceed;
        if (call === 2) {
          gate.signalSecondArrived();
          if (gate.secondMayProceed) await gate.secondMayProceed;
        }
      }
      return await actual.rm(...args);
    }),
  };
});

import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';

const DEAD_PID = 2 ** 22 + 4321;

describe('withFirstPartyPayloadMutationLock', () => {
  let homeDir = '';
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-mutation-lock-'));
  });
  afterEach(async () => {
    gate.lockfilePath = '';
    gate.firstMayProceed = null;
    gate.secondMayProceed = null;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('lets exactly one of two concurrent reclaimers of a dead holder\'s lock mutate', async () => {
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: { HAPPIER_HOME_DIR: homeDir } });
    const lockfilePath = `${layout.installRoot}.mutation.lock`;
    await writeFile(lockfilePath, JSON.stringify({ pid: DEAD_PID, acquiredAt: 1 }));

    // Barriers, symmetric in the two contenders — whichever reaches the stale lock's removal first:
    // the first removal waits until the other contender also reached its removal or settled; a
    // second removal waits until a contender already mutates (or one settled). Each mutation holds
    // until both mutate (the defect) or a contender settled (the fix: the loser was refused).
    const deferred = () => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((settle) => { resolve = settle; });
      return { promise, resolve };
    };
    const secondArrived = deferred();
    const oneSettled = deferred();
    const oneMutating = deferred();
    const bothMutating = deferred();
    gate.lockfilePath = lockfilePath;
    gate.signalSecondArrived = secondArrived.resolve;
    gate.firstMayProceed = Promise.race([secondArrived.promise, oneSettled.promise]);
    gate.secondMayProceed = Promise.race([oneMutating.promise, oneSettled.promise]);

    let running = 0;
    let maxConcurrent = 0;
    let mutations = 0;
    const operation = async () => {
      running += 1;
      mutations += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      oneMutating.resolve();
      if (mutations === 2) bothMutating.resolve();
      await Promise.race([bothMutating.promise, oneSettled.promise]);
      running -= 1;
    };

    const a = withFirstPartyPayloadMutationLock({ layout, operation }).finally(() => oneSettled.resolve());
    const b = withFirstPartyPayloadMutationLock({ layout, operation }).finally(() => oneSettled.resolve());

    const results = await Promise.allSettled([a, b]);
    expect(maxConcurrent).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'FIRST_PARTY_PAYLOAD_MUTATION_IN_PROGRESS' },
    });
  });
});
