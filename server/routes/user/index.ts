import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import { Announcement } from '@server/entity/Announcement';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  UserRequestsResponse,
  UserResultsResponse,
  UserWatchDataResponse,
} from '@server/interfaces/api/userInterfaces';
import { Permission, hasPermission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { getHostname } from '@server/utils/getHostname';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { isOwnProfileOrAdmin } from '@server/utils/profileMiddleware';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { findIndex, sortBy } from 'lodash';
import type { EntityManager } from 'typeorm';
import { In, Not } from 'typeorm';
import webpush from 'web-push';
import userSettingsRoutes from './usersettings';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const includeIds = [
      ...new Set(
        req.query.includeIds ? req.query.includeIds.toString().split(',') : []
      ),
    ];
    const pageSize = req.query.take
      ? Number(req.query.take)
      : Math.max(10, includeIds.length);
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const q = req.query.q ? req.query.q.toString().toLowerCase() : '';
    const sortParam = req.query.sort ? req.query.sort.toString() : undefined;
    const sortDirectionQuery = req.query.sortDirection
      ? req.query.sortDirection.toString().toLowerCase()
      : undefined;

    let sortDirection: 'ASC' | 'DESC';
    if (sortDirectionQuery === 'asc') {
      sortDirection = 'ASC';
    } else if (sortDirectionQuery === 'desc') {
      sortDirection = 'DESC';
    } else {
      switch (sortParam) {
        case 'displayname':
          sortDirection = 'ASC';
          break;
        case 'requests':
        case 'updated':
          sortDirection = 'DESC';
          break;
        case 'created':
        case 'usertype':
        case 'role':
        case undefined:
        default:
          sortDirection = 'ASC';
          break;
      }
    }

    let query = getRepository(User).createQueryBuilder('user');

    if (q) {
      query = query.where(
        'LOWER(user.username) LIKE :q OR LOWER(user.email) LIKE :q OR LOWER(user.plexUsername) LIKE :q OR LOWER(user.jellyfinUsername) LIKE :q',
        { q: `%${q}%` }
      );
    }

    if (includeIds.length > 0) {
      query.andWhereInIds(includeIds);
    }

    switch (sortParam) {
      case 'created':
        query = query.orderBy('user.createdAt', sortDirection);
        break;
      case 'updated':
        query = query.orderBy('user.updatedAt', sortDirection);
        break;
      case 'displayname':
        query = query
          .addSelect(
            `CASE WHEN (user.username IS NULL OR user.username = '') THEN (
                CASE WHEN (user.plexUsername IS NULL OR user.plexUsername = '') THEN (
                  CASE WHEN (user.jellyfinUsername IS NULL OR user.jellyfinUsername = '') THEN
                    "user"."email"
                  ELSE
                    LOWER(user.jellyfinUsername)
                  END)
                ELSE
                  LOWER(user.plexUsername)
                END)
              ELSE
                LOWER(user.username)
              END`,
            'displayname_sort_key'
          )
          .orderBy('displayname_sort_key', sortDirection);
        break;
      case 'requests':
        query = query
          .addSelect((subQuery) => {
            return subQuery
              .select('COUNT(request.id)', 'request_count')
              .from(MediaRequest, 'request')
              .where('request.requestedBy.id = user.id');
          }, 'request_count')
          .orderBy('request_count', sortDirection);
        break;
      case 'usertype':
        query = query.orderBy('user.userType', sortDirection);
        break;
      case 'role':
        query = query
          .addSelect(
            `CASE
              WHEN user.id = 1 THEN 0
              WHEN (user.permissions & ${Permission.ADMIN}) != 0 THEN 1
              ELSE 2
            END`,
            'role_sort_key'
          )
          .orderBy('role_sort_key', sortDirection);
        break;
      default:
        query = query.orderBy('user.id', sortDirection);
        break;
    }

    const [users, userCount] = await query
      .take(pageSize)
      .skip(skip)
      .distinct(true)
      .getManyAndCount();

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(userCount / pageSize),
        pageSize,
        results: userCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: User.filterMany(
        users,
        req.user?.hasPermission(Permission.MANAGE_USERS)
      ),
    } as UserResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.post(
  '/',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();

      const body = req.body;
      const email = body.email || body.username;
      const userRepository = getRepository(User);

      const existingUser = await userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', {
          email: email.toLowerCase(),
        })
        .getOne();

      if (existingUser) {
        return next({
          status: 409,
          message: 'User already exists with submitted email.',
          errors: ['USER_EXISTS'],
        });
      }

      const passedExplicitPassword = body.password && body.password.length > 0;
      const avatar = gravatarUrl(email, { default: 'mm', size: 200 });

      if (
        !passedExplicitPassword &&
        !settings.notifications.agents.email.enabled
      ) {
        throw new Error('Email notifications must be enabled');
      }

      const user = new User({
        email,
        avatar: body.avatar ?? avatar,
        username: body.username,
        password: body.password,
        permissions: settings.main.defaultPermissions,
        plexToken: '',
        userType: UserType.LOCAL,
      });

      if (passedExplicitPassword) {
        await user?.setPassword(body.password);
      } else {
        await user?.generatePassword();
      }

      await userRepository.save(user);
      return res.status(201).json(user.filter());
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post<
  never,
  unknown,
  {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string;
  }
