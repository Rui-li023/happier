import * as React from 'react';

import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { buildAgentCliCapabilityId } from '@/capabilities/agentCliCapabilityId';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import { MACHINE_RPC_POLL_INTERVAL_MS } from '@/sync/ops/machineRpcPollInterval';
import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';

import type { UnseenUpdateCompletions } from './items/buildUpdatesSummary';
import type { UpdateItem, UpdateItemStep } from './items/updateItem';
import type { UpdateRunObservation } from './items/buildMachineUpdateItems';

/**
 * The one record of machine-side update runs started from this app (agent CLIs, helper
 * installables, another machine's Happier CLI). Each run is the executor's own call — a machine
 * capability invoke or the daemon's `cli.update.v1` system task — and the row reads its lifecycle
 * from here: in flight, failed with one sentence, or (a remote CLI) accepted and waiting for the
 * machine to report the result it persisted. Success is never taken from the call itself: the row
 * re-reads the machine's facts afterwards.
 *
 * Module-level on purpose: the popover and the screen are two views of the same runs.
 */
type RunRecord =
    | Readonly<{ status: 'running' }>
    | Readonly<{ status: 'failed'; message: string; logPath?: string | null }>
    /**
     * A remote CLI update whose task reported it started the updater; `baseline` is the machine's
     * last-update fact at that moment. `unconfirmed`: the machine stopped answering before the task
     * reported (it restarts its daemon onto the update), so the row says so instead of "installed".
     */
    | Readonly<{ status: 'accepted'; baseline: string; unconfirmed?: boolean; inProgressElsewhere?: boolean }>
    | Readonly<{ status: 'finished' }>;

type RunRecords = ReadonlyMap<string, RunRecord>;

/**
 * Runs per server scope (`serverId`): a run belongs to the server whose machines it was started on,
 * so switching servers neither shows it on the other server's rows nor redirects its calls.
 */
let recordsByServer: ReadonlyMap<string, RunRecords> = new Map();
const NO_RECORDS: RunRecords = new Map();
const listeners = new Set<() => void>();

function readScope(serverId: string): RunRecords {
    return recordsByServer.get(serverId) ?? NO_RECORDS;
}

