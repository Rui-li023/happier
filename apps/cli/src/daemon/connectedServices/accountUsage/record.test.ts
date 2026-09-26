import {
  buildProviderAccountUsageRecordId,
  readProviderAccountUsageRecordIdsFromMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type RecordModule = Readonly<{
  createProviderAccountUsageRecordIdMetadataPublisher(input: Readonly<{
    now: () => number;
    updateMetadata: (
      sessionId: string,
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
    ) => Promise<void>;
  }>): (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
  recordProviderAccountUsageSnapshotForSession(input: Readonly<{
    getChildren: () => readonly unknown[];
    store: Readonly<{
      recordSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        observation?: Readonly<{
          sources?: readonly ConnectedServiceUsageSourceV1[];
        }>,
      ): Readonly<{ status: 'snapshot_advanced'; recordId: string }>;
      resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    }>;
    persistence: Readonly<{
      recordInBandSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        options?: Readonly<{
          source?: ConnectedServiceUsageSourceV1;
          sources?: readonly ConnectedServiceUsageSourceV1[];
          onPersisted?: () => void;
        }>,
      ): Promise<unknown>;
    }> | null;
    publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
    observation?: Readonly<{
      sources?: readonly ConnectedServiceUsageSourceV1[];
    }>;
    sourceProviderAccountId?: string | null;
    credentialFingerprint?: string | null;
    verifyCredentialFingerprint?: (input: Readonly<{
      serviceId: string;
      profileId: string;
      providerAccountId: string;
      credentialFingerprint: string;
    }>) => Promise<boolean>;
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
  }>): Promise<
    | Readonly<{ status: 'snapshot_advanced'; recordId: string; persisted: boolean }>
    | Readonly<{ status: 'session_not_found' }>
    | Readonly<{ status: 'credential_fingerprint_mismatch'; recordId: string; persisted: false }>
  >;
}>;

async function loadRecordModule(): Promise<RecordModule | null> {
  return await import('./record').catch(() => null) as RecordModule | null;
}

function createRecordKey(accountSubjectId = 'acct_123'): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'account',
    quotaScope: 'account',
  };
}

function createSnapshot(recordKey = createRecordKey()): ProviderAccountUsageSnapshotV1 {
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: {
      kind: recordKey.accountSubjectId.startsWith('provisional:')
        ? 'provisionalLocalSubject'
        : 'providerSubject',
      id: recordKey.accountSubjectId,
    },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [],
  };
}

function createConnectedServiceGroupSnapshot(
  recordKey = createRecordKey('acct_live_exhausted'),
): ProviderAccountUsageSnapshotV1 {
  return {
    ...createSnapshot(recordKey),
    meters: [{
      meterId: 'primary',
      label: 'Primary requests',
      used: 100,
      limit: 100,
      remaining: 0,
      remainingPct: 0,
      usedPct: 100,
      resetAtMs: 1_779_019_200_000,
      unit: 'requests',
      utilizationPct: 100,
      resetsAt: 1_779_019_200_000,
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: {},
    }],
  };
}

