import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';

import { previewDaemonServiceInstall } from './installer';
import type { DaemonServiceAutostartMode } from './plan';

/**
 * The install choke point owns the autostart decision for every caller —
 * `happier service install`, `happier daemon install`, doctor/background-service
 * repair. Repairing or reinstalling a service must not silently restore a login
 * trigger the user turned off, and selecting a mode explicitly must change an
 * already-installed service rather than being swallowed by the
 * already-converged early return.
 */

function writeInstalledDefaultUnit(params: Readonly<{
  unitPath: string;
  happierHomeDir: string;
  autostart: DaemonServiceAutostartMode | null;
}>): void {
  mkdirSync(dirname(params.unitPath), { recursive: true });
  writeFileSync(
    params.unitPath,
    renderSystemdServiceUnit({
      description: 'Happier CLI daemon (default)',
      execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync', '--takeover'],
      env: {
        HAPPIER_HOME_DIR: params.happierHomeDir,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        ...(params.autostart ? { HAPPIER_DAEMON_SERVICE_AUTOSTART: params.autostart } : {}),
      },
      wantedBy: 'default.target',
    }),
    'utf-8',
  );
}

async function previewDefaultInstall(params: Readonly<{
  homeDir: string;
  autostart?: DaemonServiceAutostartMode;
}>) {
  return await previewDaemonServiceInstall({
    platform: 'linux',
    mode: 'user',
    channel: 'stable',
    targetMode: 'default-following',
    autostart: params.autostart,
    instanceId: 'default',
    activeServerId: 'cloud',
    userHomeDir: params.homeDir,
    happierHomeDir: `${params.homeDir}/.happier`,
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    nodePath: '/usr/local/bin/happier',
    entryPath: '',
  });
}

function commandText(preview: Awaited<ReturnType<typeof previewDefaultInstall>>): string {
  return preview.plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n');
}

