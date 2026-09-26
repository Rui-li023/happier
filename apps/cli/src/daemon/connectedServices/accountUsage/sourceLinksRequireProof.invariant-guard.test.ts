import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { recordProviderAccountUsageSnapshotForSession } from './record';

const mockNotifyDaemonConnectedServiceQuotaSnapshot = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceQuotaSnapshot: mockNotifyDaemonConnectedServiceQuotaSnapshot,
  notifyDaemonConnectedServiceRuntimeAuthFailure: vi.fn(async () => ({})),
}));

function createSnapshot(accountSubjectId = 'acct_live'): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [],
  };
}

function installSelectionEnv(serviceId: 'claude-subscription' | 'openai-codex'): string | undefined {
  const previous = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
    kind: 'group',
    serviceId,
    groupId: 'team',
    activeProfileId: 'active',
    fallbackProfileId: 'backup',
    generation: 7,
  }]);
  return previous;
}

function restoreSelectionEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    return;
  }
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previous;
}

describe('provider account usage source-link proof invariant guard', () => {
  afterEach(() => {
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockReset();
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
  });

  it('records usage but strips source links when source provider-account identity is unproven', async () => {
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'active',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    };
    const snapshot = createSnapshot('acct_live');
    let latestObservation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined;
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
        latestObservation = observation;
        return {
          status: 'snapshot_advanced' as const,
          recordId: recorded.recordId,
          snapshotAdvanced: true,
          sourceLinked: false,
        };
      }),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const recordInBandSnapshot = vi.fn(async () => ({ status: 'persisted' as const }));
    // Boundary fixture cast: 'persisted' is a valid ProviderAccountUsagePersistenceResult consumed
    // by record.ts at this seam, but the scheduler method's declared union is narrower.
    const persistence = { recordInBandSnapshot } as unknown as Parameters<
      typeof recordProviderAccountUsageSnapshotForSession
    >[0]['persistence'];

    await expect(recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_source_link_guard' }],
      store,
      persistence,
      sourceProviderAccountId: null,
      observation: { sources: [source] },
      sessionId: 'sess_source_link_guard',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });

    expect(latestObservation).toBeUndefined();
    expect(recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), expect.not.objectContaining({ sources: expect.anything() }));
  });

  it('threads proven Claude and Codex passive source identities into quota evidence delivery', async () => {
    const previousClaudeEnv = installSelectionEnv('claude-subscription');
    try {
      const { recordClaudeRateLimitQuotaEvidence } = await import('../../../backends/claude/connectedServices/surfaceClaudeRuntimeIssues');
      const claudeSession: Parameters<typeof recordClaudeRateLimitQuotaEvidence>[0] = {
        client: {
          sessionId: 'sess_claude_source_link_guard',
        },
      };
      await recordClaudeRateLimitQuotaEvidence(claudeSession, [{
        v: 1,
        resetAtMs: 1_779_097_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'seven_day',
        planType: null,
        utilization: 92,
        overage: null,
        action: null,
        connectedService: null,
        sourceProviderAccountId: 'acct_claude_proven',
      }], '[source-link-guard]');

      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_source_link_guard',
        serviceId: 'claude-subscription',
        sourceProviderAccountId: 'acct_claude_proven',
      }));
    } finally {
      restoreSelectionEnv(previousClaudeEnv);
    }

    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockClear();
    const previousCodexEnv = installSelectionEnv('openai-codex');
    try {
      const { reportCodexRateLimitSnapshotToDaemon } = await import('../../../backends/codex/connectedServices/reportCodexRateLimitSnapshotToDaemon');
      await reportCodexRateLimitSnapshotToDaemon({
        env: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
        },
        sessionId: 'sess_codex_source_link_guard',
        rawSnapshot: { primary: { used_percent: 88 } },
        appliedIdentity: {
          serviceId: 'openai-codex',
          profileId: 'active',
          groupId: 'team',
          groupGeneration: 7,
          activeAccountId: 'acct_codex_proven',
          accountLabel: null,
          credentialFingerprint: null,
          observedAtMs: 1_000,
          source: 'app_server_runtime',
        },
        activeAccountId: 'acct_codex_proven',
        sourceProviderAccountId: 'acct_codex_proven',
        nowMs: 1_000,
        notify: mockNotifyDaemonConnectedServiceQuotaSnapshot,
      });

      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_codex_source_link_guard',
        serviceId: 'openai-codex',
        sourceProviderAccountId: 'acct_codex_proven',
      }));
    } finally {
      restoreSelectionEnv(previousCodexEnv);
    }
  });
});