function setRecord(serverId: string, itemId: string, record: RunRecord): void {
    const scope = new Map(readScope(serverId));
    scope.set(itemId, record);
    const next = new Map(recordsByServer);
    next.set(serverId, scope);
    recordsByServer = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** One server's runs, outside React (the summary and tests read the same record). */
export function readMachineUpdateRuns(serverId: string): RunRecords {
    return readScope(serverId);
}

export function useMachineUpdateRuns(serverId: string): RunRecords {
    const read = React.useCallback(() => readScope(serverId), [serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * Completions the person has not seen yet: the pill says "Updated" until Updates is opened once
 * (the seen model, no dwell timer). In memory only — a restart is itself the confirmation.
 */
let completions: UnseenUpdateCompletions = new Map();
const completionListeners = new Set<() => void>();

function setCompletions(next: UnseenUpdateCompletions): void {
    completions = next;
    for (const listener of completionListeners) listener();
}

export function recordUpdateCompleted(itemId: string, kind: 'done' | 'pendingRemote' = 'done'): void {
    if (completions.get(itemId) === kind) return;
    const next = new Map(completions);
    next.set(itemId, kind);
    setCompletions(next);
}

/** Opening Updates shows every result, so nothing is unseen afterwards. */
export function markUpdateCompletionsSeen(): void {
    if (completions.size === 0) return;
    setCompletions(new Map());
}

function subscribeCompletions(listener: () => void): () => void {
    completionListeners.add(listener);
    return () => {
        completionListeners.delete(listener);
    };
}

function readCompletions(): UnseenUpdateCompletions {
    return completions;
}

export function useUnseenUpdateCompletions(): UnseenUpdateCompletions {
    return React.useSyncExternalStore(subscribeCompletions, readCompletions, readCompletions);
}

const IDLE: UpdateRunObservation = { running: false, step: null, errorMessage: null };

/**
 * What a row's executor currently says. `lastUpdateSignature` is the remote CLI's current
 * last-update fact, so an accepted run stays "running" only until the machine reports anything new.
 */
export function observeMachineUpdateRun(
    runs: RunRecords,
    itemId: string,
    options: Readonly<{ step?: UpdateItemStep; lastUpdateSignature?: string }> = {},
): UpdateRunObservation {
    const record = runs.get(itemId);
    if (!record || record.status === 'finished') return IDLE;
    if (record.status === 'running') return { running: true, step: options.step ?? 'installing', errorMessage: null };
    if (record.status === 'failed') return { running: false, step: null, errorMessage: record.message, logPath: record.logPath ?? null };
    return record.baseline === (options.lastUpdateSignature ?? '')
        ? { running: true, step: record.inProgressElsewhere ? 'installing' : record.unconfirmed ? 'lostConnection' : 'reconnecting', errorMessage: null }
        : IDLE;
}

export function signatureOfLastUpdate(lastUpdate: unknown): string {
    return lastUpdate == null ? '' : JSON.stringify(lastUpdate);
}

function describeRemoteFailure(code: string | undefined): string {
    if (code === 'cli_not_managed') return t('machine.thisComputer.cliNotManaged');
    if (code === 'cli_remote_update_unsupported') return t('updates.row.remoteUnsupported');
    return t('updates.row.failedGeneric');
}

/** K6 failure codes → one sentence; never the raw message or log path. */
function describeInstallFailure(code: string | undefined): string {
    if (code === 'update-not-verified') return t('updates.row.updateNotVerified');
    if (code === 'update-not-available') return t('updates.row.updateItYourWay');
    return t('updates.row.failedGeneric');
}

/** Five minutes: the existing installer invoke budget (`InstallableDepInstaller`). */
const INSTALL_INVOKE_TIMEOUT_MS = 5 * 60_000;

type RemoteTaskOutcome =
    | Readonly<{ kind: 'started' }>
    | Readonly<{ kind: 'failed'; code: string | undefined }>
    | Readonly<{ kind: 'unreachable' }>;

function readTaskResult(value: unknown): Readonly<{ ok: boolean; code?: string }> | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as { ok?: unknown; error?: { code?: unknown } };
    if (record.ok === true) return { ok: true };
    if (record.ok === false) return { ok: false, code: typeof record.error?.code === 'string' ? record.error.code : undefined };
    return null;
}

/**
 * `tool.systemTasks` `start` only returns a task id; the task's own outcome (it started the
 * detached updater, or a named refusal) arrives through `poll`. Ask until the task reports it, at
 * the app's machine-RPC cadence. No deadline is guessed: the task settles as soon as the updater
 * is spawned, and a machine that stops answering is reported as such, not as a failure.
 */
async function awaitRemoteTaskOutcome(serverId: string, machineId: string, taskId: string): Promise<RemoteTaskOutcome> {
    for (;;) {
        const polled = await machineCapabilitiesInvoke(machineId, {
            id: 'tool.systemTasks',
            method: 'poll',
            params: { taskId, cursor: 0 },
        }, { serverId });
        if (!polled.supported || !polled.response.ok) return { kind: 'unreachable' };
        const payload = polled.response.result as { result?: unknown } | null;
        const result = readTaskResult(payload?.result);
        if (result) return result.ok ? { kind: 'started' } : { kind: 'failed', code: result.code };
        await new Promise((resolve) => setTimeout(resolve, MACHINE_RPC_POLL_INTERVAL_MS));
    }
}

async function runRemoteCliUpdate(serverId: string, itemId: string, machineId: string, lastUpdateSignature: string): Promise<void> {
    const started = await machineCapabilitiesInvoke(machineId, {
        id: 'tool.systemTasks',
        method: 'start',
        params: { spec: { protocolVersion: 1, kind: 'cli.update.v1', params: {} } },
    }, { serverId });
    if (!started.supported) {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(undefined) });
        return;
    }
    if (!started.response.ok) {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(started.response.error.code) });
        return;
    }
    const taskId = (started.response.result as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId !== 'string' || !taskId) {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(undefined) });
        return;
    }
    const outcome = await awaitRemoteTaskOutcome(serverId, machineId, taskId);
    if (outcome.kind === 'failed' && outcome.code === 'cli_update_in_progress') {
        // Another update holds that machine's install lock; it is not recorded as an outcome, so
        // the row shows it running until the machine publishes a new `lastUpdate`.
        setRecord(serverId, itemId, { status: 'accepted', baseline: lastUpdateSignature, inProgressElsewhere: true });
        return;
    }
    if (outcome.kind === 'failed') {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(outcome.code) });
        return;
    }
    // Started (or the daemon went away while restarting onto the update): from here the machine's
    // own `cliUpdate.lastUpdate` says how it ended, including a failure before activation.
    setRecord(serverId, itemId, { status: 'accepted', baseline: lastUpdateSignature, unconfirmed: outcome.kind === 'unreachable' });
    recordUpdateCompleted(itemId, 'pendingRemote');
}

