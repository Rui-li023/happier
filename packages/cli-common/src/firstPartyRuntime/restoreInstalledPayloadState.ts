import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveDefaultManagedReleaseChannelStatePath } from './defaultReleaseChannelState.js';
import { resolveFirstPartyInstallLayout, type FirstPartyInstallLayout } from './installLayout.js';
import { resolveDefaultReleaseChannelAfterInstall } from './installVersionedPayload.js';
import { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';
import { syncInstalledPayloadPointer } from './syncInstalledPayloadPointer.js';
import { readInstalledVersionMarkers, writeInstalledVersionMarker } from './versionMarkers.js';

/**
 * Everything an activation may change, captured before it runs (plan R13 f): the `current` and
 * `previous` markers (which also name the pointer targets), the command shims the activation will
 * rewrite, and the default-channel record.
 *
 * The shims are moved aside rather than copied. Moving is what a Windows shim needs — the service
 * runs that `.exe` (a hard link or a copy of the payload binary), which cannot be deleted while it
 * runs but can be renamed — and on POSIX a moved symlink restores exactly as it was. The shim path is
 * empty only until the activation writes the new shim, just as it was while the old
 * remove-and-relink ran.
 */
export type InstalledPayloadStateSnapshot = Readonly<{
  layout: FirstPartyInstallLayout;
  /** This transaction's own set-aside directory; nothing else writes or removes it. */
  setAsideDir: string;
  currentVersionId: string | null;
  previousVersionId: string | null;
  shims: ReadonlyArray<Readonly<{ shimPath: string; setAsidePath: string | null }>>;
  defaultReleaseChannelStatePath: string;
  defaultReleaseChannelState: string | null;
}>;

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch(() => false);
}

/**
 * Where one transaction's moved-aside shims wait for commit or restore: its own directory under the
 * shim dir (off `PATH` itself), so no other transaction — another channel's, or a later one after a
 * crash — can touch its recovery launchers.
 */
function resolveShimSetAsideDir(layout: FirstPartyInstallLayout, transactionId: string): string {
  return joinPathForPathShape(layout.shimDir, '.update-rollback', transactionId);
}

/**
 * Capture before activating. The caller holds the home-wide activation lock. If moving any shim
 * aside fails, every shim already moved is put back before the error is rethrown, so a failed
 * capture leaves the launchers exactly as they were.
 */
export async function captureInstalledPayloadStateForActivation(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<InstalledPayloadStateSnapshot> {
  const layout = resolveFirstPartyInstallLayout(params);
  const { currentVersionId, previousVersionId } = await readInstalledVersionMarkers(layout);
  const defaultReleaseChannelStatePath = resolveDefaultManagedReleaseChannelStatePath({ processEnv: params.processEnv });
  const defaultReleaseChannelState = await readFile(defaultReleaseChannelStatePath, 'utf8').catch(() => null);

  // The same resolution the activation performs, so exactly the shims it rewrites are captured.
  const targets = await resolveDesiredShimTargets({
    componentId: params.componentId,
    channel: params.channel,
    processEnv: params.processEnv,
    defaultReleaseChannelOverride: await resolveDefaultReleaseChannelAfterInstall({
      componentId: params.componentId,
      releaseChannel: params.channel,
      selectAsDefault: false,
      processEnv: params.processEnv,
    }),
  });
  const setAsideDir = resolveShimSetAsideDir(layout, randomUUID());

  const shims: Array<Readonly<{ shimPath: string; setAsidePath: string | null }>> = [];
  try {
    for (const { shimPath } of targets) {
      if (!(await pathExists(shimPath))) {
        shims.push({ shimPath, setAsidePath: null });
        continue;
      }
      await mkdir(setAsideDir, { recursive: true });
      const setAsidePath = joinPathForPathShape(setAsideDir, basename(shimPath));
      await rename(shimPath, setAsidePath);
      shims.push({ shimPath, setAsidePath });
    }
  } catch (error) {
    const putBackFailures: unknown[] = [];
    for (const { shimPath, setAsidePath } of shims) {
      if (!setAsidePath) continue;
      await rename(setAsidePath, shimPath).catch((putBackError: unknown) => { putBackFailures.push(putBackError); });
    }
    if (putBackFailures.length === 0) {
      await rm(setAsideDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    throw new AggregateError([error, ...putBackFailures], `Could not set the Happier commands aside, nor put them all back; the rest are in ${setAsideDir}.`);
  }

  return { layout, setAsideDir, currentVersionId, previousVersionId, shims, defaultReleaseChannelStatePath, defaultReleaseChannelState };
}

async function restoreVersionPointer(layout: FirstPartyInstallLayout, pointerPath: string, versionId: string | null): Promise<void> {
  if (!versionId) {
    await rm(pointerPath, { recursive: true, force: true });
    return;
  }
  await syncInstalledPayloadPointer({
    layout,
    pointerPath,
    versionPath: joinPathForPathShape(layout.versionsDir, versionId),
  });
}

/**
 * Put back everything `captureInstalledPayloadStateForActivation` recorded. Every piece is
 * attempted even when an earlier one fails; the failures are thrown together at the end, so a
 * caller never reports a restore that did not complete.
 */
export async function restoreInstalledPayloadState(snapshot: InstalledPayloadStateSnapshot): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const { layout } = snapshot;

  await attempt(async () => await restoreVersionPointer(layout, layout.currentPath, snapshot.currentVersionId));
  await attempt(async () => await restoreVersionPointer(layout, layout.previousPath, snapshot.previousVersionId));
  await attempt(async () => await writeInstalledVersionMarker({ layout, marker: 'current', versionId: snapshot.currentVersionId }));
  await attempt(async () => await writeInstalledVersionMarker({ layout, marker: 'previous', versionId: snapshot.previousVersionId }));

  for (const { shimPath, setAsidePath } of snapshot.shims) {
    await attempt(async () => {
      if (await pathExists(shimPath)) {
        // The activated shim may be running (the new daemon); move it aside too instead of deleting.
        await mkdir(snapshot.setAsideDir, { recursive: true });
        await rename(shimPath, joinPathForPathShape(snapshot.setAsideDir, `${basename(shimPath)}.activated-${randomUUID()}`));
      }
      if (setAsidePath) {
        await mkdir(dirname(shimPath), { recursive: true });
        await rename(setAsidePath, shimPath);
      }
    });
  }

  await attempt(async () => {
    if (snapshot.defaultReleaseChannelState === null) {
      await rm(snapshot.defaultReleaseChannelStatePath, { force: true });
      return;
    }
    await writeFile(snapshot.defaultReleaseChannelStatePath, snapshot.defaultReleaseChannelState, 'utf8');
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, 'The previous Happier CLI install could not be completely restored.');
  }
}

/**
 * Commit, or after a completed restore: this transaction's set-aside launchers are no longer
 * needed. Best-effort — a Windows `.exe` still running stays until it exits; nothing else is
 * touched.
 */
export async function discardInstalledPayloadStateSnapshot(snapshot: InstalledPayloadStateSnapshot): Promise<void> {
  await rm(snapshot.setAsideDir, { recursive: true, force: true }).catch(() => undefined);
}