describe('daemon service install — autostart selection', () => {
  it('installs with a login trigger when nothing is installed and no mode is selected', async () => {
    await withTempDir('happier-autostart-fresh-', async (homeDir) => {
      const preview = await previewDefaultInstall({ homeDir });

      expect(preview.autostart).toBe('at-login');
      expect(commandText(preview)).toContain('systemctl --user enable happier-daemon.default.service');
    });
  });

  it('keeps the installed on-demand mode when the caller selects nothing (repair, drift refresh, reinstall)', async () => {
    await withTempDir('happier-autostart-inherit-', async (homeDir) => {
      writeInstalledDefaultUnit({
        unitPath: `${homeDir}/.config/systemd/user/happier-daemon.default.service`,
        happierHomeDir: `${homeDir}/.happier`,
        autostart: 'on-demand',
      });

      const preview = await previewDefaultInstall({ homeDir });

      expect(preview.autostart).toBe('on-demand');
      expect(commandText(preview)).toContain('systemctl --user disable happier-daemon.default.service');
      expect(commandText(preview)).not.toContain('systemctl --user enable happier-daemon.default.service');
    });
  });

  it('treats a definition with no declaration as at-login', async () => {
    await withTempDir('happier-autostart-legacy-', async (homeDir) => {
      writeInstalledDefaultUnit({
        unitPath: `${homeDir}/.config/systemd/user/happier-daemon.default.service`,
        happierHomeDir: `${homeDir}/.happier`,
        autostart: null,
      });

      const preview = await previewDefaultInstall({ homeDir });

      expect(preview.autostart).toBe('at-login');
    });
  });

  it('changes the mode of an already-installed service when one is selected explicitly', async () => {
    await withTempDir('happier-autostart-switch-', async (homeDir) => {
      const unitPath = `${homeDir}/.config/systemd/user/happier-daemon.default.service`;
      writeInstalledDefaultUnit({
        unitPath,
        happierHomeDir: `${homeDir}/.happier`,
        autostart: 'at-login',
      });

      const toOnDemand = await previewDefaultInstall({ homeDir, autostart: 'on-demand' });
      expect(toOnDemand.autostart).toBe('on-demand');
      expect(commandText(toOnDemand)).toContain('systemctl --user disable happier-daemon.default.service');
      // The switch has to reach the filesystem. The systemd login trigger is an
      // enable symlink, invisible to the definition comparator that decides
      // whether installDaemonService returns early — so the definition itself
      // carries the declaration, and it must differ from the installed one.
      expect(toOnDemand.plan.files[0]?.content ?? '')
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=on-demand');
      expect(readFileSync(unitPath, 'utf-8'))
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=at-login');

      writeInstalledDefaultUnit({ unitPath, happierHomeDir: `${homeDir}/.happier`, autostart: 'on-demand' });
      const backToLogin = await previewDefaultInstall({ homeDir, autostart: 'at-login' });
      expect(backToLogin.autostart).toBe('at-login');
      expect(commandText(backToLogin)).toContain('systemctl --user enable happier-daemon.default.service');
      expect(backToLogin.plan.files[0]?.content ?? '')
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=at-login');
    });
  });

  /**
   * Turning the login trigger on or off is a settings switch, not a lifecycle command. On linux
   * the trigger is an `enable`/`disable` symlink, so when the unit is otherwise exactly the one
   * this install would write there is nothing to apply to the running daemon — restarting it
   * would drop the user's daemon for a preference change.
   */
  it('changes only the linux login trigger, without restarting the running daemon, when the unit is otherwise unchanged', async () => {
    await withTempDir('happier-autostart-trigger-only-', async (homeDir) => {
      const unitPath = `${homeDir}/.config/systemd/user/happier-daemon.default.service`;
      const installed = await previewDefaultInstall({ homeDir, autostart: 'at-login' });
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, installed.plan.files[0]?.content ?? '', 'utf-8');

      const switched = await previewDefaultInstall({ homeDir, autostart: 'on-demand' });

      expect(switched.autostart).toBe('on-demand');
      expect(commandText(switched)).toContain('systemctl --user disable happier-daemon.default.service');
      expect(commandText(switched)).not.toContain('systemctl --user restart happier-daemon.default.service');
      // The new declaration still reaches the unit file, so the mode is reported back correctly.
      expect(switched.plan.files[0]?.content ?? '')
        .toContain('Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=on-demand');
    });
  });

  it('restarts a stale linux daemon even when the only definition change is the login trigger', async () => {
    await withTempDir('happier-autostart-trigger-stale-daemon-', async (homeDir) => {
      const unitPath = `${homeDir}/.config/systemd/user/happier-daemon.default.service`;
      const installed = await previewDefaultInstall({ homeDir, autostart: 'at-login' });
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, installed.plan.files[0]?.content ?? '', 'utf-8');

      const switched = await previewDaemonServiceInstall({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        targetMode: 'default-following',
        autostart: 'on-demand',
        restartRunningDaemon: true,
        instanceId: 'default',
        activeServerId: 'cloud',
        userHomeDir: homeDir,
        happierHomeDir: `${homeDir}/.happier`,
        serverUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        nodePath: '/usr/local/bin/happier',
        entryPath: '',
      });

      expect(commandText(switched)).toContain('systemctl --user restart happier-daemon.default.service');
    });
  });

  it('still restarts when the definition changed for any other reason', async () => {
    await withTempDir('happier-autostart-trigger-and-drift-', async (homeDir) => {
      const unitPath = `${homeDir}/.config/systemd/user/happier-daemon.default.service`;
      // A hand-rolled unit that is a valid Happier definition but not the one this install
      // would write: the definition itself drifted, so the new one has to be applied.
      writeInstalledDefaultUnit({
        unitPath,
        happierHomeDir: `${homeDir}/.happier`,
        autostart: 'at-login',
      });

      const switched = await previewDefaultInstall({ homeDir, autostart: 'on-demand' });

      expect(commandText(switched)).toContain('systemctl --user disable happier-daemon.default.service');
      expect(commandText(switched)).toContain('systemctl --user restart happier-daemon.default.service');
    });
  });
});