>('/registerPushSubscription', async (req, res, next) => {
  try {
    // This prevents race conditions where two requests both pass the checks
    await dataSource.transaction(
      async (transactionalEntityManager: EntityManager) => {
        const transactionalRepo =
          transactionalEntityManager.getRepository(UserPushSubscription);

        // Check for existing subscription by auth or endpoint within transaction
        const existingSubscription = await transactionalRepo.findOne({
          relations: { user: true },
          where: [
            { auth: req.body.auth, user: { id: req.user?.id } },
            { endpoint: req.body.endpoint, user: { id: req.user?.id } },
          ],
        });

        if (existingSubscription) {
          // If endpoint matches but auth is different, update with new keys (iOS refresh case)
          if (
            existingSubscription.endpoint === req.body.endpoint &&
            existingSubscription.auth !== req.body.auth
          ) {
            existingSubscription.auth = req.body.auth;
            existingSubscription.p256dh = req.body.p256dh;
            existingSubscription.userAgent = req.body.userAgent;

            await transactionalRepo.save(existingSubscription);

            logger.debug(
              'Updated existing push subscription with new keys for same endpoint.',
              { label: 'API' }
            );
            return;
          }

          logger.debug(
            'Duplicate subscription detected. Skipping registration.',
            { label: 'API' }
          );
          return;
        }

        // Clean up old subscriptions from the same device (userAgent) for this user
        // iOS can silently refresh endpoints, leaving stale subscriptions in the database
        // Only clean up if we're creating a new subscription (not updating an existing one)
        if (req.body.userAgent) {
          const staleSubscriptions = await transactionalRepo.find({
            relations: { user: true },
            where: {
              userAgent: req.body.userAgent,
              user: { id: req.user?.id },
              // Only remove subscriptions with different endpoints (stale ones)
              // Keep subscriptions that might be from different browsers/tabs
              endpoint: Not(req.body.endpoint),
            },
          });

          if (staleSubscriptions.length > 0) {
            await transactionalRepo.remove(staleSubscriptions);
            logger.debug(
              `Removed ${staleSubscriptions.length} stale push subscription(s) from same device.`,
              { label: 'API' }
            );
          }
        }

        const userPushSubscription = new UserPushSubscription({
          auth: req.body.auth,
          endpoint: req.body.endpoint,
          p256dh: req.body.p256dh,
          userAgent: req.body.userAgent,
          user: req.user,
        });

        await transactionalRepo.save(userPushSubscription);
      }
    );

    return res.status(204).send();
  } catch {
    logger.error('Failed to register user push subscription', {
      label: 'API',
    });
    next({ status: 500, message: 'Failed to register subscription.' });
  }
});

router.post<
  never,
  { sent: number; failed: number; recipients: number; announcementId?: number },
  {
    subject: string;
    message?: string;
    userIds?: number[];
    postToStatus?: boolean;
    suppressReportsForMinutes?: number;
  }
