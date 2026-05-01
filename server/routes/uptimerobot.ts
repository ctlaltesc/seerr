import { getRepository } from '@server/datasource';
import { Announcement } from '@server/entity/Announcement';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import { Permission } from '@server/lib/permissions';
import uptimeRobotService from '@server/lib/uptimerobot';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { LessThan } from 'typeorm';

const ANNOUNCEMENT_HARD_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72h
const ANNOUNCEMENT_HEALTHY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

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

export default statusRoutes;
