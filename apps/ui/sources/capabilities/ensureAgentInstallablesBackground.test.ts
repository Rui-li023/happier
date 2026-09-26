import { describe, expect, it, vi } from 'vitest';

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilitiesDetectRequest, CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { MachineCapabilitiesInvokeResult } from '@/sync/ops';

import { buildInstallablesBackgroundActionKey, ensureAgentInstallablesBackground, ensureMachineUpdateFactsBackground } from './ensureAgentInstallablesBackground';

function buildMissingCodexAcpResults() {
    return {
        'dep.codex-acp': {
            ok: true as const,
            checkedAt: Date.now(),
            data: {
                installed: false,
                installDir: '/tmp',
                binPath: null,
                installedVersion: null,
                sourceKind: 'github_release_binary' as const,
                lastInstallLogPath: null,
            },
        },
    };
}

async function withMockedNow<T>(initialNowMs: number, run: (setNowMs: (nextNowMs: number) => void) => Promise<T>): Promise<T> {
    let currentNowMs = initialNowMs;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentNowMs);
    try {
        return await run((nextNowMs) => {
            currentNowMs = nextNowMs;
        });
    } finally {
        nowSpy.mockRestore();
    }
}

describe('ensureAgentInstallablesBackground', () => {
    it('prefetches missing dep status before planning background installs', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        let snapshotResults: MachineCapabilitiesSnapshot['response']['results'] = {};

        const prefetchMachineCapabilities = vi.fn(async (params: {
            request: CapabilitiesDetectRequest;
        }) => {
            const reqs = Array.isArray(params.request?.requests) ? params.request.requests : [];
            const askedForCodexAcp = reqs.some((r) => r.id === 'dep.codex-acp');
            if (askedForCodexAcp) {
                snapshotResults = buildMissingCodexAcpResults();
            }
        });

        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(
            (): MachineCapabilitiesSnapshot => ({
                response: { protocolVersion: 1 as const, results: snapshotResults },
            }),
        );

        await ensureAgentInstallablesBackground(
            {
                agentId: 'codex',
                machineId: 'm1',
                serverId: 's1',
                settings,
                resumeSessionId: '',
            },
            {
                prefetchMachineCapabilities,
                getMachineCapabilitiesSnapshot,
                machineCapabilitiesInvoke,
            },
        );

        expect(prefetchMachineCapabilities).toHaveBeenCalled();
        expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ id: 'dep.codex-acp', method: 'install' }),
            expect.anything(),
        );
    });

    it('respects autoInstallWhenNeeded=false policy overrides', async () => {
        const settings = settingsParse({
            codexBackendMode: 'acp',
            installablesPolicyByMachineId: {
                m1: {
                    'codex-acp': { autoInstallWhenNeeded: false },
                },
            },
        } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
            },
        }));

        await ensureAgentInstallablesBackground(
            {
                agentId: 'codex',
                machineId: 'm1',
                serverId: 's1',
                settings,
                resumeSessionId: '',
            },
            {
                prefetchMachineCapabilities,
                getMachineCapabilitiesSnapshot,
                machineCapabilitiesInvoke,
            },
        );

        expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
    });

    it('invokes background installs without managed install override params', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_install', serverId: 's_install', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        const request = machineCapabilitiesInvoke.mock.calls[0]?.[1];
        expect(request).toMatchObject({ id: 'dep.codex-acp', method: 'install' });
        expect((request as any).params).toBeUndefined();
    });

    it('suppresses duplicate retries during the success cooldown window', async () => {
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);
            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(
                async (): Promise<MachineCapabilitiesInvokeResult> => ({ supported: true, response: { ok: true, result: null } }),
            );

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_cooldown', serverId: 's_cooldown', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_cooldown', serverId: 's_cooldown', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        });
    });

    it('includes invoke params in the cooldown key', () => {
        const previewInstallRequest: CapabilitiesInvokeRequest = {
            id: 'dep.codex-acp',
            method: 'install',
            params: { channel: 'preview' },
        };
        const base = buildInstallablesBackgroundActionKey({
            machineId: 'm_key',
            serverId: 's_key',
            installableKey: 'codex-acp',
            request: { id: 'dep.codex-acp', method: 'install' },
        });
        const withParams = buildInstallablesBackgroundActionKey({
            machineId: 'm_key',
            serverId: 's_key',
            installableKey: 'codex-acp',
            request: previewInstallRequest,
        });

        expect(withParams).not.toBe(base);
    });

    it('does not permanently suppress retries after a failed invoke', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_retry', serverId: 's_retry', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );
        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_retry', serverId: 's_retry', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
    });

    it('does not permanently suppress retries after a non-ok invoke response', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockResolvedValueOnce({ supported: true, response: { ok: false, errorMessage: 'nope' } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_nonok', serverId: 's_nonok', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );
        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_nonok', serverId: 's_nonok', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
    });

    it('retries after a successful invoke if the dep is still missing later', async () => {
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);

            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(async () => {
                return { supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult;
            });

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            setNowMs(Date.parse('2026-01-01T01:00:00.000Z'));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
        });
    });

    it('retries after an in-flight block ages out', async () => {
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);
            const prefetchMachineCapabilities = vi.fn(async () => {});
            let resolveInvoke: (() => void) | null = null;
            const machineCapabilitiesInvoke = vi
                .fn()
                .mockImplementationOnce(
                    async () => await new Promise<MachineCapabilitiesInvokeResult>((resolve) => {
                        resolveInvoke = () => resolve({ supported: true, response: { ok: true, result: null } });
                    }),
                )
                .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            const firstCall = ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_stale', serverId: 's_stale', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            await vi.waitFor(() => {
                expect(resolveInvoke).not.toBeNull();
            });
            setNowMs(Date.parse('2026-01-01T00:06:00.000Z'));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_stale', serverId: 's_stale', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            const completeInvoke = resolveInvoke as (() => void) | null;
            if (!completeInvoke) {
                throw new Error('expected install invoke to remain pending');
            }
            completeInvoke();
            await firstCall;

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
        });
    });

    describe('agent CLI latest version (K6, R13 (e): the Updates pill learns of agent updates here)', () => {
        const settings = settingsParse({} as any);
        const agentResult = (data: Record<string, unknown>, checkedAt: number) => ({
            'cli.claude': { ok: true as const, checkedAt, data: { available: true, version: '2.1.3', ...data } },
        });
        const run = async (results: MachineCapabilitiesSnapshot['response']['results']) => {
            const prefetchMachineCapabilities = vi.fn(async (_params: { request: CapabilitiesDetectRequest }) => {});
            await ensureAgentInstallablesBackground(
                { agentId: 'claude', machineId: 'm1', serverId: 's1', settings, resumeSessionId: '' },
                {
                    prefetchMachineCapabilities,
                    getMachineCapabilitiesSnapshot: () => ({ response: { protocolVersion: 1 as const, results } }),
                    machineCapabilitiesInvoke: vi.fn(async (): Promise<MachineCapabilitiesInvokeResult> => ({ supported: true, response: { ok: true, result: null } })),
                },
            );
            return prefetchMachineCapabilities.mock.calls
                .flatMap(([params]) => params.request.requests ?? [])
                .filter((request) => request.id === 'cli.claude');
        };

        it('asks a K6 daemon for the latest version when it has none, on the shared cadence', async () => {
            const now = Date.now();
            expect(await run(agentResult({ updateSupported: true, installSource: 'managed' }, now)))
                .toEqual([{ id: 'cli.claude', params: { includeLatestVersion: true } }]);
            // Fresh answer: nothing to ask.
            expect(await run(agentResult({ updateSupported: true, latestVersion: '2.1.4' }, now))).toEqual([]);
            // Older than the freshness window: ask again.
            expect(await run(agentResult({ updateSupported: true, latestVersion: '2.1.4' }, now - 25 * 60 * 60 * 1000))).toHaveLength(1);
        });

        it('never asks a daemon that predates K6 (it would ignore the request)', async () => {
            expect(await run(agentResult({}, Date.now()))).toEqual([]);
        });
    });

    describe('update facts for every installed agent and helper (R13 (e) summary coverage)', () => {
        it('asks each machine once, on the shared freshness policy, for every agent CLI with its latest version and every helper', async () => {
            const prefetchMachineCapabilitiesIfStale = vi.fn(async (_params: { machineId: string; staleMs: number; request: CapabilitiesDetectRequest }) => {});
            await ensureMachineUpdateFactsBackground({ machineIds: ['m1', 'm2'] }, { prefetchMachineCapabilitiesIfStale });
            expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);
            const [first] = prefetchMachineCapabilitiesIfStale.mock.calls[0]!;
            expect(first.staleMs).toBe(24 * 60 * 60 * 1000);
            const ids = (first.request.requests ?? []).map((request) => request.id);
            expect(ids).toEqual(expect.arrayContaining(['cli.claude', 'cli.codex', 'dep.gh', 'tool.systemTasks']));
            expect((first.request.requests ?? []).find((request) => request.id === 'cli.claude')?.params).toEqual({ includeLatestVersion: true });
        });
    });
});
