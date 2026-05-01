import { getRepository } from '@server/datasource';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import uptimeRobotService from '@server/lib/uptimerobot';
import logger from '@server/logger';
import { Router } from 'express';

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

    const status = uptimeRobotService.getStatus();
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

    // The monitor must exist in the latest cached list. This guards against
    // someone subscribing to an id that UptimeRobot does not know about.
    const monitors = uptimeRobotService.getMonitors();
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

export default statusRoutes;