>('/broadcast', isAuthenticated(Permission.ADMIN), async (req, res, next) => {
  try {
    const subject = (req.body.subject ?? '').trim();
    const message = (req.body.message ?? '').trim() || undefined;
    // Default to true so the existing UI behaviour matches the new feature.
    const postToStatus = req.body.postToStatus !== false;
    // Cap the suppression window at 24h so a typo can't lock reports for days.
    const suppressMinutes = Math.max(
      0,
      Math.min(
        1440,
        Math.round(Number(req.body.suppressReportsForMinutes ?? 0)) || 0
      )
    );

    if (!subject) {
      return next({
        status: 400,
        message: 'A subject is required to broadcast a notification.',
      });
    }

    if (subject.length > 120) {
      return next({
        status: 400,
        message: 'Subject must be 120 characters or fewer.',
      });
    }

    if (message && message.length > 500) {
      return next({
        status: 400,
        message: 'Message must be 500 characters or fewer.',
      });
    }

    // Differentiate "broadcast to all" (userIds omitted) from "broadcast to a
    // selected list" (userIds provided). An explicitly empty list is a client
    // error, not a request to silently broadcast to everyone.
    const userIdsProvided = Array.isArray(req.body.userIds);
    const targetUserIds = userIdsProvided
      ? (req.body.userIds ?? []).filter((id) => Number.isFinite(id))
      : [];

    if (userIdsProvided && targetUserIds.length === 0) {
      return next({
        status: 400,
        message:
          'Select at least one user, or omit userIds to broadcast to all.',
      });
    }

    const userRepository = getRepository(User);
    const userPushSubRepository = getRepository(UserPushSubscription);
    const settings = getSettings();

    if (!settings.vapidPublic || !settings.vapidPrivate) {
      logger.warn(
        'Broadcast push notification attempted but web push is not configured',
        { label: 'Notifications', sender: req.user?.displayName }
      );
      return next({
        status: 500,
        message: 'Web push is not configured on this server.',
      });
    }

    const mainUser = await userRepository.findOne({ where: { id: 1 } });

    if (!mainUser) {
      return next({
        status: 500,
        message: 'Main user not found; unable to broadcast notification.',
      });
    }

    const subsQuery = userPushSubRepository
      .createQueryBuilder('pushSub')
      .leftJoinAndSelect('pushSub.user', 'user');

    if (userIdsProvided) {
      subsQuery.where('pushSub.userId IN (:...users)', {
        users: targetUserIds,
      });
    }

    const allSubs = await subsQuery.getMany();

    const recipientIds = new Set(allSubs.map((sub) => sub.user.id));

    logger.info('Admin initiated broadcast push notification', {
      label: 'Notifications',
      sender: req.user?.displayName,
      senderId: req.user?.id,
      audience: userIdsProvided ? 'selected' : 'all',
      targetedUsers: userIdsProvided ? targetUserIds.length : undefined,
      subscriptions: allSubs.length,
      recipients: recipientIds.size,
    });

    webpush.setVapidDetails(
      `mailto:${mainUser.email}`,
      settings.vapidPublic,
      settings.vapidPrivate
    );

    const notificationPayload = Buffer.from(
      JSON.stringify({
        notificationType: 'CUSTOM_BROADCAST',
        subject,
        message,
      }),
      'utf-8'
    );

    let sent = 0;
    let failed = 0;

    await Promise.all(
      allSubs.map(async (pushSub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: pushSub.endpoint,
              keys: {
                auth: pushSub.auth,
                p256dh: pushSub.p256dh,
              },
            },
            notificationPayload
          );
          sent++;
        } catch (e) {
          failed++;
          const err = e as {
            statusCode?: number;
            status?: number;
            message?: string;
          };
          const statusCode = err.statusCode ?? err.status;
          const isPermanentFailure = statusCode === 410 || statusCode === 404;

          logger.error(
            isPermanentFailure
              ? 'Error sending broadcast push notification; removing invalid subscription'
              : 'Error sending broadcast push notification',
            {
              label: 'Notifications',
              recipient: pushSub.user.displayName,
              errorMessage: err.message ?? String(e),
              statusCode: statusCode ?? 'unknown',
            }
          );

          if (isPermanentFailure) {
            await userPushSubRepository.remove(pushSub);
          }
        }
      })
    );

    logger.info('Broadcast push notification dispatched', {
      label: 'Notifications',
      sender: req.user?.displayName,
      senderId: req.user?.id,
      subject,
      hasMessage: !!message,
      sent,
      failed,
      recipients: recipientIds.size,
      audience: userIdsProvided ? 'selected' : 'all',
    });

    let announcementId: number | undefined;
    if (postToStatus) {
      try {
        const announcementRepo = getRepository(Announcement);
        const saved = await announcementRepo.save(
          new Announcement({
            subject,
            message,
            postedBy: req.user,
          })
        );
        announcementId = saved.id;
      } catch (e) {
        // Persisting the announcement is best-effort — the push has
        // already gone out, so we just log and carry on.
        logger.warn('Failed to persist announcement for broadcast', {
          label: 'API',
          errorMessage: (e as Error).message,
        });
      }
    }

    if (suppressMinutes > 0) {
      try {
        settings.uptimerobot.reportsSuppressedUntil =
          Date.now() + suppressMinutes * 60_000;
        await settings.save();
      } catch (e) {
        logger.warn('Failed to persist report-suppression window', {
          label: 'API',
          errorMessage: (e as Error).message,
        });
      }
    }

    return res.status(200).json({
      sent,
      failed,
      recipients: recipientIds.size,
      announcementId,
    });
  } catch (e) {
    logger.error('Failed to send broadcast push notification', {
      label: 'API',
      errorMessage: e.message,
    });
    next({
      status: 500,
      message: 'Failed to send broadcast notification.',
    });
  }
});

