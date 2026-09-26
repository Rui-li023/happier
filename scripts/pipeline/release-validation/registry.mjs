// @ts-check

/**
 * @typedef {{
 *   id: string;
 *   supportsDirectSource: boolean;
 *   supportsUpdateSources: boolean;
 *   supportedDirectSourceKinds?: readonly string[];
 *   supportedUpdateSourceKinds?: readonly string[];
 *   supportedUpdateSourcePairs?: readonly { from: string; to: string }[];
 *   executorId?: string | null;
 *   timeBudgetMinutes?: number;
 * }} ReleaseValidationSuiteDefinition
 */

/**
 * @typedef {{
 *   id: 'integrated' | 'stable' | 'deep';
 *   normalRelease: boolean;
 *   checksProfile: 'fast' | 'full' | null;
 *   automaticSuiteIds: readonly string[];
 *   manualEntrypoint?: string;
 * }} ReleaseValidationProfileDefinition
 */

const INTEGRATED_AUTOMATIC_SUITE_IDS = Object.freeze([
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
  'cli-update',
  'docker-release-assets',
]);

const STABLE_AUTOMATIC_SUITE_IDS = Object.freeze([
  ...INTEGRATED_AUTOMATIC_SUITE_IDS,
]);

/** @type {readonly ReleaseValidationProfileDefinition[]} */
export const RELEASE_VALIDATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'integrated',
    normalRelease: true,
    checksProfile: 'fast',
    automaticSuiteIds: INTEGRATED_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'stable',
    normalRelease: true,
    checksProfile: 'full',
    automaticSuiteIds: STABLE_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'deep',
    normalRelease: false,
    checksProfile: null,
    automaticSuiteIds: Object.freeze([]),
    manualEntrypoint: '.agents/skills/happier-release-validation/SKILL.md',
  }),
]);

/** @type {readonly ReleaseValidationSuiteDefinition[]} */
export const RELEASE_VALIDATION_SUITES = [
  {
    id: 'installers-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    executorId: 'installers-smoke',
  },
  {
    id: 'binary-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'binary-smoke',
  },
  {
    id: 'artifact-verify',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'artifact-verify',
  },
  {
    id: 'docker-release-assets',
    supportsDirectSource: true,
    supportsUpdateSources: true,
    supportedDirectSourceKinds: ['local-build', 'published-channel'],
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'published-tag' },
    ],
    executorId: 'docker-release-assets',
  },
  {
    id: 'cli-update',
    supportsDirectSource: false,
    supportsUpdateSources: true,
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build', 'local-pack'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'published-channel' },
      { from: 'published-channel', to: 'published-tag' },
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'local-pack' },
      { from: 'published-tag', to: 'published-channel' },
      { from: 'published-tag', to: 'published-tag' },
      { from: 'published-tag', to: 'local-build' },
      { from: 'published-tag', to: 'local-pack' },
    ],
    executorId: 'cli-update',
  },
  {
    id: 'daemon-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'daemon-continuity',
  },
  {
    id: 'session-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'session-continuity',
  },
  {
    // A downloaded desktop app setting up a fresh systemd machine, and upgrading one an earlier
    // app version set up (scripts/release/release-assets-e2e/desktop-setup.mjs). It gates the
    // desktop build instead of release verification: build-tauri.yml `desktop_setup` runs it on
    // the just-finalized Linux bundle, before the production desktop is published, when
    // resolveReleaseValidationSuiteApplicability selects it. No verification profile lists it, so
    // a release runs it exactly once.
    id: 'desktop-setup',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-tag', 'published-channel', 'local-build'],
    executorId: 'desktop-setup',
    timeBudgetMinutes: 10,
  },
];

export const RELEASE_VALIDATION_SUITE_IDS = RELEASE_VALIDATION_SUITES.map((suite) => suite.id);
export const RELEASE_VALIDATION_PROFILE_IDS = RELEASE_VALIDATION_PROFILES.map((profile) => profile.id);

/**
 * @param {string} raw
 * @returns {ReleaseValidationSuiteDefinition | null}
 */
export function resolveReleaseValidationSuite(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SUITES.find((suite) => suite.id === id) ?? null;
}

/**
 * @param {string} raw
 * @returns {ReleaseValidationProfileDefinition | null}
 */
