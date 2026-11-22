/**
 * The device fields this module needs. Declared structurally instead of
 * importing the generated binding: shared/domain code must not depend on higher
 * frontend layers (oxlint enforces that), and these helpers only read a few
 * fields.
 */
export type SyncDeviceLike = {
    deviceId: string;
    role?: string;
    priority?: number;
    health?: number;
    healthReason?: string;
    online?: boolean;
    lastSeenAt?: string | null;
    appVersion?: string;
    deviceName?: string;
};

/**
 * Shared view-model helpers for everything that renders sync state.
 *
 * Both the settings tab and the tools dialog show the same device list and the
 * same "who is writing" answer, so those rules live here instead of being
 * copied into each component - the Rust election already treats health and
 * priority in a specific way, and a second implementation would drift.
 */

/** Effective election rank: a legacy `forced` row ranks above any number. */
export function collectorRank(device: {
    role?: string;
    priority?: number;
}): number {
    return device.role === 'forced' && !device.priority
        ? 1000
        : (device.priority ?? 0);
}

/**
 * Health score a device advertised, or `null` when it never reported one.
 *
 * Only a build with the health tracker fills `healthReason`, so that field is
 * the reliable "did it measure anything" signal. Showing 100 for a device that
 * never measured itself would claim something we do not know; unknown is
 * treated as healthy for the ranking (fail-open, same as the Rust election).
 */
export function deviceHealth(device: {
    health?: number;
    healthReason?: string;
}): number | null {
    return device.healthReason && device.healthReason.trim()
        ? (device.health ?? 0)
        : null;
}

/** Unknown health counts as healthy: fail-open, like the backend. */
export function deviceHealthy(device: {
    health?: number;
    healthReason?: string;
}): boolean {
    const health = deviceHealth(device);
    return health === null || health > 0;
}

/**
 * Devices that may record live feed right now, ranked so the first one is the
 * writer. Mirrors `collector_election::may_collect`: online, healthy, then
 * priority desc, then the smaller device id wins ties.
 */
export function rankFeedWriters(
    devices: SyncDeviceLike[]
): SyncDeviceLike[] {
    return devices
        .filter((device) => device.online && deviceHealthy(device))
        .sort(
            (a, b) =>
                collectorRank(b) - collectorRank(a) ||
                a.deviceId.localeCompare(b.deviceId)
        );
}

/** Device ids the UI should badge as "writing now" (at most one). */
export function writingDeviceIds(devices: SyncDeviceLike[]): Set<string> {
    const [writer] = rankFeedWriters(devices);
    return new Set(writer ? [writer.deviceId] : []);
}

/** Stable machine reasons the backend writes into `sync.collectorReason`. */
export const COLLECTOR_REASONS = [
    'healthy',
    // Why this device cannot record right now. Missing these from the list made
    // `normaliseReason` fall back to 'healthy', so an un-logged-in device showed
    // "health 0" next to the label "OK".
    'notLoggedIn',
    'disconnected',
    'websocketUnstable',
    'authExpired',
    'syncFailing',
    'recovering',
    'disabled',
    'yielded'
] as const;

export type CollectorReason = (typeof COLLECTOR_REASONS)[number];

/** Narrow an arbitrary reason string to a known key (falls back to healthy). */
export function normaliseReason(reason?: string | null): CollectorReason {
    const key = (reason ?? '').trim();
    return (COLLECTOR_REASONS as readonly string[]).includes(key)
        ? (key as CollectorReason)
        : 'healthy';
}

/** Three-state severity used for colours in the status bar and headers. */
export type SyncSeverity = 'ok' | 'warning' | 'error';

/**
 * Severity of this device's own sync state.
 *
 * `ok` is the everyday case (collecting or yielding), `warning` is a state that
 * usually recovers by itself, `error` needs the user (session expired, repeated
 * failures, or an explicit error from the last cycle).
 */
export function syncSeverity(input: {
    enabled: boolean;
    configured: boolean;
    lastError?: string | null;
    health?: number | null;
    reason?: string | null;
}): SyncSeverity {
    if (!input.enabled || !input.configured) {
        return 'ok';
    }
    if (input.lastError && input.lastError.trim()) {
        return 'error';
    }
    if (
        input.health !== null &&
        input.health !== undefined &&
        input.health <= 0
    ) {
        const reason = normaliseReason(input.reason);
        if (reason === 'authExpired' || reason === 'syncFailing') {
            return 'error';
        }
        return 'warning';
    }
    const reason = normaliseReason(input.reason);
    if (
        reason === 'websocketUnstable' ||
        reason === 'recovering' ||
        reason === 'notLoggedIn' ||
        reason === 'disconnected'
    ) {
        return 'warning';
    }
    return 'ok';
}
