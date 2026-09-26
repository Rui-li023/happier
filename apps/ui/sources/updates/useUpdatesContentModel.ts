import * as React from 'react';
import { useRouter } from 'expo-router';

import { useReleaseNotesLauncher, useReleaseNotesUnread } from '@/changelog/releaseNotes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { ensureMachineUpdateFactsBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { buildMachineUpdateFactsRequest } from '@/capabilities/requests';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';

import { buildMachineUpdateGroups, readUpdatableInstallables, type UpdatesGroup } from './buildMachineUpdateGroups';
import { buildUpdatesSummary, planUpdateAll, type UpdatesSummary } from './items/buildUpdatesSummary';
import { resolveUpdateConfirmation } from './items/resolveUpdateConfirmation';
import type { UpdateItem } from './items/updateItem';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { markUpdateCompletionsSeen, runMachineItemUpdate, useMachineUpdateRuns, useUnseenUpdateCompletions } from './machineUpdateRuns';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

export type { UpdatesGroup };

export type UpdateAllProgress = Readonly<{ done: number; total: number; stopping: boolean }>;

export type UpdatesContentModel = Readonly<{
    summary: UpdatesSummary;
    groups: readonly UpdatesGroup[];
    checkedAt: number | null;
    runItem: (item: UpdateItem) => Promise<void>;
    updateAll: () => Promise<void>;
    stopAfterCurrent: () => void;
    batch: UpdateAllProgress | null;
    checkNow: () => void;
    skipAppVersion: (() => void) | null;
    /** Release notes stay reachable from the This app group (R13 (e)). */
    openWhatsNew: () => void;
    whatsNewUnread: boolean;
}>;

/** Sessions running on these machines right now, read at press time from the canonical session state. */
function countRunningSessions(machineIds: readonly string[]): number {
    const ids = new Set(machineIds);
    let count = 0;
    for (const session of Object.values(storage.getState().sessions)) {
        if (session.active && ids.has(resolveSessionMachineId(session.metadata ?? null) ?? '')) count += 1;
    }
    return count;
}

/**
 * The Updates surface's detail model, mounted only while the popover or the screen is open
 * (`apps/ui/AGENTS.md`): it asks each online machine for its agent CLI and helper versions through
 * the machine capability cache's own freshness policy, lists every row in the fixed order
 * This app → This computer → other machines, and runs actions through their canonical executors.
 */
