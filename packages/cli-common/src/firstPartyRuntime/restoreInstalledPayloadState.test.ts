import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Real file system; one chosen `rename` of a launcher into the set-aside dir fails (EPERM). */
const failure = vi.hoisted(() => ({ failSetAsideRenameNumber: 0, setAsideRenames: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes('.update-rollback')) {
        failure.setAsideRenames += 1;
        if (failure.setAsideRenames === failure.failSetAsideRenameNumber) {
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
        }
      }
      return await actual.rename(...args);
    }),
  };
});

import { installVersionedPayload } from './installVersionedPayload.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { captureInstalledPayloadStateForActivation } from './restoreInstalledPayloadState.js';
import { writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';

describe('captureInstalledPayloadStateForActivation', () => {
  let homeDir = '';
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-capture-'));
    failure.setAsideRenames = 0;
    failure.failSetAsideRenameNumber = 0;
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('puts every launcher it already moved back when a later one cannot be moved', async () => {
    const env = { HAPPIER_HOME_DIR: homeDir };
    // Preview is the default channel: its update rewrites two launchers (`happier` and `hprev`).
    await writeDefaultManagedReleaseChannel({ processEnv: env, releaseChannel: 'preview' });
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier'), 'binary-1.0.0-preview.1', 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
    await installVersionedPayload({
      componentId: 'happier-cli', channel: 'preview', versionId: '1.0.0-preview.1', processEnv: env, payloadRoot,
      selectAsDefaultReleaseChannel: true,
    });
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: 'preview', processEnv: env });
    const launchers = (await readdir(layout.shimDir)).filter((name) => !name.startsWith('.')).sort();
    expect(launchers).toEqual(['happier', 'hprev']);

    failure.failSetAsideRenameNumber = 2;
    await expect(captureInstalledPayloadStateForActivation({ componentId: 'happier-cli', channel: 'preview', processEnv: env }))
      .rejects.toThrow('EPERM');

    expect((await readdir(layout.shimDir)).filter((name) => !name.startsWith('.')).sort()).toEqual(launchers);
    for (const launcher of launchers) {
      expect(await readFile(join(layout.shimDir, launcher), 'utf8')).toBe('binary-1.0.0-preview.1');
    }
  });
});
