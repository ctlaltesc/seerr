import { getRepository } from '@server/datasource';
import { Announcement } from '@server/entity/Announcement';
import { ProblemReport } from '@server/entity/ProblemReport';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import { Permission } from '@server/lib/permissions';
import uptimeRobotService, {
  type MonitorSummary,
} from '@server/lib/uptimerobot';
import { notifyAdminsOfReport } from '@server/lib/uptimerobotReportNotifier';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { IsNull, LessThan } from 'typeorm';

const ANNOUNCEMENT_HARD_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72h
const ANNOUNCEMENT_HEALTHY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const REPORT_HARD_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const REPORT_RECOVERY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h up after a downed report

/**
 * Filter problem reports against the auto-resolve rules:
 *  - Anything older than 24h is dropped (and database row is marked
 *    resolved on the way out).
 *  - If the original report was filed when the monitor was DOWN, and the
 *    monitor's last observed downtime was >= 24h ago (i.e. it has been
 *    continuously up since), drop the report. Cold-start safety: if the
 *    service has never observed the monitor as down in the current
 *    process lifetime, we conservatively keep the report — the 24h
 *    hard cap will catch it eventually.
 */
async function pruneExpiredReports(
  rows: ProblemReport[]
): Promise<ProblemReport[]> {
  const now = Date.now();
  const repo = getRepository(ProblemReport);
  const stillActive: ProblemReport[] = [];
  const toResolve: ProblemReport[] = [];

  for (const row of rows) {
    const age = now - row.reportedAt.getTime();
    if (age >= REPORT_HARD_EXPIRY_MS) {
      toResolve.push(row);
      continue;
    }
    if (row.monitorStatusAtReport === 'down') {
      const lastDown = uptimeRobotService.getMonitorLastDown(row.monitorId);
      if (
        lastDown !== undefined &&
        now - lastDown >= REPORT_RECOVERY_EXPIRY_MS
      ) {
        toResolve.push(row);
        continue;
      }
    }
    stillActive.push(row);
  }

  if (toResolve.length) {
    const resolvedAt = new Date(now);
    await repo.save(toResolve.map((r) => Object.assign(r, { resolvedAt })));
  }

  return stillActive;
}

const statusRoutes = Router();

/**
 * Public (logged-in) status endpoint. Returns the cached monitor list
 * plus the IDs of monitors that the requesting user has subscribed to
 * for recovery notifications.
 */
statusRoutes.get('/', async (req, res, next) => {
  try {
    if (!uptimeRobotService.hasFetchedAtLeastOnce()) {
      await uptimeRobotService.poll();
    }

    const status = uptimeRobotService.getStatus('public');
    let subscribedMonitorIds: number[] = [];

    if (req.user) {
      const repo = getRepository(UserMonitorRecoverySubscription);
      const subs = await repo.find({ where: { user: { id: req.user.id } } });
      subscribedMonitorIds = subs.map((s) => s.monitorId);
    }

    return res.status(200).json({
      configured: status.configured,
      lastFetched: status.lastFetched,
      monitors: status.monitors,
      subscribedMonitorIds,
    });
  } catch (e) {
    return next({ status: 500, message: (e as Error).message });
  }
});

statusRoutes.post<{ monitorId: string }>(
  '/subscribe/:monitorId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 403, message: 'Authentication required.' });
    }

    const monitorId = Number(req.params.monitorId);
    if (!Number.isFinite(monitorId)) {
      return next({ status: 400, message: 'Invalid monitor id.' });
    }

    // The monitor must exist in the latest cached public list. Hidden
    // monitors are intentionally not subscribable.
    const monitors = uptimeRobotService.getMonitors('public');
    if (!monitors.some((m) => m.id === monitorId)) {
      return next({ status: 404, message: 'Monitor not found.' });
    }

    const repo = getRepository(UserMonitorRecoverySubscription);
    try {
      const existing = await repo.findOne({
        where: { user: { id: req.user.id }, monitorId },
      });
      if (!existing) {
        await repo.save(
          new UserMonitorRecoverySubscription({
            monitorId,
            user: req.user,
          })
        );
      }
      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to register monitor recovery subscription', {
        label: 'API',
        userId: req.user.id,
        monitorId,
        errorMessage: (e as Error).message,
      });
      return next({
        status: 500,
        message: 'Failed to register notification subscription.',
      });
    }
  }
);

