// @ts-check

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { assertDockerReleaseAssetsAvailable } from './docker-release-assets.mjs';

/**
 * @typedef {{ kind: string; ref: string }} ReleaseValidationSource
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown} ExecFileSyncLike
 */

const DESKTOP_SETUP_SCRIPT = ['scripts', 'release', 'release-assets-e2e', 'desktop-setup.mjs'];
const DEFAULT_LOCAL_CLI_ASSETS_DIR = ['dist', 'release-assets', 'cli'];

/**
 * The CLI under test for the desktop-setup suite. The shipped hsetup verifies what it acquires
 * against the minisign key embedded in its build, so the CLI assets must be signed by that key:
 * a published immutable `cli-v<version>` tag, or a local asset directory produced by a build
 * signed with it. A throwaway-key local build fails verification — by design, not a harness bug.
 * @param {{ repoRoot: string; source: ReleaseValidationSource | null }} params
 */
function resolveCliArgs({ repoRoot, source }) {
  if (!source) throw new Error('desktop-setup requires --source published-tag --ref cli-v<version>, --source published-channel --ref <channel> or --source local-build --ref <cli release assets dir>');
  if (source.kind === 'published-tag') {
    if (!/^cli-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(source.ref)) {
      throw new Error(`desktop-setup published-tag sources must be immutable cli-v<version> tags (got ${source.ref})`);
    }
    return ['--cli-tag', source.ref];
  }
  // A desktop-only release: the channel's published CLI, pinned once by the suite to its
  // immutable cli-v<version> (recorded in summary.json).
  if (source.kind === 'published-channel') return ['--cli-channel', source.ref];
  if (source.kind === 'local-build') {
    const dir = source.ref === '.' ? resolve(repoRoot, ...DEFAULT_LOCAL_CLI_ASSETS_DIR) : resolve(repoRoot, source.ref);
    return ['--cli-assets-dir', dir];
  }
  throw new Error(`desktop-setup supports --source published-tag, published-channel or local-build (got ${source.kind})`);
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: ReleaseValidationSource | null;
 *   options?: { desktopArtifact?: string; releaseChannel?: string };
 * }} params
 */
export function resolveDesktopSetupExecution({ repoRoot, platform, source, options = {} }) {
  if (platform !== 'linux') {
    throw new Error('desktop-setup runs the systemd machine in Docker: --platform linux only (macOS/Windows: see the suite README)');
  }
  const desktopArtifact = String(options.desktopArtifact ?? '').trim();
  if (!desktopArtifact) {
    throw new Error('desktop-setup requires --desktop-artifact <path to the Linux desktop .deb or .AppImage under test>');
  }
  return {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, ...DESKTOP_SETUP_SCRIPT),
      '--desktop-artifact',
      resolve(repoRoot, desktopArtifact),
      ...resolveCliArgs({ repoRoot, source }),
      ...(options.releaseChannel ? ['--channel', options.releaseChannel] : []),
    ],
    cwd: repoRoot,
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: ReleaseValidationSource | null;
 *   options?: { desktopArtifact?: string; releaseChannel?: string };
 *   timeBudgetMinutes: number | undefined;
 *   exec?: ExecFileSyncLike;
 *   assertDockerAvailable?: typeof assertDockerReleaseAssetsAvailable;
 *   now?: () => number;
 *   warn?: (message: string) => void;
 * }} params
 */
export function runDesktopSetupValidation({
  repoRoot,
  platform,
  source,
  options,
  timeBudgetMinutes,
  exec = execFileSync,
  assertDockerAvailable = assertDockerReleaseAssetsAvailable,
  now = Date.now,
  warn = (message) => console.warn(message),
}) {
  if (typeof timeBudgetMinutes !== 'number' || !(timeBudgetMinutes > 0)) {
    throw new Error('desktop-setup needs its timeBudgetMinutes from the release-validation registry');
  }
  const execution = resolveDesktopSetupExecution({ repoRoot, platform, source, options });
  assertDockerAvailable({ exec, suiteId: 'desktop-setup' });
  const startedAt = now();
  try {
    exec(execution.command, execution.args, { cwd: execution.cwd, stdio: 'inherit' });
  } finally {
    // The registry's budget is the suite's declared cost, reported on every run; the hard stop
    // stays with the job that runs it, so a slow image pull is visible instead of a new flake.
    const elapsedMinutes = (now() - startedAt) / 60_000;
    if (elapsedMinutes > timeBudgetMinutes) {
      warn(`::warning::desktop-setup took ${elapsedMinutes.toFixed(1)} min, over its ${timeBudgetMinutes}-minute release-validation budget`);
    }
  }
}
