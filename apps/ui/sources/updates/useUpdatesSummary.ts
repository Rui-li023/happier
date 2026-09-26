import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines } from '@/sync/domains/state/storage';

import { buildUpdatesSummary, isSameUpdatesSummary, type UpdatesSummary } from './items/buildUpdatesSummary';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { useMachineUpdateRuns, useUnseenUpdateCompletions } from './machineUpdateRuns';
import { buildMachineUpdateGroups, readUpdatableInstallables } from './buildMachineUpdateGroups';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

/**
 * The stable summary every always-mounted entry reads (sidebar pill, collapsed rail, phone header,
 * Settings row, tray). It classifies through the same builders the Updates surface lists, from
 * facts already on this device — no RPC: this app, this computer's Happier CLI, every machine's
 * Happier CLI from its metadata (K5), and the agent CLIs and helpers whose latest versions the
 * installables background owner keeps in the capability cache (K6).
 */
export function useUpdatesSummary(): UpdatesSummary {
    const app = useAppUpdateStatus();
    const thisComputer = useThisComputerCliUpdate();
    const machines = useAllMachines();
    // The server these machines belong to: its runs and its cached detects, never another server's.
    const serverId = useActiveServerSnapshot().serverId;
    const runs = useMachineUpdateRuns(serverId);
    const completions = useUnseenUpdateCompletions();
    // Observes (never fetches) the cached detects: K6 agent facts and helper latest versions that
    // the installables background owner keeps fresh, and each daemon's `tool.systemTasks` kinds.
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds);
    const installables = React.useMemo(readUpdatableInstallables, []);
    const summary = React.useMemo(() => {
        const { groups, uncheckedMachineCount } = buildMachineUpdateGroups({
            machines,
            thisMachineId: thisComputer.machineId,
            thisComputerItem: thisComputer.item,
            runs,
            snapshots,
            installables,
        });
        return buildUpdatesSummary([app.model.item, ...groups.flatMap((group) => group.items)], completions, { uncheckedMachineCount });
    }, [app.model.item, completions, installables, machines, runs, snapshots, thisComputer.item, thisComputer.machineId]);
    // Same values → same object, for every field (`isSameUpdatesSummary`), so entries re-render
    // only when something they show changed.
    const stableRef = React.useRef(summary);
    if (!isSameUpdatesSummary(stableRef.current, summary)) stableRef.current = summary;
    return stableRef.current;
}

const NOTHING_TO_SHOW: UpdatesSummary = {
    actionableCount: 0,
    failedCount: 0,
    runningCount: 0,
    phase: 'none',
    status: 'upToDate',
    visible: false,
};

/** Hosts without the provider (the pet overlay webview) show no Updates entry. */
const UpdatesSummaryContext = React.createContext<UpdatesSummary>(NOTHING_TO_SHOW);

/**
 * Computes the summary once for the whole app shell; every always-mounted entry (sidebar pill,
 * collapsed rail, phone header, Settings row, tray) reads it through `useSharedUpdatesSummary`
 * instead of rebuilding every machine's rows itself (the inbox summary pattern).
 */
export function UpdatesSummaryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const summary = useUpdatesSummary();
    return React.createElement(UpdatesSummaryContext.Provider, { value: summary }, props.children);
}

export function useSharedUpdatesSummary(): UpdatesSummary {
    return React.useContext(UpdatesSummaryContext);
}