router.get<{ userId: string }>(
  '/:userId/pushSubscriptions',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSubs = await userPushSubRepository.find({
        relations: { user: true },
        where: { user: { id: Number(req.params.userId) } },
      });

      return res.status(200).json(userPushSubs);
    } catch {
      next({ status: 404, message: 'User subscriptions not found.' });
    }
  }
);

router.get<{ userId: string; endpoint: string }>(
  '/:userId/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOneOrFail({
        relations: {
          user: true,
        },
        where: {
          user: { id: Number(req.params.userId) },
          endpoint: req.params.endpoint,
        },
      });

      return res.status(200).json(userPushSub);
    } catch {
      next({ status: 404, message: 'User subscription not found.' });
    }
  }
);

router.delete<{ userId: string; endpoint: string }>(
  '/:userId/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOne({
        relations: { user: true },
        where: {
          user: { id: Number(req.params.userId) },
          endpoint: req.params.endpoint,
        },
      });

      // If not found, just return 204 to prevent push disable failure
      // (rare scenario where user push sub does not exist)
      if (!userPushSub) {
        return res.status(204).send();
      }

      await userPushSubRepository.remove(userPushSub);
      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong deleting the user push subcription', {
        label: 'API',
        endpoint: req.params.endpoint,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'User push subcription not found',
      });
    }
  }
);

router.get<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const userRepository = getRepository(User);
    const user = await userRepository.findOneOrFail({
      where: { id: Number(req.params.id) },
    });

    const isOwnProfile = req.user?.id === user.id;
    const isAdmin = req.user?.hasPermission(Permission.MANAGE_USERS);

    return res.status(200).json(user.filter(isOwnProfile || isAdmin));
  } catch {
    next({ status: 404, message: 'User not found.' });
  }
});

router.use('/:id/settings', userSettingsRoutes);