/**
 * Runs one machine row's update through its canonical executor. `refresh` re-reads that machine's
 * facts afterwards (success is re-read).
 */
export async function runMachineItemUpdate(
    item: UpdateItem,
    context: Readonly<{ serverId: string; lastUpdateSignature?: string; refresh: () => void }>,
): Promise<void> {
    const machineId = item.machineId;
    if (!machineId || item.action.kind !== 'run') return;
    // Captured once: the run, its polls and its record stay on the server its row came from.
    const serverId = context.serverId;
    if (readScope(serverId).get(item.id)?.status === 'running') return;
    setRecord(serverId, item.id, { status: 'running' });

    const subject = item.subject;
    try {
        if (subject.kind === 'happier-cli') {
            await runRemoteCliUpdate(serverId, item.id, machineId, context.lastUpdateSignature ?? '');
            return;
        }

        const request = subject.kind === 'agent-cli'
            // K6 — the catalog install owner, asked for an update of what it installed.
            // A vendor updater (`native`) runs only after the person confirmed it (the caller asks).
            ? {
                id: buildAgentCliCapabilityId(subject.agentId as AgentId),
                method: 'install',
                params: item.vendorUpdater ? { intent: 'update', allowVendorRecipeExecution: true } : { intent: 'update' },
            }
            : subject.kind === 'installable'
                ? (() => {
                    const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === subject.key);
                    return entry ? { id: entry.capabilityId, method: 'upgrade' } : null;
                })()
                : null;
        if (!request) {
            setRecord(serverId, item.id, { status: 'failed', message: t('updates.row.failedGeneric') });
            return;
        }
        const result = await machineCapabilitiesInvoke(machineId, request, { serverId, timeoutMs: INSTALL_INVOKE_TIMEOUT_MS });
        if (!result.supported) {
            setRecord(serverId, item.id, {
                status: 'failed',
                message: result.reason === 'not-supported' ? t('deps.installNotSupported') : t('updates.row.failedGeneric'),
            });
            return;
        }
        if (!result.response.ok) {
            setRecord(serverId, item.id, {
                status: 'failed',
                message: describeInstallFailure(result.response.error.code),
                logPath: typeof result.response.logPath === 'string' ? result.response.logPath : null,
            });
            return;
        }
        setRecord(serverId, item.id, { status: 'finished' });
        recordUpdateCompleted(item.id);
    } catch {
        setRecord(serverId, item.id, { status: 'failed', message: t('updates.row.failedGeneric') });
    } finally {
        context.refresh();
    }
}