statusRoutes.delete<{ monitorId: string }>(
  '/subscribe/:monitorId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 403, message: 'Authentication required.' });
    }

    const monitorId = Number(req.params.monitorId);
    if (!Number.isFinite(monitorId)) {
      return next({ status: 400, message: 'Invalid monitor id.' });
    }

    try {
      const repo = getRepository(UserMonitorRecoverySubscription);
      const existing = await repo.findOne({
        where: { user: { id: req.user.id }, monitorId },
      });
      if (existing) {
        await repo.remove(existing);
      }
      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to remove monitor recovery subscription', {
        label: 'API',
        userId: req.user.id,
        monitorId,
        errorMessage: (e as Error).message,
      });
      return next({
        status: 500,
        message: 'Failed to remove notification subscription.',
      });
    }
  }
);

/**
 * Returns the active announcements (broadcasts the admin chose to post to
 * the status page). Auto-expiry rules:
 *  - Hard cap: anything older than 72h is filtered out.
 *  - Soft rule: anything older than 24h is filtered if the system has been
 *    "all healthy" (no monitor observed down) for the last 24h. If the
 *    service has never observed a downtime since startup we conservatively
 *    keep announcements until the 72h cap.
 *
 * Expired rows are also deleted from the database opportunistically so the
 * table doesn't grow forever.
 */
statusRoutes.get('/announcements', async (_req, res, next) => {
  try {
    const repo = getRepository(Announcement);
    const now = Date.now();
    const hardCutoff = new Date(now - ANNOUNCEMENT_HARD_EXPIRY_MS);

    // Delete anything past the hard cap on every read — cheap and bounded.
    await repo.delete({ postedAt: LessThan(hardCutoff) });

    const rows = await repo.find({
      order: { postedAt: 'DESC' },
      take: 25,
    });

    const lastDown = uptimeRobotService.getLastDowntime();
    const allHealthyFor24h =
      lastDown !== undefined &&
      now - lastDown >= ANNOUNCEMENT_HEALTHY_EXPIRY_MS;

    const visible = rows.filter((row) => {
      const age = now - row.postedAt.getTime();
      if (age >= ANNOUNCEMENT_HARD_EXPIRY_MS) return false;
      if (allHealthyFor24h && age >= ANNOUNCEMENT_HEALTHY_EXPIRY_MS) {
        return false;
      }
      return true;
    });

    return res.status(200).json(
      visible.map((row) => ({
        id: row.id,
        subject: row.subject,
        message: row.message ?? undefined,
        postedAt: row.postedAt.toISOString(),
        postedBy: row.postedBy
          ? {
              id: row.postedBy.id,
              displayName: row.postedBy.displayName,
              avatar: row.postedBy.avatar,
            }
          : undefined,
      }))
    );
  } catch (e) {
    return next({ status: 500, message: (e as Error).message });
  }
});

statusRoutes.delete<{ id: string }>(
  '/announcements/:id',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return next({ status: 400, message: 'Invalid announcement id.' });
    }
    try {
      const repo = getRepository(Announcement);
      const row = await repo.findOne({ where: { id } });
      if (row) await repo.remove(row);
      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to delete announcement', {
        label: 'API',
        announcementId: id,
        errorMessage: (e as Error).message,
      });
      return next({
        status: 500,
        message: 'Failed to delete announcement.',
      });
    }
  }
);

/**
 * Returns the count of active problem reports per monitor visible on the
 * public status page. Hidden monitors are not surfaced.
 */
statusRoutes.get('/reports', async (_req, res, next) => {
  try {
    const repo = getRepository(ProblemReport);
    const rows = await repo.find({
      where: { resolvedAt: IsNull() },
      order: { reportedAt: 'DESC' },
    });
    const active = await pruneExpiredReports(rows);

    const visibleMonitorIds = new Set(
      uptimeRobotService.getMonitors('public').map((m: MonitorSummary) => m.id)
    );

    const counts = new Map<number, { name: string; count: number }>();
    for (const r of active) {
      if (!visibleMonitorIds.has(r.monitorId)) continue;
      const existing = counts.get(r.monitorId);
      if (existing) {
        existing.count++;
      } else {
        counts.set(r.monitorId, {
          name: r.monitorNameSnapshot,
          count: 1,
        });
      }
    }

    return res.status(200).json(
      [...counts.entries()].map(([monitorId, { name, count }]) => ({
        monitorId,
        name,
        count,
      }))
    );
  } catch (e) {
    return next({ status: 500, message: (e as Error).message });
  }
});

