import type { UptimeRobotMonitor } from '@server/api/uptimerobot';
import { getSettings, type UptimeRobotSettings } from '@server/lib/settings';
import uptimeRobotService from '@server/lib/uptimerobot';
import logger from '@server/logger';
import { Router } from 'express';

const uptimeRobotRoutes = Router();

const filterPublicSettings = (settings: UptimeRobotSettings) => ({
  enabled: settings.enabled,
  apiKey: settings.apiKey ? '••••••••' : '',
  apiKeySet: !!settings.apiKey,
  monitorOrder: settings.monitorOrder,
  recoveryNotificationsEnabled: settings.recoveryNotificationsEnabled,
  recoveryStableMinutes: settings.recoveryStableMinutes,
  pollIntervalSeconds: settings.pollIntervalSeconds,
});

uptimeRobotRoutes.get('/', (_req, res) => {
  const settings = getSettings();
  return res.status(200).json(filterPublicSettings(settings.uptimerobot));
});

uptimeRobotRoutes.post<
  never,
  unknown,
  Partial<UptimeRobotSettings> & { apiKey?: string | null }
>('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const current = settings.uptimerobot;

    const next: UptimeRobotSettings = {
      enabled: req.body.enabled ?? current.enabled,
      // An empty string or null clears the API key. `undefined` leaves it as-is.
      apiKey:
        req.body.apiKey === undefined
          ? current.apiKey
          : (req.body.apiKey ?? ''),
      monitorOrder: Array.isArray(req.body.monitorOrder)
        ? req.body.monitorOrder
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
        : current.monitorOrder,
      recoveryNotificationsEnabled:
        req.body.recoveryNotificationsEnabled ??
        current.recoveryNotificationsEnabled,
      recoveryStableMinutes: Math.max(
        0,
        Math.min(
          1440,
          Number(
            req.body.recoveryStableMinutes ?? current.recoveryStableMinutes
          ) || 0
        )
      ),
      pollIntervalSeconds: Math.max(
        30,
        Math.min(
          3600,
          Number(req.body.pollIntervalSeconds ?? current.pollIntervalSeconds) ||
            60
        )
      ),
    };

    settings.uptimerobot = next;
    await settings.save();

    // Trigger an immediate poll so the UI sees fresh data; ignore failure
    // (it'll surface via the regular poll cycle).
    if (next.enabled && next.apiKey) {
      uptimeRobotService.poll().catch(() => undefined);
    }

    return res.status(200).json(filterPublicSettings(settings.uptimerobot));
  } catch (e) {
    logger.error('Failed to save UptimeRobot settings', {
      label: 'API',
      errorMessage: (e as Error).message,
    });
    return next({ status: 500, message: 'Failed to save settings.' });
  }
});

/**
 * Validate an API key (or the configured one if none provided) and return
 * the live monitor list — used by the settings UI to populate the
 * customizable order.
 */
uptimeRobotRoutes.post<never, unknown, { apiKey?: string }>(
  '/test',
  async (req, res, next) => {
    const apiKey = (req.body.apiKey ?? getSettings().uptimerobot.apiKey).trim();

    if (!apiKey) {
      return next({
        status: 400,
        message: 'An UptimeRobot API key is required.',
      });
    }

    try {
      const monitors = await uptimeRobotService.testApiKey(apiKey);
      return res.status(200).json({
        ok: true,
        monitors: monitors.map((m: UptimeRobotMonitor) => ({
          id: m.id,
          name: m.friendly_name,
          url: m.url,
          type: m.type,
          status: m.status,
        })),
      });
    } catch (e) {
      const message = (e as Error).message;
      logger.warn('UptimeRobot API key validation failed', {
        label: 'UptimeRobot',
        errorMessage: message,
      });
      return next({
        status: 400,
        message,
      });
    }
  }
);

/**
 * Convenience for the settings UI: returns the most recent monitor list
 * served by the polling service, falling back to a fresh API call if the
 * cache is empty. Saves an extra poll round-trip for the admin.
 */
uptimeRobotRoutes.get('/monitors', async (_req, res, next) => {
  try {
    if (!uptimeRobotService.hasFetchedAtLeastOnce()) {
      await uptimeRobotService.poll();
    }
    return res.status(200).json(uptimeRobotService.getMonitors());
  } catch (e) {
    return next({
      status: 500,
      message: (e as Error).message,
    });
  }
});

export default uptimeRobotRoutes;
