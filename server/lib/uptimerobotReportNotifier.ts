import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { getSettings, NotificationAgentKey } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import webpush from 'web-push';

interface ReportNotifierPayload {
  reporterDisplayName: string;
  monitorNames: string[];
  /** Total number of monitors the reporter selected. */
  monitorCount: number;
}

/**
 * Send the "user just reported a problem" notification to every admin who
 * has opted in via their personal user notification settings. Each admin
 * controls each channel (web push / Telegram) independently from
 * `/users/<id>/settings/notifications/<agent>`; this dispatch never
 * second-guesses that opt-in.
 *
 * Best-effort: each channel is fire-and-forget and one channel's
 * failure does not stop the others. Errors are logged but never thrown.
 */
export async function notifyAdminsOfReport(
  payload: ReportNotifierPayload
): Promise<void> {
  const settings = getSettings();

  const admins = await getRepository(User)
    .createQueryBuilder('user')
    .leftJoinAndSelect('user.settings', 'settings')
    .getMany();
  const adminUsers = admins.filter((u) => u.hasPermission(Permission.ADMIN));
  if (!adminUsers.length) return;

  const subject = `Problem report from ${payload.reporterDisplayName}`;
  const body =
    payload.monitorCount === 1
      ? `Reported an issue with ${payload.monitorNames[0]}.`
      : `Reported issues with: ${payload.monitorNames.join(', ')}.`;

  // Per-channel filtering — each admin opts in independently.
  // Web push defaults on (matching the upstream agent's default-true
  // behaviour for unset prefs); Telegram defaults off because it
  // requires a chat id anyway.
  const webPushTargets = adminUsers.filter(
    (u) =>
      u.settings?.hasNotificationType(
        NotificationAgentKey.WEBPUSH,
        Notification.PROBLEM_REPORTED
      ) ?? true
  );
  const telegramTargets = adminUsers.filter(
    (u) =>
      u.settings?.hasNotificationType(
        NotificationAgentKey.TELEGRAM,
        Notification.PROBLEM_REPORTED
      ) ?? false
  );

  if (webPushTargets.length) {
    await dispatchWebPush(webPushTargets, subject, body, settings);
  }
  if (telegramTargets.length) {
    await dispatchTelegram(telegramTargets, subject, body, settings);
  }
}

async function dispatchWebPush(
  adminUsers: User[],
  subject: string,
  message: string,
  settings: ReturnType<typeof getSettings>
): Promise<void> {
  if (!settings.vapidPublic || !settings.vapidPrivate) {
    logger.warn(
      'Skipping admin web-push for problem report — VAPID not configured',
      { label: 'UptimeRobot' }
    );
    return;
  }

  const owner = await getRepository(User).findOne({ where: { id: 1 } });
  if (!owner) return;

  webpush.setVapidDetails(
    `mailto:${owner.email}`,
    settings.vapidPublic,
    settings.vapidPrivate
  );

  const userIds = adminUsers.map((u) => u.id);
  const pushRepo = getRepository(UserPushSubscription);
  const subs = userIds.length
    ? await pushRepo
        .createQueryBuilder('pushSub')
        .leftJoinAndSelect('pushSub.user', 'user')
        .where('pushSub.userId IN (:...users)', { users: userIds })
        .getMany()
    : [];

  if (!subs.length) return;

  const payload = Buffer.from(
    JSON.stringify({
      notificationType: 'PROBLEM_REPORTED',
      subject,
      message,
      actionUrl: '/status',
      actionUrlTitle: 'View Status',
    }),
    'utf-8'
  );

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { auth: sub.auth, p256dh: sub.p256dh },
          },
          payload
        );
      } catch (e) {
        const err = e as { statusCode?: number; status?: number };
        const code = err.statusCode ?? err.status;
        if (code === 410 || code === 404) {
          await pushRepo.remove(sub);
        } else {
          logger.warn('Problem-report admin web-push failed', {
            label: 'UptimeRobot',
            statusCode: code ?? 'unknown',
          });
        }
      }
    })
  );
}

async function dispatchTelegram(
  adminUsers: User[],
  subject: string,
  message: string,
  settings: ReturnType<typeof getSettings>
): Promise<void> {
  const telegram = settings.notifications.agents.telegram;
  if (!telegram?.options?.botAPI) {
    logger.warn(
      'Skipping admin Telegram for problem report — bot API token not configured',
      { label: 'UptimeRobot' }
    );
    return;
  }

  const url = `https://api.telegram.org/bot${telegram.options.botAPI}/sendMessage`;
  // Each admin receives the message at their personal chat id; if they
  // haven't set one, fall back to the global default chat id (which the
  // existing Telegram agent uses for the system bus).
  const targets = new Set<string>();
  for (const admin of adminUsers) {
    const chatId = admin.settings?.telegramChatId || telegram.options.chatId;
    if (chatId) targets.add(chatId);
  }
  if (!targets.size) return;

  const text = `*${escapeMarkdown(subject)}*\n${escapeMarkdown(message)}`;

  await Promise.all(
    [...targets].map(async (chatId) => {
      try {
        await axios.post(url, {
          chat_id: chatId,
          text,
          parse_mode: 'MarkdownV2',
          message_thread_id: telegram.options.messageThreadId || undefined,
          disable_notification: !!telegram.options.sendSilently,
        });
      } catch (e) {
        logger.warn('Problem-report admin Telegram dispatch failed', {
          label: 'UptimeRobot',
          chatId,
          errorMessage: (e as Error).message,
        });
      }
    })
  );
}

/**
 * Telegram MarkdownV2 has a long list of reserved characters that need a
 * leading backslash. Escape them all so user-supplied monitor names can't
 * break parsing.
 */
function escapeMarkdown(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