export function resolveReleaseValidationProfile(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * @typedef {{
 *   hasCliCandidate?: boolean;
 *   hasServerCandidate?: boolean;
 *   hasDesktopCandidate?: boolean;
 *   candidateChannel?: string;
 *   hasPublishedRelayPredecessor?: boolean;
 *   risks?: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 * }} ReleaseValidationCandidateContext
 */

/** The first unmet precondition, or `null` when the suite can execute. @param {Array<[boolean, string]>} conditions */
const firstUnmet = (conditions) => conditions.find(([met]) => !met)?.[1] ?? null;

/**
 * The only candidate-applicability owner: for each automatically selectable suite, its ordered
 * preconditions. A suite is selected only where it can execute; otherwise the first unmet reason
 * is reported, so a plan never reports an unexecutable selection (one that could only end
 * BLOCKED) as coverage.
 * @type {Record<string, (context: ReleaseValidationCandidateContext) => string | null>}
 */
const SUITE_APPLICABILITY = {
  'artifact-verify': (context) => firstUnmet([[context.hasCliCandidate === true, 'no CLI candidate']]),
  'binary-smoke': (context) => firstUnmet([[context.hasCliCandidate === true || context.hasServerCandidate === true, 'no CLI or server candidate']]),
  'session-continuity': (context) => firstUnmet([
    [context.hasServerCandidate === true, 'no server candidate'],
    [context.risks?.sessionContinuity === true, 'no session-continuity risk'],
  ]),
  'cli-update': (context) => firstUnmet([
    [context.hasCliCandidate === true, 'no CLI candidate'],
    [context.risks?.cliUpgrade === true, 'no CLI-upgrade risk'],
  ]),
  'docker-release-assets': (context) => firstUnmet([
    [context.hasServerCandidate === true, 'no server candidate'],
    [context.hasPublishedRelayPredecessor === true, 'no published relay predecessor'],
    [context.risks?.relayUpgrade === true, 'no relay-upgrade risk'],
  ]),
  // Its upgrade scenario needs a pinned predecessor, which exists only for a stable (production)
  // candidate (desktop-setup.mjs resolves ui-desktop-stable/cli-stable); elsewhere it could only
  // BLOCK. A CLI candidate is not required: resolveDesktopSetupCliSource picks the CLI.
  'desktop-setup': (context) => {
    const candidateChannel = String(context.candidateChannel ?? '').trim() || 'unknown';
    return firstUnmet([
      [context.hasDesktopCandidate === true, 'no desktop candidate'],
      [candidateChannel === 'production', `no pinned ${candidateChannel} predecessor for the upgrade scenario`],
    ]);
  },
};

/**
 * Whether one suite can execute for one exact candidate, and if not, why.
 * @param {string} suiteId
 * @param {ReleaseValidationCandidateContext} context
 * @returns {{ selected: boolean; skipReason: string | null }}
 */
export function resolveReleaseValidationSuiteApplicability(suiteId, context) {
  const rule = Object.hasOwn(SUITE_APPLICABILITY, suiteId) ? SUITE_APPLICABILITY[suiteId] : null;
  if (!rule) throw new Error(`Release validation suite ${suiteId} has no applicability owner`);
  const skipReason = rule(context);
  return { selected: skipReason === null, skipReason };
}

/**
 * The CLI a desktop-setup run installs: the one users of this desktop would get. The shipped
 * hsetup acquires only a CLI signed with the release key, so it is the release's candidate CLI
 * (its immutable tag) when the release has one, otherwise the channel's published CLI, which the
 * suite pins once to its immutable `cli-v<version>` (desktop-only release).
 * @param {{ candidateChannel: string; candidateCliVersion: string }} params
 * @returns {{ kind: 'published-tag' | 'published-channel'; ref: string }}
 */
export function resolveDesktopSetupCliSource({ candidateChannel, candidateCliVersion }) {
  if (String(candidateChannel ?? '').trim() !== 'production') {
    throw new Error(`desktop-setup runs only for a production candidate (got ${candidateChannel || 'unknown'})`);
  }
  const version = String(candidateCliVersion ?? '').trim();
  if (!version) return { kind: 'published-channel', ref: 'stable' };
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`Invalid candidate CLI version: ${version}`);
  return { kind: 'published-tag', ref: `cli-v${version}` };
}

/**
 * The hard stop for a budgeted suite. Its executor warns once a run exceeds the registry budget;
 * the job running it stops a hung run at twice that budget.
 * @param {ReleaseValidationSuiteDefinition | null} suite
 */
export function resolveReleaseValidationSuiteTimeoutMinutes(suite) {
  const budget = suite?.timeBudgetMinutes;
  if (typeof budget !== 'number' || !(budget > 0)) throw new Error(`Release validation suite ${suite?.id} has no timeBudgetMinutes`);
  return budget * 2;
}

/**
 * Resolve the automatic suites a normal release profile reaches for one exact candidate. Profiles
 * own eligibility; SUITE_APPLICABILITY owns candidate applicability.
 * @param {string} profileId
 * @param {ReleaseValidationCandidateContext} context
 */
export function resolveAutomaticReleaseValidationExecution(profileId, context) {
  const profile = RELEASE_VALIDATION_PROFILES.find((candidate) => candidate.id === String(profileId ?? '').trim());
  if (!profile?.normalRelease) throw new Error(`Automatic execution requires a normal release profile: ${profileId}`);
  const selectedSuiteIds = [];
  const skippedSuiteIds = [];
  /** @type {Record<string, string>} */
  const skipReasons = {};
  for (const suiteId of profile.automaticSuiteIds) {
    const { skipReason } = resolveReleaseValidationSuiteApplicability(suiteId, context);
    if (skipReason === null) {
      selectedSuiteIds.push(suiteId);
    } else {
      skippedSuiteIds.push(suiteId);
      skipReasons[suiteId] = skipReason;
    }
  }
  return { selectedSuiteIds, skippedSuiteIds, skipReasons };
}

export const RELEASE_VALIDATION_SOURCE_KINDS = [
  'published-channel',
  'published-tag',
  'local-build',
  'local-pack',
  'git-ref-build',
];

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function resolveReleaseValidationSourceKind(raw) {
  const value = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SOURCE_KINDS.includes(value) ? value : null;
}
