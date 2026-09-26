import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';
import { buildSpawnChildProcessEnv, DAEMON_DECIDED_CHILD_ENV_KEYS } from '../../spawn/buildSpawnChildProcessEnv';
import type { HappierRuntimeServerContext } from '@/utils/env/resolveHappierRuntimeContextEnv';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../linux/buildCgroupSelfMigratingHappyCliLaunchSpec';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const essentialKeys = [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TSX_TSCONFIG_PATH',
    'USER',
    'LOGNAME',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ] as const;

  const filteredDaemonEnv = Object.fromEntries(
    essentialKeys
      .map((key) => [key, daemonEnv[key]] as const)
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export async function buildTmuxSpawnConfig(params: {
  agent: TmuxSpawnAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
  launchOptions?: HappyCliSubprocessLaunchOptions;
  processEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  serverSelectionEnv?: HappierRuntimeServerContext;
}): Promise<{
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
}> {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, params.launchOptions);
  const processEnv = params.processEnv ?? process.env;
  const extraEnv = { ...params.extraEnv, ...(launchSpec.env ?? {}) };
  // tmux's server environment may be stale; empty values explicitly mask inherited keys.
  const childEnv = buildSpawnChildProcessEnv({
    processEnv,
    extraEnv,
    homeDir: params.homeDir,
    serverSelectionEnv: params.serverSelectionEnv,
  });
  const daemonDecidedEnv = Object.fromEntries(
    DAEMON_DECIDED_CHILD_ENV_KEYS.map((key) => [key, childEnv[key] ?? '']),
  );
  const tmuxEnv = buildTmuxWindowEnv(processEnv, { ...extraEnv, ...daemonDecidedEnv });
  const scopedLaunchSpec = process.platform === 'linux'
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({ launchSpec, environment: tmuxEnv })
    : null;
  const effectiveLaunchSpec = scopedLaunchSpec ?? launchSpec;
  const commandTokens = [effectiveLaunchSpec.filePath, ...effectiveLaunchSpec.args];

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv: { ...tmuxEnv, ...(effectiveLaunchSpec.env ?? {}) },
    tmuxCommandEnv,
    directory: params.directory,
  };
}
