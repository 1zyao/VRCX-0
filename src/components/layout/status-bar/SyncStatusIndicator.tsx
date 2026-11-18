import {
    CloudCheckIcon,
    CloudExclamationPointIcon,
    CloudIcon,
    CloudOffIcon,
    CloudSyncIcon
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
    normaliseReason,
    syncSeverity,
    type SyncSeverity
} from '@/features/settings/lib/syncViewModel';
import { cn } from '@/lib/utils';
import { useRuntimeStore } from '@/state/runtimeStore';
import { useSyncStatusStore } from '@/state/syncStatusStore';
import { Button } from '@/ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';

/**
 * Status-bar entry for remote sync.
 *
 * Mirrors the offline-recorder indicator: one icon whose glyph and colour carry
 * the verdict, a tooltip with the sentence behind it, and a click that opens the
 * details. Severity comes from `syncViewModel`, so this icon, the settings tab
 * and the tools dialog cannot disagree about what the backend decided.
 *
 * Colour semantics:
 *   muted        normal - collecting, yielding, or sync simply off
 *   askme/orange trouble that usually recovers by itself
 *   busy/red     needs the user: session expired, repeated failures, last error
 */
const LEVEL_CLASS: Record<SyncSeverity, string> = {
    ok: 'text-muted-foreground hover:text-muted-foreground',
    warning: 'text-[var(--status-askme)] hover:text-[var(--status-askme)]',
    error: 'text-[var(--status-busy)] hover:text-[var(--status-busy)]'
};

export function SyncStatusIndicator() {
    const { t } = useTranslation();
    const snapshot = useSyncStatusStore((state) => state.snapshot);
    const setSystemHostOpen = useRuntimeStore(
        (state) => state.setSystemHostOpen
    );

    // Nothing to say before the first status read: an icon claiming "disabled"
    // would be a guess, and a wrong guess here is worse than a blank slot.
    if (!snapshot) {
        return null;
    }

    const inactive = !snapshot.enabled || !snapshot.configured;
    const health = snapshot.collectorHealth ?? 0;
    const blockers = snapshot.collectorBlockers ?? [];
    const reason = normaliseReason(snapshot.collectorReason);
    const severity = syncSeverity({
        enabled: snapshot.enabled,
        configured: snapshot.configured,
        lastError: snapshot.lastError,
        health: snapshot.collectorHealth ?? null,
        reason: snapshot.collectorReason
    });
    // Same rule as the backend election: healthy and nobody outranking us.
    const collecting =
        !inactive &&
        health > 0 &&
        blockers.length === 0 &&
        reason !== 'disabled';
    const pending = snapshot.pendingOutbox ?? 0;

    let Icon = CloudIcon;
    if (inactive) {
        Icon = CloudOffIcon;
    } else if (severity !== 'ok') {
        Icon = CloudExclamationPointIcon;
    } else if (collecting) {
        Icon = CloudCheckIcon;
    } else {
        Icon = CloudIcon;
    }
    // Data still waiting to be pushed is worth showing even when healthy.
    if (!inactive && pending > 0) {
        Icon = CloudSyncIcon;
    }

    const detail = inactive
        ? t('view.settings.sync.status.indicator_off')
        : severity !== 'ok'
          ? t(`view.settings.sync.status.health_${reason}`)
          : collecting
            ? t('view.settings.sync.status.indicator_collecting')
            : t('view.settings.sync.status.indicator_yielded');

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('view.settings.category.sync')}
                        className={cn(
                            'size-6 shrink-0 rounded-none',
                            LEVEL_CLASS[severity]
                        )}
                        onClick={() => setSystemHostOpen('syncOpen', true)}
                    >
                        <Icon />
                    </Button>
                }
            />
            <TooltipContent className="flex max-w-xs flex-col gap-1 text-xs">
                <span>{t('view.settings.category.sync')}</span>
                <span className="text-muted-foreground">{detail}</span>
                {!inactive ? (
                    <span className="text-muted-foreground">
                        {t('view.settings.sync.status.health_label')} {health}
                        {pending > 0
                            ? ` · ${t('view.settings.sync.status.pending_outbox', { count: pending })}`
                            : null}
                    </span>
                ) : null}
            </TooltipContent>
        </Tooltip>
    );
}
