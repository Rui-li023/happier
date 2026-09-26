import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { buildAgentCliCapabilityId } from '@/capabilities/agentCliCapabilityId';
import { buildMachineUpdateFactsRequest } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableDepDataLike } from '@/capabilities/installablesRegistry';
import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { buildAgentCliUpdateItem, buildInstallableUpdateItem, buildProbeFailedItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { readCapabilityResultData } from './machineCapabilitySnapshots';
import { observeMachineUpdateRun, type useMachineUpdateRuns } from './machineUpdateRuns';
import { buildRemoteMachineUpdateFacts, type RemoteMachineUpdateFacts } from './remoteCliUpdateItems';

export type UpdatesGroup = Readonly<{
    id: string;
    kind: 'app' | 'thisComputer' | 'machine';
    /** The machine's display name (case preserved); `null` for this app. */
    machineName: string | null;
    machineId: string | null;
    online: boolean;
    items: readonly UpdateItem[];
}>;

type InstallableEntry = ReturnType<typeof getInstallablesRegistryEntries>[number];

/** Helper installables with a latest-version check of their own (pinned runtimes follow the CLI). */
export function readUpdatableInstallables(): readonly InstallableEntry[] {
    return getInstallablesRegistryEntries().filter((entry) => entry.shouldPrefetchLatestVersion({}));
}

function buildMachineRows(params: Readonly<{
    machineId: string;
    online: boolean;
    snapshot: MachineCapabilitiesSnapshot | null;
    runs: ReturnType<typeof useMachineUpdateRuns>;
    installables: readonly InstallableEntry[];
}>): UpdateItem[] {
    const rows: UpdateItem[] = [];
    for (const agentId of AGENT_IDS) {
        const capabilityId = buildAgentCliCapabilityId(agentId);
        if (isProbeFailed(params.snapshot, capabilityId)) {
            // The probe itself failed: nothing is known about this agent here — "Couldn't check",
            // never "up to date" (retried on the failure cadence by the cache owner).
            rows.push(buildProbeFailedItem({
                machineId: params.machineId,
                subject: { kind: 'agent-cli', agentId },
                title: t(getAgentCore(agentId as AgentId).displayNameKey),
                online: params.online,
            }));
            continue;
        }
        const row = buildAgentCliUpdateItem({
            machineId: params.machineId,
            agentId,
            title: t(getAgentCore(agentId as AgentId).displayNameKey),
            online: params.online,
            data: readCapabilityResultData(params.snapshot, buildAgentCliCapabilityId(agentId)),
            task: observeMachineUpdateRun(params.runs, `${params.machineId}:agent:${agentId}`),
        });
        if (row) rows.push(row);
    }
    for (const entry of params.installables) {
        if (isProbeFailed(params.snapshot, entry.capabilityId)) {
            // Same for a helper: a failed check is listed as "Couldn't check", it never vanishes.
            rows.push(buildProbeFailedItem({
                machineId: params.machineId,
                subject: { kind: 'installable', key: entry.key },
                title: entry.title,
                online: params.online,
            }));
            continue;
        }
        const row = buildInstallableUpdateItem({
            machineId: params.machineId,
            installableKey: entry.key,
            title: entry.title,
            online: params.online,
            data: readCapabilityResultData(params.snapshot, entry.capabilityId) as InstallableDepDataLike | null,
            task: observeMachineUpdateRun(params.runs, `${params.machineId}:installable:${entry.key}`),
        });
        if (row) rows.push(row);
    }
    return rows;
}

/**
 * Every machine's update rows, in the fixed order This computer → other machines by name, from
 * facts that are already on this device: machine metadata (K5) and the capability cache (K6 agent
 * detects and helper installables, filled by the installables background owner and by the open
 * Updates surface). It never fetches — the always-mounted summary and the open surface both call
 * it, so the pill and the list count the same rows.
 */
export function buildMachineUpdateGroups(params: Readonly<{
    machines: readonly Machine[];
    thisMachineId: string | null;
    thisComputerItem: UpdateItem | null;
    runs: ReturnType<typeof useMachineUpdateRuns>;
    snapshots: ReadonlyMap<string, MachineCapabilitiesSnapshot | null>;
    installables?: readonly InstallableEntry[];
}>): Readonly<{ groups: UpdatesGroup[]; remotes: RemoteMachineUpdateFacts[]; uncheckedMachineCount: number }> {
    const installables = params.installables ?? readUpdatableInstallables();
    const groups: UpdatesGroup[] = [];
    const machineId = params.thisMachineId;
    if (machineId || params.thisComputerItem) {
        const own = params.machines.find((machine) => machine.id === machineId);
        groups.push({
            id: 'thisComputer',
            kind: 'thisComputer',
            machineName: own?.metadata?.displayName || own?.metadata?.host || null,
            machineId,
            online: true,
            items: [
                ...(params.thisComputerItem ? [params.thisComputerItem] : []),
                ...(machineId
                    ? buildMachineRows({ machineId, online: true, snapshot: params.snapshots.get(machineId) ?? null, runs: params.runs, installables })
                    : []),
            ],
        });
    }
    const remotes = buildRemoteMachineUpdateFacts(params.machines, machineId, params.runs, params.snapshots);
    for (const remote of remotes) {
        groups.push({
            id: `machine:${remote.machine.id}`,
            kind: 'machine',
            machineName: remote.name,
            machineId: remote.machine.id,
            online: remote.online,
            items: [
                remote.cliItem,
                ...buildMachineRows({
                    machineId: remote.machine.id,
                    online: remote.online,
                    snapshot: params.snapshots.get(remote.machine.id) ?? null,
                    runs: params.runs,
                    installables,
                }),
            ],
        });
    }
    // Coverage: an online machine is checked only once it answered every capability the update-facts
    // request asks (a missing answer is "not checked"; a failed one is its own "Couldn't check" row).
    const requestedIds = [...new Set((buildMachineUpdateFactsRequest().requests ?? []).map((request) => request.id))];
    const uncheckedMachineCount = groups.filter((group) => (
        group.machineId != null && group.online && !hasAnswered(params.snapshots.get(group.machineId) ?? null, requestedIds)
    )).length;
    return { groups, remotes, uncheckedMachineCount };
}

type SnapshotResults = MachineCapabilitiesSnapshot['response']['results'];

function readProbe(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): SnapshotResults[keyof SnapshotResults] | undefined {
    return snapshot?.response.results[capabilityId as keyof SnapshotResults];
}

function isProbeFailed(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): boolean {
    const probe = readProbe(snapshot, capabilityId);
    return probe != null && !probe.ok;
}

function hasAnswered(snapshot: MachineCapabilitiesSnapshot | null, capabilityIds: readonly string[]): boolean {
    return capabilityIds.every((id) => readProbe(snapshot, id) != null);
}
