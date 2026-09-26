import type { ActionId } from '@happier-dev/protocol';

import { t, type TranslationKeyNoParams } from '@/text';

type ActionSpecCopyKeys = Readonly<{
    title: TranslationKeyNoParams;
    description: TranslationKeyNoParams;
}>;

/**
 * Localized UI copy for protocol action specs. A spec's own `title`/`description` is English
 * protocol copy shared with the CLI, MCP and voice surfaces; specs listed here render translated
 * copy in the app instead. Specs without an entry keep their protocol copy.
 */
const ACTION_SPEC_COPY_KEYS: Partial<Record<ActionId, ActionSpecCopyKeys>> = {
    'session.fork': { title: 'sessionInfo.forkSession', description: 'sessionInfo.forkSessionSubtitle' },
    'session.rollback': { title: 'sessionInfo.rollbackConversation', description: 'sessionInfo.rollbackConversationSubtitle' },
    'session.handoff': { title: 'sessionInfo.handOffSession', description: 'sessionInfo.handOffSessionSubtitle' },
};

type ActionSpecCopySource = Readonly<{ id: string; title: string; description?: string }>;

function copyKeysFor(actionId: string): ActionSpecCopyKeys | undefined {
    return ACTION_SPEC_COPY_KEYS[actionId as ActionId];
}

export function resolveActionSpecTitle(spec: ActionSpecCopySource): string {
    const keys = copyKeysFor(spec.id);
    return keys ? t(keys.title) : spec.title;
}

export function resolveActionSpecDescription(spec: ActionSpecCopySource): string | undefined {
    const keys = copyKeysFor(spec.id);
    return keys ? t(keys.description) : spec.description;
}
