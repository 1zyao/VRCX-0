import { DatabaseIcon, HardDriveIcon, Loader2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
    SyncConnectionFields,
    SyncConnectionTestResult
} from '@/platform/tauri/bindings';
import {
    fetchSyncConnection,
    testSyncConnection,
    type SyncConfigureInput
} from '@/repositories/syncRepository';
import { getProfileBackupSettings } from '@/services/profileBackupService';
import { useRuntimeStore } from '@/state/runtimeStore';
import { Button } from '@/ui/shadcn/button';
import { Field, FieldLabel } from '@/ui/shadcn/field';
import { Input } from '@/ui/shadcn/input';

import { isAutomaticBackupReady } from '../offline-record/offlineRecordModel';

/**
 * First-run setup for remote sync, shaped like the offline recorder's wizard:
 * the step is derived from what is still missing rather than from a manual
 * next/back stack, so reopening the dialog always lands where the gap is.
 *
 *   1. automatic backup   - synced rows land in the local database
 *   2. database           - connection fields; "test" must pass to continue
 *   3. identity           - collector priority, then save and enable
 */
export type SyncSetupStep = 1 | 2 | 3;

export const SYNC_SETUP_STEPS = 3;

export function resolveSyncSetupStep(input: {
    backupReady: boolean;
    host: string;
}): SyncSetupStep {
    if (!input.backupReady) {
        return 1;
    }
    if (!input.host.trim()) {
        return 2;
    }
    return 3;
}

