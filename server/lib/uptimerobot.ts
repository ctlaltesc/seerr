import UptimeRobotAPI, {
  UPTIMEROBOT_STATUS,
  type UptimeRobotMonitor,
} from '@server/api/uptimerobot';
import { getRepository } from '@server/datasource';
import { ProblemReport } from '@server/entity/ProblemReport';
import { User } from '@server/entity/User';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import {
  getSettings,
  type UptimeRobotManualStatus,
  type UptimeRobotMonitorOverride,
} from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull } from 'typeorm';
import webpush from 'web-push';

export interface MonitorSummary {
  id: number;
  /** Display name — admin override if set, otherwise UptimeRobot's friendly_name. */
  name: string;
  /** UptimeRobot's friendly_name, untouched. Useful for the admin UI. */
  defaultName: string;
  /** Optional description set by the admin. */
  description?: string;
  /** Admin-controlled URL — empty string when the admin checked "hide URL". */
  url: string;
  type: number;
  /** Normalised status: 'up' | 'down' | 'paused' | 'unknown'. Reflects manual override when active. */
  status: 'up' | 'down' | 'paused' | 'unknown';
  /** UptimeRobot's raw status code, retained for richer UI. */
  rawStatus: number;
  /** Admin override flags. Always sent to the admin UI; stripped from public callers. */
  hideUrl?: boolean;
  hidden?: boolean;
  /**
   * When set, the admin manually pinned this monitor to one of the public
   * statuses ("operational" / "maintenance" / etc) until `manualStatusUntil`.
   * `status` above already reflects this override; `manualStatus` is sent
   * along so clients can render a more specific label.
   */
  manualStatus?: UptimeRobotManualStatus;
  /** Epoch ms after which the manual status is ignored. */
  manualStatusUntil?: number;
  /**
   * When true, the monitor is excluded from the user-facing report modal.
   * Surfaced on both scopes so the public client can filter the modal
   * locally; the server still re-validates on POST /reports.
   */
  hideFromReports?: boolean;
}

/**
 * Map an admin-pinned manual status onto the simpler `up | down | paused | unknown`
 * vocabulary used by the existing UI. Operational = up, maintenance = paused
 * (so it doesn't trigger the "is it down" UI), all the others are some flavour
 * of down.
 */
const manualStatusToNormalized = (
  status: UptimeRobotManualStatus
): 'up' | 'down' | 'paused' | 'unknown' => {
  switch (status) {
    case 'operational':
      return 'up';
    case 'maintenance':
      return 'paused';
    case 'degraded':
    case 'partial_outage':
    case 'major_outage':
      return 'down';
    default:
      return 'unknown';
  }
};

interface MonitorRecoveryState {
  /** Wall-clock ms when the monitor was last observed as DOWN. */
  lastDownAt?: number;
  /** Wall-clock ms when the monitor most recently transitioned to UP. */
  upSince?: number;
}

const normalizeStatus = (
  status: number
): 'up' | 'down' | 'paused' | 'unknown' => {
  if (status === UPTIMEROBOT_STATUS.UP) return 'up';
  if (
    status === UPTIMEROBOT_STATUS.DOWN ||
    status === UPTIMEROBOT_STATUS.SEEMS_DOWN
  )
    return 'down';
  if (status === UPTIMEROBOT_STATUS.PAUSED) return 'paused';
  return 'unknown';
};

class UptimeRobotService {
  private latest: MonitorSummary[] = [];
  private lastFetched = 0;
  private fetchError: string | undefined;
  private polling = false;
  private recoveryStates = new Map<number, MonitorRecoveryState>();
  /**
   * Wall-clock ms when we most recently observed at least one monitor in
   * a non-up state. `undefined` means we have never seen a downtime in
   * the lifetime of this process — the "all healthy for X hours" rule
   * for announcement expiry treats that case as "we don't know yet" and
   * falls back to the hard 72h cap.
   */
  private lastAnythingDownAt: number | undefined;

  /**
   * Returns the wall-clock ms timestamp of the most recent non-up
   * observation. Used by the announcement-expiry rule.
   */
  public getLastDowntime(): number | undefined {
    return this.lastAnythingDownAt;
  }

