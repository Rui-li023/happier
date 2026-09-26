import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadTapJob() {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  return YAML.parse(raw).jobs.publish_homebrew_tap;
}

test('the Homebrew tap job is a no-op until the tap is configured and runs only after verified stable promotion', async () => {
  const job = await loadTapJob();
  const condition = String(job.if);
  assert.match(condition, /inputs\.environment == 'production'/);
  assert.match(condition, /inputs\.dry_run != true/);
  assert.match(condition, /vars\.HOMEBREW_TAP_REPO_NAME != ''/);
  assert.match(condition, /needs\.release_verify\.result == 'success'/);
  assert.ok(job.needs.includes('release_verify'));
});

test('a resumed release whose CLI promotion already completed still publishes the formula, for the resumed version', async () => {
  const job = await loadTapJob();
  const condition = String(job.if);
  assert.ok(job.needs.includes('resolve_resume'), 'the job consumes the resume owner');
  assert.match(
    condition,
    /\(needs\.promote_cli_binaries\.result == 'success' \|\| needs\.resolve_resume\.outputs\.cli_rolling_complete == 'true'\)/,
    'CLI promotion in this run or a verified completed promotion in the resumed origin run',
  );
  const version = "needs.publish_cli_binaries.outputs.version || needs.resolve_resume.outputs.cli_version";
  assert.ok(condition.includes(`(${version}) != ''`), 'a published or resumed CLI version is required');
  for (const step of job.steps.filter((candidate) => candidate.env?.CLI_VERSION !== undefined)) {
    assert.equal(step.env.CLI_VERSION, `\${{ ${version} }}`, `${step.name} renders/commits the published or resumed version`);
  }
});
