// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { assertPackagedHsetupResolution, waitForAppIpcStatusRead, writeStubHappierCli } from './linux-appimage-ipc-probe.mjs';
import { observeTauriStartup } from './linux-appimage-smoke-process.mjs';
import { extractBundledHsetup } from './linux-desktop-hsetup.mjs';

function fail(message) { throw new Error(`[linux-appimage-smoke] ${message}`); }

async function main() {
  const { values } = parseArgs({ options: { appimage: { type: 'string' }, duration: { type: 'string', default: '8' } }, allowPositionals: false });
  const appImage = path.resolve(String(values.appimage ?? '').trim());
  if (!appImage || !fs.existsSync(appImage)) fail(`missing AppImage: ${appImage || '<empty>'}`);
  const durationMs = Math.max(3, Number(values.duration)) * 1000;
  const scratch = fs.mkdtempSync(path.join('/tmp', 'happier-appimage-smoke-'));
  const marker = path.join(scratch, 'ready.json');
  // A computer of its own: the app's warm-up runs hsetup against this HOME, never the runner's.
  const home = path.join(scratch, 'home');
  const recordDir = path.join(scratch, 'cli-invocations');
  const hashOf = (/** @type {string} */ file) => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
  const display = `:${100 + (process.pid % 800)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac'], { stdio: 'ignore' });
  let app;
  const cleanup = () => { if (app && app.exitCode === null) app.kill('SIGTERM'); if (xvfb.exitCode === null) xvfb.kill('SIGTERM'); };
  try {
    const stubCli = writeStubHappierCli({ dir: path.join(scratch, 'cli'), recordDir });
    const bundled = extractBundledHsetup({ artifactPath: appImage, outFile: path.join(scratch, 'bundled-hsetup') });
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) fail('Xvfb did not create an X11 socket');
    app = spawn(appImage, ['--appimage-extract-and-run'], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HAPPIER_') && !name.startsWith('XDG_'))),
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        DISPLAY: display, GDK_BACKEND: 'x11', LIBGL_ALWAYS_SOFTWARE: '1', APPIMAGE_EXTRACT_AND_RUN: '1', HAPPIER_TAURI_STARTUP_MARKER: marker,
        // The shipped explicit-CLI override (provenance `override`): the status read resolves this
        // stand-in instead of acquiring a CLI, so the app's own task stays read-only and offline.
        HAPPIER_BOOTSTRAP_CLI_PATH: stubCli,
      },
      stdio: 'inherit',
    });
    await observeTauriStartup({ app, marker, durationMs, exitDescription: 'AppImage exited during startup' });
    // The launched app's own system task, through its Rust IPC: the pre-auth warm-up runs
    // `daemon.service.status.v1` at app open, and the bundled hsetup it spawns runs the status read.
    // The webview mounts after the startup-ready event, so it gets the same startup window again.
    const { statusRead, hsetupExe } = await waitForAppIpcStatusRead({
      recordDir,
      appPid: /** @type {number} */ (app.pid),
      isBundledHsetup: (exe) => hashOf(exe) === bundled.hsetupSha256,
      timeoutMs: durationMs,
      appExited: () => (app.exitCode === null && app.signalCode === null ? null : `code=${app.exitCode} signal=${app.signalCode}`),
    });
    // Same bytes is not enough: the checkout's `binaries` could carry them too. The path proves the
    // app resolved its packaged resource.
    const resolution = assertPackagedHsetupResolution({
      hsetupExe,
      cacheHome: path.join(home, '.cache'),
      resource: bundled.resource,
      resourceBytes: bundled.resourceBytes,
    });
    console.log(`[linux-appimage-smoke] the app ran daemon.service.status.v1 through its IPC: bundled hsetup ${bundled.resource} (sha256 ${bundled.hsetupSha256}, ${resolution}) at ${hsetupExe} ran \`happier ${statusRead.argv.join(' ')}\` read-only`);
    console.log(`[linux-appimage-smoke] passed: remained alive for ${durationMs / 1000}s`);
  } finally { cleanup(); fs.rmSync(scratch, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