export function useUpdatesContentModel(): UpdatesContentModel {
    const router = useRouter();
    const app = useAppUpdateStatus();
    const appItem = app.model.item;
    const thisComputer = useThisComputerCliUpdate();
    const machines = useAllMachines();
    // One server scope for the rows, their facts, their runs and their refreshes.
    const serverId = useActiveServerSnapshot().serverId;
    const runs = useMachineUpdateRuns(serverId);
    const releaseNotes = useReleaseNotesUnread();
    const releaseNotesLauncher = useReleaseNotesLauncher();

    const installables = React.useMemo(readUpdatableInstallables, []);
    const request = React.useMemo(buildMachineUpdateFactsRequest, []);

    const onlineMachineIds = React.useMemo(() => {
        const ids = machines.filter((machine) => machine.id !== thisComputer.machineId && isMachineOnline(machine)).map((machine) => machine.id);
        if (thisComputer.machineId) ids.unshift(thisComputer.machineId);
        return ids;
    }, [machines, thisComputer.machineId]);
    const onlineKey = onlineMachineIds.join('\u0000');
    // Every machine's cached detect (offline ones keep their last-known rows); only online ones are asked.
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds);
    // Opening the surface asks each online machine through the cache's existing freshness policy.
    React.useEffect(() => {
        void ensureMachineUpdateFactsBackground({ serverId, machineIds: onlineKey ? onlineKey.split('\u0000') : [] });
    }, [onlineKey, serverId]);

    const refreshMachine = React.useCallback((machineId: string, runServerId: string) => {
        void prefetchMachineCapabilities({ machineId, serverId: runServerId, request: { ...request, bypassCache: true } });
    }, [request]);

    const { groups, remotes, uncheckedMachineCount } = React.useMemo(() => {
        const built = buildMachineUpdateGroups({
            machines,
            thisMachineId: thisComputer.machineId,
            thisComputerItem: thisComputer.item,
            runs,
            snapshots,
            installables,
        });
        const app: UpdatesGroup = { id: 'app', kind: 'app', machineName: null, machineId: null, online: true, items: [appItem] };
        return { groups: [app, ...built.groups], remotes: built.remotes, uncheckedMachineCount: built.uncheckedMachineCount };
    }, [appItem, installables, machines, runs, snapshots, thisComputer.item, thisComputer.machineId]);

    const allItems = React.useMemo(() => groups.flatMap((group) => group.items), [groups]);
    // Open Updates shows every result, so the pill's "Updated" is seen; a completion that lands
    // while the surface stays open is seen too (its row says so).
    const completions = useUnseenUpdateCompletions();
    React.useEffect(() => {
        markUpdateCompletionsSeen();
    }, [completions]);
    // The same coverage the always-mounted summary ranks with, so the open header never says
    // "Up to date" while the pill says some tools were not checked.
    const summary = React.useMemo(
        () => buildUpdatesSummary(allItems, new Map(), { uncheckedMachineCount }),
        [allItems, uncheckedMachineCount],
    );

    const lastUpdateSignatureByMachine = React.useMemo(
        () => new Map(remotes.map((remote) => [remote.machine.id, remote.lastUpdateSignature])),
        [remotes],
    );
    const machineNameById = React.useMemo(
        () => new Map(groups.filter((group) => group.machineId).map((group) => [group.machineId as string, group.machineName ?? ''])),
        [groups],
    );

    const executeItem = React.useCallback(async (item: UpdateItem) => {
        if (item.subject.kind === 'app') return app.run();
        if (item.subject.kind === 'happier-cli' && item.machineId === thisComputer.machineId) return thisComputer.run();
        const machineId = item.machineId;
        if (!machineId) return;
        await runMachineItemUpdate(item, {
            serverId,
            lastUpdateSignature: lastUpdateSignatureByMachine.get(machineId),
            refresh: () => refreshMachine(machineId, serverId),
        });
    }, [app, lastUpdateSignatureByMachine, refreshMachine, serverId, thisComputer]);

    /** Consequential remote actions go through the established confirmation owner; local ones do not. */
    const confirmRemote = React.useCallback(async (targets: ReadonlyArray<Readonly<{ machineId: string; name: string }>>) => {
        if (targets.length === 0) return true;
        const running = countRunningSessions(targets.map((target) => target.machineId));
        const message = t('updates.confirmRemote.message', { machines: targets.map((target) => target.name).join(', ') });
        return await Modal.confirm(
            t('updates.confirmRemote.title'),
            running > 0 ? `${message} ${t('updates.confirmRemote.sessions', { count: running })}` : message,
            { confirmText: t('updates.action.update'), cancelText: t('common.cancel') },
        );
    }, []);

    /** K6 — a vendor's own updater runs code from that vendor: the person confirms it first. */
    const confirmVendor = React.useCallback(async (names: readonly string[]) => {
        if (names.length === 0) return true;
        return await Modal.confirm(
            t('updates.confirmVendor.title'),
            t('updates.confirmVendor.message', { names: names.join(', ') }),
            { confirmText: t('updates.action.update'), cancelText: t('common.cancel') },
        );
    }, []);

    const runItem = React.useCallback(async (item: UpdateItem) => {
        if (item.action.kind !== 'run') return;
        const confirmation = resolveUpdateConfirmation(item, thisComputer.machineId);
        if (confirmation === 'vendor') {
            if (!(await confirmVendor([item.title]))) return;
        } else if (confirmation === 'remote') {
            const machineId = item.machineId as string;
            const confirmed = await confirmRemote([{ machineId, name: machineNameById.get(machineId) ?? machineId }]);
            if (!confirmed) return;
        }
        await executeItem(item);
    }, [confirmRemote, confirmVendor, executeItem, machineNameById, thisComputer.machineId]);

    const [batch, setBatch] = React.useState<UpdateAllProgress | null>(null);
    const stopRef = React.useRef(false);
    const itemsRef = React.useRef(allItems);
    itemsRef.current = allItems;

    const updateAll = React.useCallback(async () => {
        if (batch) return;
        const plan = planUpdateAll(itemsRef.current);
        if (plan.total === 0) return;
        const remoteTargets = plan.machines
            .filter((machine) => machine.machineId !== thisComputer.machineId)
            .map((machine) => ({ machineId: machine.machineId, name: machineNameById.get(machine.machineId) ?? machine.machineId }));
        if (!(await confirmRemote(remoteTargets))) return;
        const byIdForConfirm = new Map(itemsRef.current.map((item) => [item.id, item]));
        const vendorNames = plan.machines
            .flatMap((machine) => machine.itemIds)
            .map((itemId) => byIdForConfirm.get(itemId))
            .filter((item): item is UpdateItem => item?.vendorUpdater === true)
            .map((item) => item.title);
        if (!(await confirmVendor([...new Set(vendorNames)]))) return;

        stopRef.current = false;
        let done = 0;
        setBatch({ done, total: plan.total, stopping: false });
        const byId = new Map(itemsRef.current.map((item) => [item.id, item]));
        const settle = () => {
            done += 1;
            setBatch((current) => (current ? { ...current, done } : current));
        };
        // Per machine in order (the Happier CLI last, it restarts the daemon the others travel
        // through); machines side by side; the app only downloads — its restart is the person's.
        await Promise.all([
            ...plan.machines.map(async (machine) => {
                for (const itemId of machine.itemIds) {
                    if (stopRef.current) return;
                    const item = byId.get(itemId);
                    if (item) await executeItem(item);
                    settle();
                }
            }),
            (async () => {
                const appItem = plan.appItemId ? byId.get(plan.appItemId) : undefined;
                if (!appItem || stopRef.current) return;
                if (appItem.action.kind === 'run' && appItem.action.verb === 'update') await app.run();
                settle();
            })(),
        ]);
        setBatch(null);
    }, [app, batch, confirmRemote, confirmVendor, executeItem, machineNameById, thisComputer.machineId]);

    const stopAfterCurrent = React.useCallback(() => {
        stopRef.current = true;
        setBatch((current) => (current ? { ...current, stopping: true } : current));
    }, []);

    const checkNow = React.useCallback(() => {
        void app.checkNow();
        for (const machineId of onlineKey ? onlineKey.split('\u0000') : []) refreshMachine(machineId, serverId);
    }, [app, onlineKey, refreshMachine, serverId]);

    const openWhatsNew = React.useCallback(() => {
        if (releaseNotesLauncher.open()) return;
        router.push('/(app)/changelog');
    }, [releaseNotesLauncher, router]);

    return React.useMemo(() => ({
        summary,
        groups,
        checkedAt: app.checkedAt,
        runItem,
        updateAll,
        stopAfterCurrent,
        batch,
        checkNow,
        skipAppVersion: app.skipVersion,
        openWhatsNew,
        whatsNewUnread: releaseNotes.hasUnread,
    }), [app.checkedAt, app.skipVersion, batch, checkNow, groups, openWhatsNew, releaseNotes.hasUnread, runItem, stopAfterCurrent, summary, updateAll]);
}