/**
 * Submit a new problem report covering one or more monitors. Hidden
 * monitors are silently dropped from the request. Re-reporting the same
 * monitor while a prior unresolved report from the same user already
 * exists is a no-op (no duplicate row, no extra notification).
 */
statusRoutes.post<never, unknown, { monitorIds?: number[] }>(
  '/reports',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 403, message: 'Authentication required.' });
    }
    if (!Array.isArray(req.body.monitorIds) || !req.body.monitorIds.length) {
      return next({
        status: 400,
        message: 'Provide at least one monitor id.',
      });
    }

    try {
      const monitors = uptimeRobotService.getMonitors('public');
      const monitorById = new Map(monitors.map((m) => [m.id, m]));

      const requested = req.body.monitorIds
        .map((v) => Number(v))
        .filter((id) => Number.isFinite(id) && monitorById.has(id));
      if (!requested.length) {
        return next({
          status: 400,
          message: 'None of the supplied monitor ids exist or are visible.',
        });
      }

      const repo = getRepository(ProblemReport);
      const existing = await repo.find({
        where: {
          reporter: { id: req.user.id },
          resolvedAt: IsNull(),
        },
      });
      const existingMonitorIds = new Set(existing.map((r) => r.monitorId));

      const newRows = requested
        .filter((id) => !existingMonitorIds.has(id))
        .map((id) => {
          const monitor = monitorById.get(id)!;
          return new ProblemReport({
            reporter: req.user,
            monitorId: id,
            monitorNameSnapshot: monitor.name,
            monitorStatusAtReport: monitor.status,
          });
        });

      if (newRows.length) {
        await repo.save(newRows);

        // Best-effort admin dispatch — never block the user's response on it.
        notifyAdminsOfReport({
          reporterDisplayName: req.user.displayName,
          monitorNames: newRows.map((r) => r.monitorNameSnapshot),
          monitorCount: newRows.length,
        }).catch((e) => {
          logger.warn('Failed to dispatch admin notification for report', {
            label: 'UptimeRobot',
            errorMessage: (e as Error).message,
          });
        });
      }

      return res.status(200).json({
        created: newRows.length,
        alreadyReported: requested.length - newRows.length,
      });
    } catch (e) {
      logger.error('Failed to create problem report', {
        label: 'API',
        userId: req.user.id,
        errorMessage: (e as Error).message,
      });
      return next({
        status: 500,
        message: 'Failed to submit report.',
      });
    }
  }
);

/**
 * Admin: mark every active problem report as resolved. Optional
 * `?monitorId=` query parameter scopes the resolve to a single monitor.
 */
statusRoutes.post<never, unknown, never, { monitorId?: string }>(
  '/reports/resolve',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    try {
      const repo = getRepository(ProblemReport);
      const where: {
        resolvedAt: ReturnType<typeof IsNull>;
        monitorId?: number;
      } = {
        resolvedAt: IsNull(),
      };
      if (req.query.monitorId !== undefined) {
        const monitorId = Number(req.query.monitorId);
        if (!Number.isFinite(monitorId)) {
          return next({ status: 400, message: 'Invalid monitor id.' });
        }
        where.monitorId = monitorId;
      }
      const rows = await repo.find({ where });
      const resolvedAt = new Date();
      await repo.save(rows.map((r) => Object.assign(r, { resolvedAt })));
      return res.status(200).json({ resolved: rows.length });
    } catch (e) {
      return next({ status: 500, message: (e as Error).message });
    }
  }
);

statusRoutes.delete<{ id: string }>(
  '/reports/:id',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return next({ status: 400, message: 'Invalid report id.' });
    }
    try {
      const repo = getRepository(ProblemReport);
      const row = await repo.findOne({ where: { id } });
      if (row) {
        row.resolvedAt = new Date();
        await repo.save(row);
      }
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: (e as Error).message });
    }
  }
);

export default statusRoutes;
