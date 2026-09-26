import { compareVersionsOrNull } from '@/utils/system/versionUtils';
import type { InstallableDepDataLike } from './installablesRegistry';

/** `null` means the helper's versions cannot be ordered, not that it is current. */
export function getInstallableDepUpdateAvailability(data: InstallableDepDataLike | null): boolean | null {
    if (!data?.installed) return null;
    const installed = data.installedVersion;
    const latest = data.latestVersionCheck && data.latestVersionCheck.ok ? data.latestVersionCheck.latestVersion : null;
    if (!installed || !latest) return null;
    const comparison = compareVersionsOrNull(installed, latest);
    return comparison === null ? null : comparison < 0;
}

export function isInstallableDepUpdateAvailable(data: InstallableDepDataLike | null): boolean {
    return getInstallableDepUpdateAvailability(data) === true;
}
