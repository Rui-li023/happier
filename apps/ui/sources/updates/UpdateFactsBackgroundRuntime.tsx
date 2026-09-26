import * as React from 'react';

import { ensureMachineUpdateFactsBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

/**
 * Keeps the Updates summary's coverage: asks each online machine for its tools' update facts
 * through the installables background owner, whenever the server or its set of online machines changes. The
 * owner's freshness policy decides whether anything is actually sent; no timer re-asks. Renders
 * nothing; the summary only observes the cache this fills.
 */
export function UpdateFactsBackgroundRuntime(props: Readonly<{ enabled: boolean }>): null {
    const machines = useAllMachines();
    // These machines' server: the facts land in that server's cache entries, the ones the summary reads.
    const serverId = useActiveServerSnapshot().serverId;
    const onlineKey = React.useMemo(
        () => machines.filter((machine) => isMachineOnline(machine)).map((machine) => machine.id).sort().join('\u0000'),
        [machines],
    );
    React.useEffect(() => {
        if (!props.enabled || !onlineKey) return;
        void ensureMachineUpdateFactsBackground({ serverId, machineIds: onlineKey.split('\u0000') });
    }, [onlineKey, props.enabled, serverId]);
    return null;
}
