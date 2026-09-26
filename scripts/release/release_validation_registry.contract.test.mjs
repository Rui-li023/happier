import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SOURCE_KINDS,
  RELEASE_VALIDATION_SUITE_IDS,
  resolveAutomaticReleaseValidationExecution,
  resolveReleaseValidationSourceKind,
  resolveReleaseValidationSuite,
  resolveReleaseValidationSuiteApplicability,
  resolveReleaseValidationSuiteTimeoutMinutes,
  resolveDesktopSetupCliSource,
} from '../pipeline/release-validation/registry.mjs';

test('release-validation registry exposes the canonical suite and source ids', () => {
  assert.deepEqual(RELEASE_VALIDATION_SUITE_IDS, [
    'installers-smoke',
    'binary-smoke',
    'artifact-verify',
    'docker-release-assets',
    'cli-update',
    'daemon-continuity',
    'session-continuity',
    'desktop-setup',
  ]);

  assert.deepEqual(RELEASE_VALIDATION_SOURCE_KINDS, [
    'published-channel',
    'published-tag',
    'local-build',
    'local-pack',
    'git-ref-build',
  ]);

  assert.equal(resolveReleaseValidationSourceKind(' local-build '), 'local-build');
  assert.equal(resolveReleaseValidationSourceKind('unknown'), null);
  assert.equal(resolveReleaseValidationSuite(' cli-update ')?.executorId, 'cli-update');
  assert.equal(resolveReleaseValidationSuite('unknown'), null);
});

test('release-validation registry is the single owner of candidate-aware automatic suite selection', () => {
  assert.deepEqual(resolveAutomaticReleaseValidationExecution('integrated', {
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), {
    selectedSuiteIds: ['artifact-verify', 'binary-smoke', 'cli-update'],
    skippedSuiteIds: ['session-continuity', 'docker-release-assets'],
    skipReasons: {
      'session-continuity': 'no server candidate',
      'docker-release-assets': 'no server candidate',
    },
  });

  assert.deepEqual(resolveAutomaticReleaseValidationExecution('stable', {
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), {
    selectedSuiteIds: ['binary-smoke', 'session-continuity', 'docker-release-assets'],
    skippedSuiteIds: ['artifact-verify', 'cli-update'],
    skipReasons: {
      'artifact-verify': 'no CLI candidate',
      'cli-update': 'no CLI candidate',
    },
  });

  assert.throws(() => resolveAutomaticReleaseValidationExecution('deep', {
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), /normal release profile/);
});

test('release-validation registry encodes supported cli-update source direction', () => {
  const cliUpdate = resolveReleaseValidationSuite('cli-update');

  assert.deepEqual(cliUpdate?.supportedUpdateSourcePairs, [
    { from: 'published-channel', to: 'published-channel' },
    { from: 'published-channel', to: 'published-tag' },
    { from: 'published-channel', to: 'local-build' },
    { from: 'published-channel', to: 'local-pack' },
    { from: 'published-tag', to: 'published-channel' },
    { from: 'published-tag', to: 'published-tag' },
    { from: 'published-tag', to: 'local-build' },
    { from: 'published-tag', to: 'local-pack' },
  ]);
});

test('normal release profiles only name executable canonical suites automatically', () => {
  for (const profile of RELEASE_VALIDATION_PROFILES) {
    for (const suiteId of profile.automaticSuiteIds) {
      assert.ok(
        resolveReleaseValidationSuite(suiteId)?.executorId,
        `${profile.id} automatic suite '${suiteId}' must resolve to an executable canonical suite`,
      );
    }
  }
});

test('desktop-setup gates the desktop build, not release verification, exactly when a production desktop and CLI candidate exist', () => {
  const suite = resolveReleaseValidationSuite('desktop-setup');
  assert.equal(suite?.executorId, 'desktop-setup');
  // It runs once per release, in build-tauri.yml before the desktop is published: no release
  // verification profile selects it, so it cannot also run there.
  for (const profile of RELEASE_VALIDATION_PROFILES) {
    assert.ok(!profile.automaticSuiteIds.includes('desktop-setup'), `${profile.id} must not also select desktop-setup`);
  }
  const gate = (overrides) => resolveReleaseValidationSuiteApplicability('desktop-setup', {
    hasDesktopCandidate: true,
    hasCliCandidate: true,
    candidateChannel: 'production',
    ...overrides,
  });
  assert.deepEqual(gate({}), { selected: true, skipReason: null });
  // A desktop-only release still gates: its hsetup installs the published channel CLI.
  assert.deepEqual(gate({ hasCliCandidate: false }), { selected: true, skipReason: null });
  assert.deepEqual(gate({ hasDesktopCandidate: false }), { selected: false, skipReason: 'no desktop candidate' });
  // Its upgrade scenario needs a pinned predecessor, which only a production candidate has.
  for (const candidateChannel of ['preview', 'dev', undefined]) {
    assert.equal(gate({ candidateChannel }).selected, false, `desktop-setup selected for ${candidateChannel}`);
    assert.match(String(gate({ candidateChannel }).skipReason), /no pinned (preview|dev|unknown) predecessor/);
  }
  assert.throws(() => resolveReleaseValidationSuiteApplicability('daemon-continuity', {}), /no applicability owner/);
});

test('desktop-setup tests the CLI users would get: the candidate, else the published channel CLI', () => {
  assert.deepEqual(
    resolveDesktopSetupCliSource({ candidateChannel: 'production', candidateCliVersion: '0.2.13' }),
    { kind: 'published-tag', ref: 'cli-v0.2.13' },
  );
  // No CLI in this release: the current cli-stable, which the suite pins once to its cli-v<version>.
  assert.deepEqual(
    resolveDesktopSetupCliSource({ candidateChannel: 'production', candidateCliVersion: '' }),
    { kind: 'published-channel', ref: 'stable' },
  );
  assert.throws(() => resolveDesktopSetupCliSource({ candidateChannel: 'production', candidateCliVersion: 'latest' }), /candidate CLI version/);
  assert.throws(() => resolveDesktopSetupCliSource({ candidateChannel: 'preview', candidateCliVersion: '' }), /production/);
});

test('a budgeted suite hard-stops at a timeout derived from its registry budget', () => {
  const suite = resolveReleaseValidationSuite('desktop-setup');
  assert.equal(suite?.timeBudgetMinutes, 10);
  // The executor warns past the budget; the job stops a hung run at twice it.
  assert.equal(resolveReleaseValidationSuiteTimeoutMinutes(suite), 20);
  assert.throws(() => resolveReleaseValidationSuiteTimeoutMinutes(resolveReleaseValidationSuite('cli-update')), /no timeBudgetMinutes/);
});