router.get<{ id: string }, UserRequestsResponse>(
  '/:id/requests',
  async (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 20;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (
        user.id !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        return next({
          status: 403,
          message: "You do not have permission to view this user's requests.",
        });
      }

      const [requests, requestCount] = await getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .andWhere('requestedBy.id = :id', {
          id: user.id,
        })
        .orderBy('request.id', 'DESC')
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: requests,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export const canMakePermissionsChange = (
  permissions: number,
  user?: User
): boolean =>
  // Only let the owner grant admin privileges
  !(hasPermission(Permission.ADMIN, permissions) && user?.id !== 1);

router.put<
  Record<string, never>,
  Partial<User>[],
  { ids: string[]; permissions: number }
>('/', isAuthenticated(Permission.MANAGE_USERS), async (req, res, next) => {
  try {
    const isOwner = req.user?.id === 1;

    if (!canMakePermissionsChange(req.body.permissions, req.user)) {
      return next({
        status: 403,
        message: 'You do not have permission to grant this level of access',
      });
    }

    const userRepository = getRepository(User);

    const users: User[] = await userRepository.find({
      where: {
        id: In(
          isOwner ? req.body.ids : req.body.ids.filter((id) => Number(id) !== 1)
        ),
      },
    });

    const updatedUsers = await Promise.all(
      users.map(async (user) => {
        return userRepository.save(<User>{
          ...user,
          ...{ permissions: req.body.permissions },
        });
      })
    );

    return res.status(200).json(updatedUsers);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.put<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      // Only let the owner user modify themselves
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }

      Object.assign(user, {
        username: req.body.username,
        permissions: req.body.permissions,
      });

      await userRepository.save(user);

      return res.status(200).json(user.filter());
    } catch {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.delete<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        relations: { requests: true },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (user.id === 1) {
        return next({
          status: 405,
          message: 'This account cannot be deleted.',
        });
      }

      if (user.hasPermission(Permission.ADMIN) && req.user?.id !== 1) {
        return next({
          status: 405,
          message: 'You cannot delete users with administrative privileges.',
        });
      }

      const requestRepository = getRepository(MediaRequest);

      /**
       * Requests are usually deleted through a cascade constraint. Those however, do
       * not trigger the removal event so listeners to not run and the parent Media
       * will not be updated back to unknown for titles that were still pending. So
       * we manually remove all requests from the user here so the parent media's
       * properly reflect the change.
       */
      await requestRepository.remove(user.requests, {
        /**
         * Break-up into groups of 1000 requests to be removed at a time.
         * Necessary for users with >1000 requests, else an SQLite 'Expression tree is too large' error occurs.
         * https://typeorm.io/repository-api#additional-options
         */
        chunk: user.requests.length / 1000,
      });

      await userRepository.delete(user.id);
      return res.status(200).json(user.filter());
    } catch (e) {
      logger.error('Something went wrong deleting a user', {
        label: 'API',
        userId: req.params.id,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Something went wrong deleting the user',
      });
    }
  }
);

router.post(
  '/import-from-plex',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { plexIds: string[] } | undefined;

      // taken from auth.ts
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      const plexUsersResponse = await mainPlexTv.getUsers();
      const createdUsers: User[] = [];
      for (const rawUser of plexUsersResponse.MediaContainer.User) {
        const account = rawUser.$;

        if (account.email) {
          const user = await userRepository
            .createQueryBuilder('user')
            .where('user.plexId = :id', { id: account.id })
            .orWhere('user.email = :email', {
              email: account.email.toLowerCase(),
            })
            .getOne();

          if (user) {
            // Update the user's avatar with their Plex thumbnail, in case it changed
            user.avatar = account.thumb;
            user.email = account.email;
            user.plexUsername = account.username;

            // In case the user was previously a local account
            if (user.userType === UserType.LOCAL) {
              user.userType = UserType.PLEX;
              user.plexId = parseInt(account.id);
            }
            await userRepository.save(user);
          } else if (!body || body.plexIds.includes(account.id)) {
            if (await mainPlexTv.checkUserAccess(parseInt(account.id))) {
              const newUser = new User({
                plexUsername: account.username,
                email: account.email,
                permissions: settings.main.defaultPermissions,
                plexId: parseInt(account.id),
                plexToken: '',
                avatar: account.thumb,
                userType: UserType.PLEX,
              });
              await userRepository.save(newUser);
              createdUsers.push(newUser);
            }
          }
        }
      }

      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/import-from-jellyfin',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { jellyfinUserIds: string[] };

      // taken from auth.ts
      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
        order: { id: 'ASC' },
      });

      const hostname = getHostname();
      const jellyfinClient = new JellyfinAPI(
        hostname,
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );
      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

      //const jellyfinUsersResponse = await jellyfinClient.getUsers();
      const createdUsers: User[] = [];

      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
      const jellyfinUsers = await jellyfinClient.getUsers();

      const jellyfinUsersById = new Map(
        jellyfinUsers.users.map((user) => [
          normalizeJellyfinGuid(user.Id),
          user,
        ])
      );

      for (const rawJellyfinUserId of body.jellyfinUserIds) {
        const jellyfinUserId = normalizeJellyfinGuid(rawJellyfinUserId);
        if (!jellyfinUserId) {
          continue;
        }

        const jellyfinUser = jellyfinUsersById.get(jellyfinUserId);

        const user = await userRepository.findOne({
          select: ['id', 'jellyfinUserId'],
          where: { jellyfinUserId: jellyfinUserId },
        });

        if (!user) {
          const newUser = new User({
            jellyfinUsername: jellyfinUser?.Name,
            jellyfinUserId: jellyfinUser?.Id,
            jellyfinDeviceId: Buffer.from(
              `BOT_seerr_${jellyfinUser?.Name ?? ''}`
            ).toString('base64'),
            email: jellyfinUser?.Name,
            permissions: settings.main.defaultPermissions,
            avatar: `/avatarproxy/${jellyfinUser?.Id}`,
            userType:
              settings.main.mediaServerType === MediaServerType.JELLYFIN
                ? UserType.JELLYFIN
                : UserType.EMBY,
          });

          await userRepository.save(newUser);
          createdUsers.push(newUser);
        }
      }
      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.get<{ id: string }, QuotaResponse>(
  '/:id/quota',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      if (
        Number(req.params.id) !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        )
      ) {
        return next({
          status: 403,
          message:
            "You do not have permission to view this user's request limits.",
        });
      }

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const quotas = await user.getQuota();

      return res.status(200).json(quotas);
    } catch (e) {
      next({ status: 404, message: e.message });
    }
  }
);

