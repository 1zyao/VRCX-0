import {
    CloudCogIcon,
    DatabaseIcon,
    LaptopIcon,
    RefreshCwIcon,
    SettingsIcon,
    Trash2Icon,
    XCircleIcon
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import {
    collectorRank,
    deviceHealth,
    normaliseReason,
    writingDeviceIds
} from '@/features/settings/lib/syncViewModel';
import type { SyncDeviceRecord } from '@/platform/tauri/bindings';
import {
    configureSync,
    forgetSyncDevice,
    triggerSyncNow
} from '@/repositories/syncRepository';
import { toast } from '@/services/toastService';
import { useSyncStatusStore } from '@/state/syncStatusStore';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/ui/shadcn/dialog';

import { SyncSetupWizard } from './SyncSetupWizard';

/**
 * Tools-menu view of remote sync.
 *
 * The settings tab is where sync is *configured*; this dialog is where it is
 * *observed* - the same split the offline recorder uses (status icon in the
 * status bar, details in a tools dialog). It renders the settings tab's status
 * card here so an operator sees one layout, not two.
 */
export function SyncDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const snapshot = useSyncStatusStore((state) => state.snapshot);
    const [syncing, setSyncing] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [snapshotAtMs, setSnapshotAtMs] = useState(() => Date.now());
    // Re-run setup on demand: the wizard is also the "change my database" flow,
    // so it must be reachable after the first run.
    const [forceSetup, setForceSetup] = useState(false);

    // Restart the countdown baseline whenever a fresh snapshot arrives.
    useEffect(() => {
        setSnapshotAtMs(Date.now());
    }, [snapshot]);
    useEffect(() => {
        if (!open) {
            return;
        }
        const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [open]);

    const status = snapshot;
    const devices = status?.remoteDevices ?? [];
    const writers = writingDeviceIds(devices);
    const health = status?.collectorHealth ?? 0;
    const reason = normaliseReason(status?.collectorReason);
    const blockers = status?.collectorBlockers ?? [];
    const collecting =
        !!status?.enabled &&
        !!status?.configured &&
        health > 0 &&
        blockers.length === 0 &&
        reason !== 'disabled';
    // Setup is unfinished until the backend says it has a working connection;
    // the wizard then derives which step is still missing.
    const needsSetup = forceSetup || !status || !status.configured;
    const nextSyncCountdown =
        status?.enabled && status?.nextCycleInSecs != null
            ? Math.max(
                  0,
                  Math.ceil(
                      (status.nextCycleInSecs ?? 0) -
                          (nowMs - snapshotAtMs) / 1000
                  )
              )
            : null;

    async function syncNow() {
        setSyncing(true);
        try {
            const next = await triggerSyncNow();
            useSyncStatusStore.getState().apply(next);
            toast.add({
                type: 'success',
                title: t('view.settings.sync.now_done')
            });
        } catch (error) {
            toast.add({ type: 'error', title: String(error) });
        } finally {
            setSyncing(false);
        }
    }

    async function forgetDevice(deviceId: string) {
        try {
            const next = await forgetSyncDevice(deviceId);
            useSyncStatusStore.getState().apply(next);
        } catch (error) {
            toast.add({ type: 'error', title: String(error) });
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
                <DialogHeader className="border-b px-6 py-5">
                    <DialogTitle>
                        {t('view.settings.sync.status.title')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('view.settings.sync.status.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
                    {needsSetup ? (
                        <SyncSetupWizard
                            onCancel={() => onOpenChange(false)}
                            onDone={async (input) => {
                                // Role stays `auto`: the wizard only tunes the
                                // priority, so nobody can accidentally take a
                                // device out of the election by finishing setup.
                                const next = await configureSync(input);
                                useSyncStatusStore.getState().apply(next);
                                // Kick one cycle so the first pull starts now
                                // instead of waiting for the interval timer.
                                try {
                                    const after = await triggerSyncNow();
                                    useSyncStatusStore.getState().apply(after);
                                } catch {
                                    // A failed first cycle is reported by the
                                    // panel; setup itself succeeded.
                                }
                                onOpenChange(false);
                            }}
                        />
                    ) : !status ? (
                        <p className="text-muted-foreground text-sm">
                            {t('view.settings.sync.status.unavailable')}
                        </p>
                    ) : (
                        <>
                            <section className="flex flex-col gap-3 rounded-md border px-4 py-3">
                                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                                    <Badge
                                        variant="secondary"
                                        className="gap-1.5"
                                    >
                                        <span className="size-1.5 rounded-full bg-current opacity-60" />
                                        {t(
                                            `view.settings.sync.phase.${status.phase}`
                                        )}
                                    </Badge>
                                    {status.pendingOutbox > 0 ? (
                                        <span className="flex items-center gap-1.5 text-xs text-amber-500">
                                            <DatabaseIcon className="size-3.5" />
                                            {t(
                                                'view.settings.sync.status.pending',
                                                {
                                                    count: status.pendingOutbox
                                                }
                                            )}
                                        </span>
                                    ) : null}
                                    {status.enabled &&
                                    nextSyncCountdown !== null &&
                                    status.phase !== 'running' ? (
                                        <span className="text-muted-foreground text-xs tabular-nums">
                                            {t(
                                                'view.settings.sync.status.next_sync',
                                                { secs: nextSyncCountdown }
                                            )}
                                        </span>
                                    ) : null}
                                </div>

                                <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                                    <StatusCell
                                        label={t(
                                            'view.settings.sync.status.last_cycle'
                                        )}
                                        value={formatTime(
                                            status.lastCycleAt ??
                                                status.lastPullAt ??
                                                null,
                                            i18n.language
                                        )}
                                    />
                                    <StatusCell
                                        label={t(
                                            'view.settings.sync.status.device_id'
                                        )}
                                        value={status.deviceId.slice(0, 8)}
                                    />
                                    <StatusCell
                                        label={t(
                                            'view.settings.sync.status.last_pushed'
                                        )}
                                        value={t(
                                            'view.settings.sync.status.ops_count',
                                            { count: status.lastPushedOps ?? 0 }
                                        )}
                                    />
                                    <StatusCell
                                        label={t(
                                            'view.settings.sync.status.last_pulled'
                                        )}
                                        value={t(
                                            'view.settings.sync.status.ops_count',
                                            { count: status.lastPulledOps ?? 0 }
                                        )}
                                    />
                                </div>

                                <div className="text-xs">
                                    <span className="font-medium">
                                        {collecting
                                            ? t(
                                                  'view.settings.sync.status.indicator_collecting'
                                              )
                                            : t(
                                                  'view.settings.sync.status.indicator_yielded'
                                              )}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {' · '}
                                        {t(
                                            'view.settings.sync.status.health_label'
                                        )}{' '}
                                        {health} ·{' '}
                                        {t(
                                            `view.settings.sync.status.health_${reason}`
                                        )}
                                    </span>
                                </div>
                            </section>

                            {status.lastError ? (
                                <div className="text-destructive border-destructive/30 bg-destructive/5 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                                    <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                                    <span className="break-all">
                                        {status.lastError}
                                    </span>
                                </div>
                            ) : null}

                            {devices.length > 0 ? (
                                <section className="flex flex-col gap-2">
                                    <p className="flex items-center gap-1.5 text-xs font-medium">
                                        <LaptopIcon className="size-3.5" />
                                        {t('view.settings.sync.status.devices')}
                                    </p>
                                    <ul className="flex flex-col gap-1.5">
                                        {devices.map((device) => (
                                            <DeviceRow
                                                key={device.deviceId}
                                                device={device}
                                                isSelf={
                                                    device.deviceId ===
                                                    status.deviceId
                                                }
                                                writing={writers.has(
                                                    device.deviceId
                                                )}
                                                onForget={forgetDevice}
                                            />
                                        ))}
                                    </ul>
                                </section>
                            ) : null}
                        </>
                    )}
                </div>

                {needsSetup ? null : (
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
                        <Button
                            type="button"
                            variant="ghost"
                            className="text-muted-foreground mr-auto"
                            onClick={() => setForceSetup(true)}
                        >
                            {t('view.settings.sync.setup.reconfigure')}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                onOpenChange(false);
                                navigate('/settings');
                            }}
                        >
                            <SettingsIcon className="size-3.5" />
                            {t('view.settings.sync.status.open_settings')}
                        </Button>
                        <Button
                            type="button"
                            disabled={syncing || !status?.enabled}
                            onClick={() => void syncNow()}
                        >
                            <RefreshCwIcon className="size-3.5" />
                            {syncing
                                ? t('view.settings.sync.now_running')
                                : t('view.settings.sync.status.sync_now')}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function StatusCell({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground text-sm">{label}</span>
            <span className="font-mono text-xs">{value}</span>
        </div>
    );
}

function DeviceRow({
    device,
    isSelf,
    writing,
    onForget
}: {
    device: SyncDeviceRecord;
    isSelf: boolean;
    writing: boolean;
    onForget: (deviceId: string) => void;
}) {
    const { t } = useTranslation();
    const reported = deviceHealth(device);
    const unhealthy = reported !== null && reported <= 0;
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
                {isSelf ? (
                    <CloudCogIcon className="text-primary size-3.5 shrink-0" />
                ) : (
                    <LaptopIcon className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className="truncate">
                    {device.deviceName?.trim() || device.deviceId.slice(0, 8)}
                </span>
                {isSelf ? (
                    <Badge
                        variant="secondary"
                        className="h-4 px-1.5 text-[10px]"
                    >
                        {t('view.settings.sync.status.this_device_tag')}
                    </Badge>
                ) : null}
                {writing ? (
                    <Badge className="h-4 px-1.5 text-[10px]">
                        {t('view.settings.sync.status.writing_tag')}
                    </Badge>
                ) : null}
            </span>
            <span className="text-muted-foreground shrink-0 font-mono">
                {device.ipAddr || '—'}
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px] uppercase">
                {device.role} ·P{collectorRank(device)}
            </span>
            <Badge
                variant={unhealthy ? 'destructive' : 'secondary'}
                className="h-4 px-1.5 text-[10px]"
            >
                {t('view.settings.sync.status.health_label')}{' '}
                {reported === null ? '—' : reported}
            </Badge>
            {!device.online ? null : unhealthy ? (
                <span className="text-destructive shrink-0 text-[10px]">
                    {t(
                        `view.settings.sync.status.health_${normaliseReason(device.healthReason)}`
                    )}
                </span>
            ) : !writing ? (
                <span className="text-muted-foreground shrink-0 text-[10px]">
                    {t('view.settings.sync.status.health_yielded')}
                </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-3">
                <span className="text-muted-foreground">
                    {device.appVersion || '—'}
                </span>
                {isSelf ? null : <DeviceSeenLabel device={device} />}
                {!device.online && !isSelf ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-6"
                        title={t('view.settings.sync.status.forget_device')}
                        onClick={() => onForget(device.deviceId)}
                    >
                        <Trash2Icon className="size-3.5" />
                    </Button>
                ) : null}
                {device.online ? (
                    <Badge
                        variant="secondary"
                        className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    >
                        {t('view.settings.sync.status.device_online')}
                    </Badge>
                ) : (
                    <Badge
                        variant="secondary"
                        className="text-muted-foreground/70 bg-muted/40"
                    >
                        {t('view.settings.sync.status.device_offline')}
                    </Badge>
                )}
            </span>
        </li>
    );
}

function DeviceSeenLabel({ device }: { device: SyncDeviceRecord }) {
    const { t, i18n } = useTranslation();
    const seconds = device.seenSecondsAgo ?? 0;
    let label: string;
    if (seconds > 0 && seconds < 60) {
        label = t('view.settings.sync.status.seen_seconds_ago', {
            count: seconds
        });
    } else if (seconds > 0 && seconds < 3600) {
        label = t('view.settings.sync.status.seen_minutes_ago', {
            count: Math.floor(seconds / 60)
        });
    } else {
        label = formatTime(device.lastSeenAt, i18n.language);
    }
    return (
        <span
            className="text-muted-foreground tabular-nums"
            title={t('view.settings.sync.status.device_last_seen')}
        >
            {label}
        </span>
    );
}

function formatTime(
    value: string | null | undefined,
    language: string
): string {
    if (!value) {
        return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString(language, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}