export function SyncSetupWizard({
    onDone,
    onCancel
}: {
    onDone: (input: SyncConfigureInput & { enabled: boolean }) => Promise<void>;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const setSystemHostOpen = useRuntimeStore(
        (state) => state.setSystemHostOpen
    );
    const [backupReady, setBackupReady] = useState(false);
    const [connection, setConnection] = useState<SyncConnectionFields | null>(
        null
    );
    const [form, setForm] = useState({
        host: '',
        port: '5432',
        database: '',
        user: '',
        password: '',
        allowPlaintext: false
    });
    const [priority, setPriority] = useState('0');
    const [testResult, setTestResult] =
        useState<SyncConnectionTestResult | null>(null);
    const [testedSignature, setTestedSignature] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [step, setStep] = useState<SyncSetupStep>(1);

    const load = useCallback(async () => {
        const [fields, backup] = await Promise.all([
            fetchSyncConnection().catch(() => null),
            getProfileBackupSettings().catch(() => null)
        ]);
        const ready = isAutomaticBackupReady(backup);
        setBackupReady(ready);
        setConnection(fields);
        if (fields) {
            setForm({
                host: fields.host ?? '',
                port: String(fields.port ?? 5432),
                database: fields.database ?? '',
                user: fields.user ?? '',
                password: '',
                allowPlaintext: fields.allowPlaintext ?? false
            });
            setPriority(String(fields.collectorPriority ?? 0));
        }
        setStep(
            resolveSyncSetupStep({
                backupReady: ready,
                host: fields?.host ?? ''
            })
        );
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const signature = `${form.host}|${form.port}|${form.database}|${form.user}|${form.password}`;
    const testIsCurrent =
        testResult?.ok === true && testedSignature === signature;

    async function runTest() {
        setBusy(true);
        setError('');
        try {
            const result = await testSyncConnection({
                host: form.host.trim(),
                port: Number(form.port) || 5432,
                database: form.database.trim(),
                user: form.user.trim(),
                password: form.password || undefined,
                allowPlaintext: form.allowPlaintext
            });
            setTestResult(result);
            setTestedSignature(signature);
            if (!result.ok && result.error) {
                setError(result.error);
            }
        } catch (failure) {
            setError(String(failure));
            setTestResult(null);
        } finally {
            setBusy(false);
        }
    }

    async function finish() {
        setBusy(true);
        setError('');
        try {
            await onDone({
                enabled: true,
                connection: {
                    host: form.host.trim(),
                    port: Number(form.port) || 5432,
                    database: form.database.trim(),
                    user: form.user.trim(),
                    password: form.password || undefined,
                    allowPlaintext: form.allowPlaintext
                },
                collectorPriority: Math.min(
                    100,
                    Math.max(0, Number(priority) || 0)
                )
            });
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(false);
        }
    }

    const canLeaveStep1 = backupReady;
    const canLeaveStep2 =
        testIsCurrent &&
        form.host.trim() !== '' &&
        form.database.trim() !== '' &&
        form.user.trim() !== '';

    return (
        <div className="flex flex-col gap-5">
            <SetupProgress step={step} />

            {step === 1 ? (
                <StepFrame
                    title={t('view.settings.sync.setup.backup_title')}
                    description={t(
                        'view.settings.sync.setup.backup_description'
                    )}
                    actions={
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                    setSystemHostOpen('profileBackupOpen', true)
                                }
                            >
                                {t('view.settings.sync.setup.open_backup')}
                            </Button>
                            <Button
                                type="button"
                                disabled={!canLeaveStep1}
                                onClick={() => setStep(2)}
                            >
                                {t('view.settings.sync.setup.next')}
                            </Button>
                        </>
                    }
                />
            ) : null}

            {step === 2 ? (
                <StepFrame
                    title={t('view.settings.sync.setup.database_title')}
                    description={t(
                        'view.settings.sync.setup.database_description'
                    )}
                    actions={
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setStep(1)}
                            >
                                {t('view.settings.sync.setup.back')}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                    busy ||
                                    !form.host.trim() ||
                                    !form.database.trim()
                                }
                                onClick={() => void runTest()}
                            >
                                {busy ? (
                                    <Loader2Icon className="size-3.5 animate-spin" />
                                ) : (
                                    <DatabaseIcon className="size-3.5" />
                                )}
                                {t('view.settings.sync.setup.test')}
                            </Button>
                            <Button
                                type="button"
                                disabled={!canLeaveStep2}
                                onClick={() => setStep(3)}
                            >
                                {t('view.settings.sync.setup.next')}
                            </Button>
                        </>
                    }
                >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field className="sm:col-span-2">
                            <FieldLabel htmlFor="sync-host">
                                {t('view.settings.sync.connection.host_label')}
                            </FieldLabel>
                            <Input
                                id="sync-host"
                                value={form.host}
                                placeholder="192.168.1.10 或 db.example.com"
                                onChange={(event) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        host: event.target.value
                                    }))
                                }
                            />
                        </Field>
                        <Field className="sm:col-span-2">
                            <FieldLabel htmlFor="sync-port">
                                {t('view.settings.sync.connection.port_label')}
                            </FieldLabel>
                            <Input
                                id="sync-port"
                                value={form.port}
                                inputMode="numeric"
                                onChange={(event) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        port: event.target.value
                                            .replace(/\D/g, '')
                                            .slice(0, 5)
                                    }))
                                }
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="sync-database">
                                {t(
                                    'view.settings.sync.connection.database_label'
                                )}
                            </FieldLabel>
                            <Input
                                id="sync-database"
                                value={form.database}
                                onChange={(event) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        database: event.target.value
                                    }))
                                }
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="sync-user">
                                {t('view.settings.sync.connection.user_label')}
                            </FieldLabel>
                            <Input
                                id="sync-user"
                                value={form.user}
                                onChange={(event) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        user: event.target.value
                                    }))
                                }
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="sync-password">
                                {t(
                                    'view.settings.sync.connection.password_label'
                                )}
                            </FieldLabel>
                            <Input
                                id="sync-password"
                                type="password"
                                value={form.password}
                                placeholder={
                                    connection?.hasPassword
                                        ? t(
                                              'view.settings.sync.connection.password_saved'
                                          )
                                        : ''
                                }
                                onChange={(event) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        password: event.target.value
                                    }))
                                }
                            />
                        </Field>
                    </div>

                    <p className="text-muted-foreground text-xs">
                        {testIsCurrent
                            ? t('view.settings.sync.setup.test_ok', {
                                  version: testResult?.serverVersion ?? '',
                                  latency: testResult?.latencyMs ?? 0
                              })
                            : t('view.settings.sync.setup.test_required')}
                    </p>
                    {error ? (
                        <p className="text-destructive text-xs leading-relaxed">
                            {error}
                        </p>
                    ) : null}
                </StepFrame>
            ) : null}

            {step === 3 ? (
                <StepFrame
                    title={t('view.settings.sync.setup.identity_title')}
                    description={t(
                        'view.settings.sync.setup.identity_description'
                    )}
                    actions={
                        <>
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-muted-foreground"
                                disabled={busy}
                                onClick={onCancel}
                            >
                                {t('view.settings.sync.setup.later')}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setStep(2)}
                            >
                                {t('view.settings.sync.setup.back')}
                            </Button>
                            <Button
                                type="button"
                                disabled={busy}
                                onClick={() => void finish()}
                            >
                                {busy ? (
                                    <Loader2Icon className="size-3.5 animate-spin" />
                                ) : (
                                    <HardDriveIcon className="size-3.5" />
                                )}
                                {t('view.settings.sync.setup.finish')}
                            </Button>
                        </>
                    }
                >
                    <Field className="max-w-40">
                        <FieldLabel htmlFor="sync-priority">
                            {t('view.settings.sync.connection.priority_label')}
                        </FieldLabel>
                        <Input
                            id="sync-priority"
                            value={priority}
                            inputMode="numeric"
                            onChange={(event) =>
                                setPriority(
                                    event.target.value
                                        .replace(/\D/g, '')
                                        .slice(0, 3)
                                )
                            }
                        />
                    </Field>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                        {t('view.settings.sync.connection.priority_hint')}
                    </p>
                    {error ? (
                        <p className="text-destructive text-xs leading-relaxed">
                            {error}
                        </p>
                    ) : null}
                </StepFrame>
            ) : null}
        </div>
    );
}

function SetupProgress({ step }: { step: SyncSetupStep }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">
                {t('view.settings.sync.setup.progress', {
                    current: step,
                    total: SYNC_SETUP_STEPS
                })}
            </span>
            <div
                className="flex gap-1.5"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={SYNC_SETUP_STEPS}
                aria-valuenow={step}
            >
                {Array.from({ length: SYNC_SETUP_STEPS }, (_, index) => (
                    <span
                        key={index}
                        className={
                            index < step
                                ? 'bg-primary h-0.5 flex-1 rounded-full'
                                : 'bg-muted h-0.5 flex-1 rounded-full'
                        }
                    />
                ))}
            </div>
        </div>
    );
}

function StepFrame({
    title,
    description,
    children,
    actions
}: {
    title: string;
    description: string;
    children?: React.ReactNode;
    actions: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
                <h3 className="text-base font-medium">{title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                    {description}
                </p>
            </div>
            {children}
            <div className="flex flex-wrap justify-end gap-2">{actions}</div>
        </section>
    );
}
