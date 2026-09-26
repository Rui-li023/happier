import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The machine RPC is the boundary: `tool.systemTasks` start returns a task id, the terminal
// result arrives through `poll` (packages/cli-common interactiveTaskKinds).
const rpc = vi.hoisted(() => ({
    pollResults: [] as unknown[],
    invoke: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke: (...args: unknown[]) => rpc.invoke(...args),
}));

import type { UpdateItem } from './items/updateItem';

const remoteCli: UpdateItem = {
    id: 'studio:happier-cli',
    subject: { kind: 'happier-cli' },
    machineId: 'studio',
    title: 'Happier CLI',
    currentVersion: '0.2.12',
    latestVersion: '0.2.14',
    state: 'available',
    progressPercent: null,
    step: null,
    managedBy: 'happier',
    action: { kind: 'run', verb: 'update' },
    failure: null,
    skipped: false,
    vendorUpdater: false,
};

function installRpc() {
    rpc.invoke.mockImplementation(async (_machineId: string, request: { method: string }) => {
        if (request.method === 'start') return { supported: true, response: { ok: true, result: { taskId: 'task-1' } } };
        const next = rpc.pollResults.length > 1 ? rpc.pollResults.shift() : rpc.pollResults[0];
        return { supported: true, response: { ok: true, result: { events: [], nextCursor: 0, result: next ?? null, pendingPrompt: null } } };
    });
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('runMachineItemUpdate — a remote CLI update is started, then observed', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        rpc.invoke.mockReset();
        rpc.pollResults = [];
        installRpc();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('an asynchronous refusal shows its failure and never "waiting to reconnect"', async () => {
        rpc.pollResults = [
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: false, error: { code: 'cli_remote_update_unsupported', message: 'no' } },
        ];
        const runs = await import('./machineUpdateRuns');
        const seenSteps: string[] = [];
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });

        const done = runs.runMachineItemUpdate(remoteCli, { serverId: 'server-a', lastUpdateSignature: '', refresh: () => {} });
        await advance(0);
        seenSteps.push(String(read().step));
        await advance(5_000);
        await done;
        seenSteps.push(String(read().step));

        expect(read()).toMatchObject({ running: false, errorMessage: 'updates.row.remoteUnsupported' });
        expect(seenSteps).not.toContain('reconnecting');
    });

    it('enters "waiting to reconnect" only once the task reports that it started the updater', async () => {
        rpc.pollResults = [
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        const runs = await import('./machineUpdateRuns');
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });

        const done = runs.runMachineItemUpdate(remoteCli, { serverId: 'server-a', lastUpdateSignature: '', refresh: () => {} });
        await advance(0);
        expect(read()).toMatchObject({ running: true, step: 'installing' });
        await advance(5_000);
        await done;
        expect(read()).toMatchObject({ running: true, step: 'reconnecting' });
    });

    it('another update holding the lock reads as in progress, not as a failure', async () => {
        rpc.pollResults = [
            { protocolVersion: 1, taskId: 'task-1', ok: false, error: { code: 'cli_update_in_progress', message: 'busy' } },
        ];
        const runs = await import('./machineUpdateRuns');
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });
        const done = runs.runMachineItemUpdate(remoteCli, { serverId: 'server-a', lastUpdateSignature: '', refresh: () => {} });
        await advance(5_000);
        await done;
        expect(read()).toMatchObject({ running: true, step: 'installing', errorMessage: null });
        // It ends when the machine reports a new outcome.
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: 'changed' }).running).toBe(false);
    });

    it('an in-flight update stays attached to the server it started on, even after switching servers', async () => {
        rpc.pollResults = [
            null,
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        const runs = await import('./machineUpdateRuns');
        const done = runs.runMachineItemUpdate(remoteCli, { serverId: 'server-a', lastUpdateSignature: '', refresh: () => {} });
        await advance(5_000);
        await done;

        // Start and every poll go to the original server, never to whichever server is active now.
        expect(rpc.invoke.mock.calls.length).toBeGreaterThanOrEqual(3);
        for (const call of rpc.invoke.mock.calls) expect(call[2]).toMatchObject({ serverId: 'server-a' });
        // The run belongs to that server's rows only.
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' }).running).toBe(true);
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-b'), remoteCli.id, { lastUpdateSignature: '' }).running).toBe(false);
    });
});
