// @ts-check
// The hsetup a Linux desktop artifact ships: the `usr/lib/<product>/binaries/hsetup-*.gz` resource
// (`resolveLinuxHsetupResourcesOverrideConfig` in build-updater-artifacts.mjs), which the app
// decompresses before running it (`apps/ui/src-tauri/src/system_tasks/hsetup_path.rs`). Used by the
// desktop-setup release-validation suite, which runs these bytes, and by the AppImage smoke, which
// checks that the hsetup the launched app ran is these bytes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const HSETUP_RESOURCE_RE = /^hsetup-[A-Za-z0-9_.-]+\.gz$/u;
// Matches the AppImage audit's extraction bound in audit-linux-desktop-artifacts.mjs.
const APPIMAGE_EXTRACT_TIMEOUT_MS = 120_000;

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} root */
function findHsetupResource(root) {
  const libDir = join(root, 'usr', 'lib');
  const matches = existsSync(libDir)
    ? readdirSync(libDir).flatMap((product) => {
      const binaries = join(libDir, product, 'binaries');
      return existsSync(binaries)
        ? readdirSync(binaries).filter((name) => HSETUP_RESOURCE_RE.test(name)).map((name) => join(binaries, name))
        : [];
    })
    : [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one usr/lib/<product>/binaries/hsetup-*.gz in the artifact, found ${matches.length}`);
  }
  return /** @type {string} */ (matches[0]);
}

/**
 * Extract and decompress the bundled hsetup from a `.deb` or `.AppImage` into `outFile`.
 * @param {{ artifactPath: string; outFile: string; exec?: typeof execFileSync }} params
 */
export function extractBundledHsetup({ artifactPath, outFile, exec = execFileSync }) {
  const artifact = resolve(artifactPath);
  if (!existsSync(artifact)) throw new Error(`desktop artifact not found: ${artifact}`);
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  const scratch = mkdtempSync(join(dirname(resolve(outFile)), '.hsetup-extract-'));
  try {
    let root;
    if (artifact.endsWith('.deb')) {
      exec('dpkg-deb', ['-x', artifact, scratch], { stdio: ['ignore', 'ignore', 'inherit'] });
      root = scratch;
    } else if (artifact.endsWith('.AppImage')) {
      if ((statSync(artifact).mode & 0o111) === 0) chmodSync(artifact, statSync(artifact).mode | 0o755);
      exec(artifact, ['--appimage-extract', 'usr/lib/*/binaries/hsetup-*.gz'], {
        cwd: scratch,
        env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: APPIMAGE_EXTRACT_TIMEOUT_MS,
      });
      root = join(scratch, 'squashfs-root');
    } else {
      throw new Error(`unsupported desktop artifact (expected .deb or .AppImage): ${artifact}`);
    }
    const resource = findHsetupResource(root);
    const resourceGz = readFileSync(resource);
    const bytes = gunzipSync(resourceGz);
    writeFileSync(outFile, bytes, { mode: 0o755 });
    chmodSync(outFile, 0o755);
    return {
      artifact: basename(artifact),
      artifactSha256: sha256(readFileSync(artifact)),
      resource: resource.slice(root.length + 1),
      resourceBytes: resourceGz.length,
      hsetupSha256: sha256(bytes),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