describe('recordProviderAccountUsageSnapshotForSession', () => {
  it('records latest state, forwards explicit source context, queues persistence, and waits for confirmed persistence before metadata refs', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    let latestSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
    let latestObservation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined;
    let metadata: Record<string, unknown> = {};
    const store = {
      recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
        latestSnapshot = snapshot;
        latestObservation = observation;
        return { status: 'snapshot_advanced' as const, recordId: snapshot.recordId };
      }),
      resolveRecordId: vi.fn(() => latestSnapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const })),
    };
    const publishRecordId = module!.createProviderAccountUsageRecordIdMetadataPublisher({
      now: () => 7_000,
      updateMetadata: async (sessionId, updater) => {
        expect(sessionId).toBe('sess_1');
        metadata = updater(metadata);
      },
    });
    const snapshot = createSnapshot();
    const source = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    } as const;

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      publishRecordId,
      sourceProviderAccountId: 'acct_123',
      observation: { sources: [source] },
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: false,
    });

    expect(store.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      providerId: 'codex',
    }), expect.any(Object));
    expect(latestObservation).toEqual({ sources: [source] });
    expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      providerId: 'codex',
    }), expect.objectContaining({ sources: [source] }));
    expect(readProviderAccountUsageRecordIdsFromMetadata(metadata)).toEqual([]);
  });

  it('publishes the metadata ref once a queued persistence write is confirmed', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const queuedWrite: { confirm?: () => void } = {};
    const persistence = {
      recordInBandSnapshot: vi.fn(async (
        _snapshot: ProviderAccountUsageSnapshotV1,
        options?: Readonly<{ onPersisted?: () => void }>,
      ) => {
        queuedWrite.confirm = options?.onPersisted;
        return { status: 'enqueued' as const, enqueue: 'accepted' as const };
      }),
    };
    const publishRecordId = vi.fn(async () => {});

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store: {
        recordSnapshot: () => ({ status: 'snapshot_advanced' as const, recordId: snapshot.recordId }),
        resolveRecordId: () => snapshot,
      },
      persistence,
      publishRecordId,
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: false,
    });
    expect(publishRecordId).not.toHaveBeenCalled();

    queuedWrite.confirm?.();
    await vi.waitFor(() => expect(publishRecordId).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      recordId: snapshot.recordId,
    }));
  });

  it('persists all observed connected-service sources for a session usage snapshot', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createConnectedServiceGroupSnapshot();
    const profileSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const groupSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      sourceProviderAccountId: 'acct_live_exhausted',
      sessionId: 'sess_1',
      snapshot,
      observation: { sources: [profileSource, groupSource] },
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });

    expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), expect.objectContaining({ sources: [profileSource, groupSource] }));
  });

  it('does not mutate store, persist, or publish when the runtime session is unknown', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const store = {
      recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: snapshot.recordId,
      })),
      resolveRecordId: vi.fn(() => null),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };
    const publishRecordId = vi.fn(async () => {});

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'other_session' }],
      store,
      persistence,
      publishRecordId,
      sessionId: 'sess_1',
      snapshot: createSnapshot(),
    })).resolves.toEqual({ status: 'session_not_found' });

    expect(store.recordSnapshot).not.toHaveBeenCalled();
    expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    expect(publishRecordId).not.toHaveBeenCalled();
  });

  it('rejects failed persistence custody and retries an identical in-memory record', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const store = {
      recordSnapshot: vi.fn()
        .mockImplementationOnce((recorded: ProviderAccountUsageSnapshotV1) => ({
          status: 'snapshot_advanced' as const,
          recordId: recorded.recordId,
        }))
        .mockImplementation((recorded: ProviderAccountUsageSnapshotV1) => ({
          status: 'duplicate' as const,
          recordId: recorded.recordId,
        })),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error('store unavailable'))
        .mockResolvedValue({ status: 'enqueued' as const, enqueue: 'accepted' as const }),
    };
    const publishRecordId = vi.fn(async () => {});

    const input = {
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      publishRecordId,
      sessionId: 'sess_1',
      snapshot,
    } as const;
    await expect(module!.recordProviderAccountUsageSnapshotForSession(input))
      .rejects.toThrow('store unavailable');
    await expect(module!.recordProviderAccountUsageSnapshotForSession(input)).resolves.toEqual({
      status: 'duplicate',
      recordId: snapshot.recordId,
      persisted: false,
    });

    expect(store.recordSnapshot).toHaveBeenCalledTimes(2);
    expect(persistence.recordInBandSnapshot).toHaveBeenCalledTimes(2);
    expect(publishRecordId).not.toHaveBeenCalled();
  });

  it('treats scheduler-confirmed already-persisted truth as durable and publishes its metadata ref', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'already_persisted' as const, reason: 'unchanged' })),
    };
    const publishRecordId = vi.fn(async () => {});

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      publishRecordId,
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });

    expect(store.recordSnapshot).toHaveBeenCalledOnce();
    expect(persistence.recordInBandSnapshot).toHaveBeenCalledOnce();
    expect(publishRecordId).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      recordId: snapshot.recordId,
    });
  });

  it('does not advance account usage when an exact source claim mismatches the provider account', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot(createRecordKey('acct_observed_runtime'));
    let latestObservation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined;
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
        latestObservation = observation;
        return { status: 'snapshot_advanced' as const, recordId: recorded.recordId };
      }),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const })),
    };
    const verifyCredentialFingerprint = vi.fn(async () => true);

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      sourceProviderAccountId: 'acct_connected_profile',
      credentialFingerprint: 'sha256:deadbeef',
      verifyCredentialFingerprint,
      observation: { sources: [source] },
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'credential_fingerprint_mismatch',
      recordId: snapshot.recordId,
      persisted: false,
    });

    expect(verifyCredentialFingerprint).toHaveBeenCalledOnce();
    expect(verifyCredentialFingerprint).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      providerAccountId: 'acct_connected_profile',
      credentialFingerprint: 'sha256:deadbeef',
    });
    expect(store.recordSnapshot).not.toHaveBeenCalled();
    expect(latestObservation).toBeUndefined();
    expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
  });

  it('does not advance account usage when an exact source credential fingerprint is rejected', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot(createRecordKey('acct_observed_runtime'));
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const })),
    };
    const verifyCredentialFingerprint = vi.fn(async () => false);

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      sourceProviderAccountId: 'acct_observed_runtime',
      credentialFingerprint: 'sha256:deadbeef',
      verifyCredentialFingerprint,
      observation: { sources: [source] },
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'credential_fingerprint_mismatch',
      recordId: snapshot.recordId,
      persisted: false,
    });

    expect(verifyCredentialFingerprint).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      providerAccountId: 'acct_observed_runtime',
      credentialFingerprint: 'sha256:deadbeef',
    });
    expect(verifyCredentialFingerprint).toHaveBeenCalledOnce();
    expect(store.recordSnapshot).not.toHaveBeenCalled();
    expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
  });

  it('records the usage fact but strips source links when source ownership is unproven', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot(createRecordKey('acct_without_source_proof'));
    let latestObservation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined;
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
        latestObservation = observation;
        return { status: 'snapshot_advanced' as const, recordId: recorded.recordId };
      }),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const })),
    };

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      sourceProviderAccountId: 'acct_connected_profile',
      observation: { sources: [source] },
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: false,
    });

    expect(store.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), undefined);
    expect(latestObservation).toBeUndefined();
    expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), expect.not.objectContaining({ sources: expect.anything() }));
  });

  it('records the usage fact but strips source links for provisional subjects', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const provisionalKey = createRecordKey('provisional:unknown-live-account');
    const snapshot = {
      ...createConnectedServiceGroupSnapshot(provisionalKey),
      confidence: 'unknown' as const,
    };
    let latestObservation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined;
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
        latestObservation = observation;
        return { status: 'snapshot_advanced' as const, recordId: recorded.recordId };
      }),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      sourceProviderAccountId: 'acct_connected_profile',
      observation: { sources: [source] },
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });

    expect(store.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), undefined);
    expect(latestObservation).toBeUndefined();
    expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
    }), expect.not.objectContaining({ sources: expect.anything() }));
  });

  it('keeps recording successful when session metadata publication fails after persistence succeeds', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };
    const persistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };
    const publishRecordId = vi.fn(async () => {
      throw new Error('metadata write unavailable');
    });

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence,
      publishRecordId,
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });
    expect(publishRecordId).toHaveBeenCalledOnce();
  });

  it('returns after persistence custody without waiting for session metadata publication', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    let releasePublication!: () => void;
    const publicationBarrier = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishRecordId = vi.fn(async () => await publicationBarrier);

    const recording = module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store: {
        recordSnapshot: () => ({
          status: 'snapshot_advanced' as const,
          recordId: snapshot.recordId,
        }),
        resolveRecordId: () => snapshot,
      },
      persistence: {
        recordInBandSnapshot: async () => ({ status: 'persisted' as const }),
      },
      publishRecordId,
      sessionId: 'sess_1',
      snapshot,
    });

    await expect(Promise.race([
      recording,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ])).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: true,
    });
    expect(publishRecordId).toHaveBeenCalledOnce();
    releasePublication();
  });

  it('records provisional connected-service usage without any durable connected-service quota projection', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const provisionalKey = createRecordKey('provisional:unknown-live-account');
    const snapshot = {
      ...createConnectedServiceGroupSnapshot(provisionalKey),
      confidence: 'unknown' as const,
    };
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence: null,
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: false,
    });
  });

  it('records confirmed connected-service group-member usage without triggering a second durable write', async () => {
    const module = await loadRecordModule();
    expect(module).not.toBeNull();
    const snapshot = createConnectedServiceGroupSnapshot();
    const store = {
      recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
        status: 'snapshot_advanced' as const,
        recordId: recorded.recordId,
      })),
      resolveRecordId: vi.fn(() => snapshot),
    };

    await expect(module!.recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'sess_1' }],
      store,
      persistence: null,
      sessionId: 'sess_1',
      snapshot,
    })).resolves.toEqual({
      status: 'snapshot_advanced',
      recordId: snapshot.recordId,
      persisted: false,
    });
  });

});
