import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const routerMock = createExpoRouterMock();
vi.mock('expo-router', () => routerMock.module);

// Machines are storage-owned facts; the default is none.
const machinesState = vi.hoisted(() => ({ value: [] as Machine[] }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({ importOriginal, overrides: { useAllMachines: () => machinesState.value } });
});

// The real Updates owner and content render beneath; only the portal host and the overlay
// surface (platform presentation boundaries) are replaced.
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) => (
        React.createElement('Popover', props, props.children({ maxHeight: 600, maxWidth: 500 }))
    ),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown>) => React.createElement('FloatingOverlay', props, props.children as React.ReactNode),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NONE: UpdatesSummary = { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false };
const TWO: UpdatesSummary = { actionableCount: 2, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true };

describe('UpdatesPopoverButton', () => {
    it('is absent at zero, and a closed pill renders no detail content', async () => {
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={NONE} variant="pill" testID="pill" />);
        expect(screen.findAllHostsByTestId('pill')).toHaveLength(0);

        await screen.update(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        expect(screen.findByTestId('pill')?.props.accessibilityLabel).toBe('updates.a11y.pillAvailable');
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('opens the real content in the popover density, and removes it again on close', async () => {
        routerMock.spies.push.mockClear();
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);

        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('updates.open_full');
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(screen.findAllByType('Popover' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('on the phone header, goes to Settings › Updates instead of opening a popover', async () => {
        routerMock.spies.push.mockClear();
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="header" testID="header" />);
        await act(async () => {
            await screen.findByTestId('header')?.props.onPress({});
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('the open header says "not checked" when an online machine was never asked, like the pill', async () => {
        machinesState.value = [{
            id: 'studio', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(),
            metadata: { host: 'studio', platform: 'darwin', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h' },
        } as Machine];
        try {
            const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
            const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
            await act(async () => {
                await screen.findByTestId('pill')?.props.onPress({});
            });
            const title = screen.findByTestId('updates.summary.title')?.props.children ?? screen.findByTestId('updates.empty')?.props.title;
            expect(title).toBe('updates.summary.unchecked');
        } finally {
            machinesState.value = [];
        }
    });
});