router.get<{ id: string }, UserWatchDataResponse>(
  '/:id/watch_data',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    try {
      const user = await getRepository(User).findOneOrFail({
        where: { id: Number(req.params.id) },
        select: { id: true, plexId: true },
      });

      const tautulli = new TautulliAPI(settings);

      const watchStats = await tautulli.getUserWatchStats(user);
      const watchHistory = await tautulli.getUserWatchHistory(user);

      const recentlyWatched = sortBy(
        await getRepository(Media).find({
          where: [
            {
              mediaType: MediaType.MOVIE,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.MOVIE,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
          ],
        }),
        [
          (media) =>
            findIndex(
              watchHistory,
              (record) =>
                (!!media.ratingKey &&
                  parseInt(media.ratingKey) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key)) ||
                (!!media.ratingKey4k &&
                  parseInt(media.ratingKey4k) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key))
            ),
        ]
      );

      return res.status(200).json({
        recentlyWatched,
        playCount: watchStats.total_plays,
      });
    } catch (e) {
      logger.error('Something went wrong fetching user watch data', {
        label: 'API',
        errorMessage: e.message,
        userId: req.params.id,
      });
      next({
        status: 500,
        message: 'Failed to fetch user watch data.',
      });
    }
  }
);

router.get<{ id: string }, WatchlistResponse>(
  '/:id/watchlist',
  async (req, res, next) => {
    if (
      Number(req.params.id) !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
        {
          type: 'or',
        }
      )
    ) {
      return next({
        status: 403,
        message: "You do not have permission to view this user's Watchlist.",
      });
    }

    const itemsPerPage = 20;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = (page - 1) * itemsPerPage;

    const user = await getRepository(User).findOneOrFail({
      where: { id: Number(req.params.id) },
      select: ['id', 'plexToken'],
    });

    if (user) {
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: user?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }

    // We will just return an empty array if the user has no Plex token
    if (!user.plexToken) {
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    const plexTV = new PlexTvAPI(user.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default router;
