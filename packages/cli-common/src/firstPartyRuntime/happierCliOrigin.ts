import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Where a `happier` this app did not install came from, with the exact command that removes it
 * and the one that updates it (plan R12). The app shows these commands and never runs them: the
 * CLI belongs to the package manager that installed it.
 *
 * Only what the files prove is named. npm is recognised by the package the command launches (its
 * own `package.json` name, never an assumed one); Homebrew by the `Cellar/<formula>/` directory the
 * command resolves into. Anything else is named by its path alone.
 */
export type HappierCliOrigin =
  | Readonly<{ kind: 'npm'; packageName: string; removalCommand: string; updateCommand: string }>
  | Readonly<{
    kind: 'brew';
    formula: string;
    removalCommand: string;
    updateCommand: string;
    /**
     * The same file through Homebrew's opt prefix (`<prefix>/opt/<formula>/…`, a link to the active
     * keg), which survives `brew upgrade`; `null` when the path is not inside a versioned keg.
     */
    optPath: string | null;
  }>
  | Readonly<{ kind: 'unknown'; removalCommand: null; updateCommand: null }>;

const UNKNOWN_ORIGIN: HappierCliOrigin = { kind: 'unknown', removalCommand: null, updateCommand: null };

/** npm and Homebrew names are plain tokens; anything else is not rendered into a command. */
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_FORMULA_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/u;

export function describeHappierCliOrigin(command: string): HappierCliOrigin {
  const realPath = realpathOrSelf(command);
  const packageName = readNpmPackageName(realPath) ?? readNpmPackageName(readWindowsCommandShimTarget(command));
  if (packageName) {
    return {
      kind: 'npm',
      packageName,
      removalCommand: `npm uninstall -g ${packageName}`,
      updateCommand: `npm install -g ${packageName}@latest`,
    };
  }
  const keg = readHomebrewKeg(realPath);
  if (keg) {
    const { formula, optPath } = keg;
    return { kind: 'brew', formula, removalCommand: `brew uninstall ${formula}`, updateCommand: `brew upgrade ${formula}`, optPath };
  }
  return UNKNOWN_ORIGIN;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The name in the nearest `package.json` above a path inside `node_modules`. */
function readNpmPackageName(path: string | null): string | null {
  if (!path) return null;
  const segments = path.split(/[\\/]/u);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0) return null;
  const scoped = segments[nodeModulesIndex + 1]?.startsWith('@') === true;
  const packageSegments = segments.slice(0, nodeModulesIndex + (scoped ? 3 : 2));
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(packageSegments.join(sep) || sep, 'package.json'), 'utf8'));
    const name = manifest && typeof manifest === 'object' ? (manifest as { name?: unknown }).name : null;
    return typeof name === 'string' && SAFE_PACKAGE_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * npm on Windows writes `happier.cmd` shims rather than links; the script names the package entry
 * it launches relative to its own directory (`"%dp0%\node_modules\<pkg>\bin\…"`).
 */
function readWindowsCommandShimTarget(command: string): string | null {
  if (!/\.(?:cmd|ps1)$/iu.test(command)) return null;
  try {
    const script = readFileSync(command, 'utf8');
    const target = /(?:%dp0%|\$basedir)[\\/](node_modules[\\/][^"'\s]+)/iu.exec(script)?.[1];
    return target ? join(dirname(command), ...target.split(/[\\/]/u)) : null;
  } catch {
    return null;
  }
}

/** `<prefix>/Cellar/<formula>/<version>/<rest>`: the formula, and `<prefix>/opt/<formula>/<rest>`. */
function readHomebrewKeg(path: string): Readonly<{ formula: string; optPath: string | null }> | null {
  const segments = path.split(/[\\/]/u);
  const cellarIndex = segments.lastIndexOf('Cellar');
  const formula = cellarIndex >= 0 ? segments[cellarIndex + 1] : undefined;
  if (!formula || !SAFE_FORMULA_NAME.test(formula)) return null;
  const rest = segments.slice(cellarIndex + 3);
  const optPath = segments[cellarIndex + 2] && rest.length > 0
    ? [...segments.slice(0, cellarIndex), 'opt', formula, ...rest].join(sep)
    : null;
  return { formula, optPath };
}
