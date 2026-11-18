import {
    CloudCheckIcon,
    CloudExclamationPointIcon,
    CloudIcon,
    CloudOffIcon,
    CloudSyncIcon
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    normaliseReason,
    syncSeverity,
    type SyncSeverity
} from '@/features/settings/lib/syncViewModel';
import { cn } from '@/lib/utils';
import { fetchSyncStatus } from '@/repositories/syncRepository';
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
    // A device with sync switched off never emits `syncStatusChanged`, so on a
    // fresh install the store would stay empty and this icon would never appear.
    // Read the status once on mount; the event stream takes over from there.
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        if (snapshot) {
            setLoaded(true);
            return;
        }
        let cancelled = false;
        void fetchSyncStatus()
            .then((next) => {
                if (cancelled) {
                    return;
                }
                useSyncStatusStore.getState().apply(next);
                setLoaded(true);
            })
            .catch(() => {
                if (!cancelled) {
                    setLoaded(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [snapshot]);

    // Hide only while the first read is in flight; an icon that never appears is
    // worse than one that says "sync is off".
    if (!snapshot && !loaded) {
        return null;
    }

    const inactive = !snapshot || !snapshot.enabled || !snapshot.configured;
    const health = snapshot?.collectorHealth ?? 0;
    const blockers = snapshot?.collectorBlockers ?? [];
    const reason = normaliseReason(snapshot?.collectorReason);
    const severity = syncSeverity({
        enabled: snapshot?.enabled ?? false,
        configured: snapshot?.configured ?? false,
        lastError: snapshot?.lastError ?? null,
        health: snapshot?.collectorHealth ?? null,
        reason: snapshot?.collectorReason
    });
    // Same rule as the backend election: healthy and nobody outranking us.
    const collecting =
        !inactive &&
        health > 0 &&
        blockers.length === 0 &&
        reason !== 'disabled';
    const pending = snapshot?.pendingOutbox ?? 0;

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