  /**
   * Returns the wall-clock ms timestamp of the most recent observation in
   * which the given monitor was reported DOWN. Returns `undefined` when
   * the monitor has never been observed down in this process's lifetime.
   * Used by the problem-report auto-resolve rule.
   */
  public getMonitorLastDown(monitorId: number): number | undefined {
    return this.recoveryStates.get(monitorId)?.lastDownAt;
  }

  /**
   * Returns the most recently fetched monitor list, ordered according to
   * the admin's configured `monitorOrder` (with any unranked monitors
   * appended at the end in their API order) and with admin overrides
   * (display name, description, hideUrl, hidden) applied.
   *
   * @param scope `'admin'` returns every monitor including hidden ones, with
   *              the URL preserved so admins can re-enable it. `'public'`
   *              drops hidden monitors and blanks the URL when `hideUrl` is
   *              set.
   */
  public getMonitors(scope: 'admin' | 'public' = 'public'): MonitorSummary[] {
    const settings = getSettings().uptimerobot;
    const overrideById = new Map<number, UptimeRobotMonitorOverride>();
    for (const override of settings.monitorOverrides ?? []) {
      if (Number.isFinite(override.id)) {
        overrideById.set(override.id, override);
      }
    }

    const now = Date.now();
    const enriched = this.latest
      .map((m) => {
        const override = overrideById.get(m.id);
        const hideUrl = override?.hideUrl === true;
        const hidden = override?.hidden === true;
        const hideFromReports = override?.hideFromReports === true;

        const manualActive =
          !!override?.manualStatus &&
          typeof override.manualStatusUntil === 'number' &&
          override.manualStatusUntil > now;

        const manualStatus = manualActive ? override?.manualStatus : undefined;
        const manualStatusUntil = manualActive
          ? override?.manualStatusUntil
          : undefined;

        return {
          ...m,
          name: override?.name?.trim() || m.defaultName,
          description: override?.description?.trim() || undefined,
          hideUrl,
          hidden,
          hideFromReports,
          url: scope === 'public' && hideUrl ? '' : m.url,
          status: manualStatus
            ? manualStatusToNormalized(manualStatus)
            : m.status,
          manualStatus,
          manualStatusUntil,
        };
      })
      .filter((m) => (scope === 'public' ? !m.hidden : true));

    const order = settings.monitorOrder ?? [];
    if (order.length) {
      const indexById = new Map<number, number>();
      order.forEach((id, idx) => indexById.set(id, idx));

      enriched.sort((a, b) => {
        const ai = indexById.has(a.id) ? indexById.get(a.id)! : Infinity;
        const bi = indexById.has(b.id) ? indexById.get(b.id)! : Infinity;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
    }
    return enriched;
  }

  public getStatus(scope: 'admin' | 'public' = 'public') {
    return {
      configured: getSettings().uptimerobot.enabled,
      monitors: this.getMonitors(scope),
      lastFetched: this.lastFetched,
      fetchError: this.fetchError,
    };
  }

  public hasFetchedAtLeastOnce(): boolean {
    return this.lastFetched > 0;
  }

  /**
   * Validate the given API key by issuing a getMonitors request.
   */
  public async testApiKey(apiKey: string): Promise<UptimeRobotMonitor[]> {
    if (!apiKey) {
      throw new Error('Missing UptimeRobot API key');
    }
    const api = new UptimeRobotAPI(apiKey);
    return api.getMonitors();
  }

  /**
   * Poll UptimeRobot, update the in-memory cache, and dispatch any due
   * recovery notifications. Safe to call concurrently — the second call
   * becomes a no-op.
   */
  public async poll(): Promise<void> {
    if (this.polling) return;
    const settings = getSettings().uptimerobot;
    if (!settings.enabled || !settings.apiKey) {
      this.latest = [];
      this.fetchError = undefined;
      return;
    }

    this.polling = true;
    try {
      const api = new UptimeRobotAPI(settings.apiKey);
      const monitors = await api.getMonitors();
      const summaries: MonitorSummary[] = monitors.map((m) => ({
        id: m.id,
        name: m.friendly_name,
        defaultName: m.friendly_name,
        url: m.url,
        type: m.type,
        status: normalizeStatus(m.status),
        rawStatus: m.status,
      }));

      this.latest = summaries;
      this.lastFetched = Date.now();
      this.fetchError = undefined;

      // Track the last time anything was non-up so the announcement-expiry
      // rule can decide whether the system has been "all healthy for N hours".
      if (summaries.some((m) => m.status === 'down')) {
        this.lastAnythingDownAt = this.lastFetched;
      }

      await this.processRecoveries(summaries, settings);
    } catch (e) {
      this.fetchError = (e as Error).message;
      logger.error('Failed to poll UptimeRobot', {
        label: 'UptimeRobot',
        errorMessage: this.fetchError,
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Detect monitors that have stayed UP long enough since recovery and
   * dispatch a web push notification to anybody who clicked "Notify me
   * when it's back up".
   */
  private async processRecoveries(
    summaries: MonitorSummary[],
    settings: ReturnType<typeof getSettings>['uptimerobot']
  ): Promise<void> {
    const now = Date.now();
    const stableMs = Math.max(0, settings.recoveryStableMinutes) * 60 * 1000;

    // Track per-monitor recovery state across polls.
    const seen = new Set<number>();
    for (const monitor of summaries) {
      seen.add(monitor.id);
      const state = this.recoveryStates.get(monitor.id) ?? {};

      const wasDown = !!state.lastDownAt && !state.upSince;

      if (monitor.status === 'down') {
        state.lastDownAt = now;
        state.upSince = undefined;
      } else if (monitor.status === 'up') {
        if (state.lastDownAt && !state.upSince) {
          state.upSince = now;
        }
      } else {
        // paused / unknown — leave any pending recovery alone.
      }

      this.recoveryStates.set(monitor.id, state);

      // First poll where the monitor flipped from down to up: clear any
      // active user-reports right away so people stop seeing stale "X
      // others reporting" badges. Independent of the recovery-stable
      // window — if the service is back up we always want to wipe the
      // reports.
      if (wasDown && monitor.status === 'up') {
        await this.clearActiveReportsForMonitor(monitor.id).catch((e) => {
          logger.warn('Failed to clear active reports on recovery', {
            label: 'UptimeRobot',
            monitorId: monitor.id,
            errorMessage: (e as Error).message,
          });
        });
      }

      if (!settings.recoveryNotificationsEnabled) continue;
      if (monitor.status !== 'up') continue;
      if (!state.lastDownAt || !state.upSince) continue;
      if (now - state.upSince < stableMs) continue;

      try {
        await this.dispatchRecoveryNotifications(monitor);
      } catch (e) {
        logger.error('Failed to dispatch monitor recovery notifications', {
          label: 'UptimeRobot',
          monitorId: monitor.id,
          monitorName: monitor.name,
          errorMessage: (e as Error).message,
        });
      }

      // Reset state for this monitor so we don't re-notify until the next
      // down/up cycle.
      this.recoveryStates.set(monitor.id, {});
    }

    // Drop state for monitors that no longer exist in UptimeRobot.
    for (const id of [...this.recoveryStates.keys()]) {
      if (!seen.has(id)) this.recoveryStates.delete(id);
    }
  }

  private async dispatchRecoveryNotifications(
    monitor: MonitorSummary
  ): Promise<void> {
    const settings = getSettings();
    const subRepo = getRepository(UserMonitorRecoverySubscription);
    const subscriptions = await subRepo.find({
      where: { monitorId: monitor.id },
      relations: { user: true },
    });

    if (!subscriptions.length) return;

    if (!settings.vapidPublic || !settings.vapidPrivate) {
      logger.warn(
        'Skipping monitor recovery notifications because web push is not configured',
        { label: 'UptimeRobot', monitorId: monitor.id }
      );
      return;
    }

    const userRepo = getRepository(User);
    const owner = await userRepo.findOne({ where: { id: 1 } });
    if (!owner) {
      logger.warn(
        'Skipping monitor recovery notifications because the owner user is missing',
        { label: 'UptimeRobot', monitorId: monitor.id }
      );
      return;
    }

    webpush.setVapidDetails(
      `mailto:${owner.email}`,
      settings.vapidPublic,
      settings.vapidPrivate
    );

    const userIds = [...new Set(subscriptions.map((s) => s.user.id))];
    const pushRepo = getRepository(UserPushSubscription);
    const pushSubs = userIds.length
      ? await pushRepo
          .createQueryBuilder('pushSub')
          .leftJoinAndSelect('pushSub.user', 'user')
          .where('pushSub.userId IN (:...users)', { users: userIds })
          .getMany()
      : [];

    // Use the admin-overridden display name and description so the push
    // matches what users see in the UI.
    const override = settings.uptimerobot.monitorOverrides?.find(
      (o) => o.id === monitor.id
    );
    const displayName = override?.name?.trim() || monitor.defaultName;
    const description = override?.description?.trim();

    const payload = Buffer.from(
      JSON.stringify({
        notificationType: 'MONITOR_RECOVERED',
        subject: `${displayName} is back online`,
        message:
          description ?? 'The service is back up. Thanks for your patience!',
        actionUrl: '/status',
        actionUrlTitle: 'View Status',
      }),
      'utf-8'
    );

    let sent = 0;
    let failed = 0;

    await Promise.all(
      pushSubs.map(async (pushSub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: pushSub.endpoint,
              keys: { auth: pushSub.auth, p256dh: pushSub.p256dh },
            },
            payload
          );
          sent++;
        } catch (e) {
          failed++;
          const err = e as { statusCode?: number; status?: number };
          const code = err.statusCode ?? err.status;
          if (code === 410 || code === 404) {
            await pushRepo.remove(pushSub);
          }
        }
      })
    );

    logger.info('Dispatched monitor recovery notifications', {
      label: 'UptimeRobot',
      monitorId: monitor.id,
      monitorName: displayName,
      recipients: userIds.length,
      sent,
      failed,
    });

    // Consume the recovery subscriptions — they are one-shot.
    await subRepo.remove(subscriptions);
  }

  /**
   * Mark every active problem report for the given monitor as resolved.
   * Returns the number of rows that were just resolved (0 when none).
   */
  public async clearActiveReportsForMonitor(
    monitorId: number
  ): Promise<number> {
    const repo = getRepository(ProblemReport);
    const rows = await repo.find({
      where: { monitorId, resolvedAt: IsNull() },
    });
    if (!rows.length) return 0;
    const resolvedAt = new Date();
    await repo.save(rows.map((r) => Object.assign(r, { resolvedAt })));
    return rows.length;
  }

  /**
   * Prime the recovery state for a monitor at subscription time so that
   * users who tap "Notify me" still get alerted even if the service
   * never observed the monitor as down (e.g. process restarted between
   * the down event and the user subscribing). No-op when the monitor is
   * currently observed up — there's nothing to recover from.
   */
  public primeRecovery(monitorId: number): void {
    const monitor = this.latest.find((m) => m.id === monitorId);
    if (!monitor) return;
    if (monitor.status === 'up') return;
    const state = this.recoveryStates.get(monitorId) ?? {};
    if (!state.lastDownAt) {
      state.lastDownAt = Date.now();
      state.upSince = undefined;
      this.recoveryStates.set(monitorId, state);
    }
  }

  /**
   * Dispatch the recovery web push for a single monitor right now, without
   * waiting for the natural recovery-stable window. Called from the
   * `/uptimerobot/override` route when an admin pins the monitor back to
   * `operational`. Report-clearing is the route's responsibility (it
   * awaits `clearActiveReportsForMonitor` directly) — this method only
   * handles the push side.
   */
  public async fireManualRecovery(monitorId: number): Promise<void> {
    const monitor = this.latest.find((m) => m.id === monitorId);
    if (!monitor) return;

    // Reset recovery state — the override is the source of truth now.
    this.recoveryStates.set(monitorId, {});

    try {
      await this.dispatchRecoveryNotifications({
        ...monitor,
        // Force "up" semantics so the dispatch payload reads naturally.
        status: 'up',
      });
    } catch (e) {
      logger.error('Failed to dispatch manual recovery notifications', {
        label: 'UptimeRobot',
        monitorId,
        errorMessage: (e as Error).message,
      });
    }
  }
}

const uptimeRobotService = new UptimeRobotService();
export default uptimeRobotService;
