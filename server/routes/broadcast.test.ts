import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import webpush from 'web-push';
import authRoutes from './auth';
import userRoutes from './user';

// Mock web-push so we don't actually try to dispatch notifications.
const sendNotificationMock = mock.method(
  webpush,
  'sendNotification',
  async () => ({ statusCode: 201, body: '', headers: {} })
).mock;

const setVapidDetailsMock = mock.method(
  webpush,
  'setVapidDetails',
  () => undefined
).mock;

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(async () => {
  sendNotificationMock.resetCalls();
  setVapidDetailsMock.resetCalls();
  // Default behavior: succeed
  sendNotificationMock.mockImplementation(async () => ({
    statusCode: 201,
    body: '',
    headers: {},
  }));

  // Ensure VAPID is configured for tests by default.
  const settings = getSettings();
  settings.main.localLogin = true;
  // The test settings instance does not have setters for vapidPublic /
  // vapidPrivate, so write directly to the underlying data object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (settings as any).data.vapidPublic =
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (settings as any).data.vapidPrivate =
    'tUxGcU22YJcwZxZL0F4lQNwR3pNnKPM_HlT1cTk5sUQ';
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });
  assert.strictEqual(res.status, 200);
  return agent;
}

async function seedSubscription(email: string, endpoint: string) {
  const userRepo = getRepository(User);
  const subRepo = getRepository(UserPushSubscription);

  const user = await userRepo.findOneOrFail({ where: { email } });
  await subRepo.save(
    new UserPushSubscription({
      user,
      endpoint,
      auth: `auth-${endpoint}`,
      p256dh: `p256dh-${endpoint}`,
      userAgent: 'test',
    })
  );
}

describe('POST /user/broadcast', () => {
  it('returns 403 when not authenticated', async () => {
    const res = await request(app)
      .post('/user/broadcast')
      .send({ subject: 'hi' });
    assert.strictEqual(res.status, 403);
  });

  it('returns 403 for non-admin users', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'hi', message: 'world' });
    assert.strictEqual(res.status, 403);
  });

  it('returns 400 when subject is missing', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ message: 'no subject' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /subject is required/);
  });

  it('returns 400 when subject is empty/whitespace', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/user/broadcast').send({ subject: '   ' });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when subject exceeds 120 chars', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'a'.repeat(121) });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /120 characters/);
  });

  it('returns 400 when message exceeds 500 chars', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'ok', message: 'a'.repeat(501) });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /500 characters/);
  });

  it('returns 400 when userIds is an empty array', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'ok', userIds: [] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /Select at least one user/);
  });

  it('returns 500 when web push is not configured', async () => {
    const settings = getSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (settings as any).data.vapidPublic = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (settings as any).data.vapidPrivate = '';

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'maintenance' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.message, /Web push is not configured/);
    assert.strictEqual(sendNotificationMock.callCount(), 0);
  });

  it('reports zero recipients when no subscriptions exist', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'maintenance' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { sent: 0, failed: 0, recipients: 0 });
    assert.strictEqual(sendNotificationMock.callCount(), 0);
  });

  it('broadcasts to all subscriptions when userIds is omitted', async () => {
    await seedSubscription('admin@seerr.dev', 'https://endpoint.example/admin');
    await seedSubscription(
      'friend@seerr.dev',
      'https://endpoint.example/friend'
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/user/broadcast').send({
      subject: 'Server Maintenance',
      message: 'The server is going down for maintenance for about 20 minutes.',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 2);
    assert.strictEqual(res.body.failed, 0);
    assert.strictEqual(res.body.recipients, 2);
    assert.strictEqual(sendNotificationMock.callCount(), 2);

    // Verify the payload that was sent
    const firstCall = sendNotificationMock.calls[0];
    const payloadBuffer = firstCall.arguments[1] as Buffer;
    const payload = JSON.parse(payloadBuffer.toString('utf-8'));
    assert.strictEqual(payload.notificationType, 'CUSTOM_BROADCAST');
    assert.strictEqual(payload.subject, 'Server Maintenance');
    assert.match(payload.message, /maintenance/);

    // Verify VAPID was set
    assert.ok(setVapidDetailsMock.callCount() >= 1);
  });

  it('broadcasts only to selected users when userIds is provided', async () => {
    await seedSubscription('admin@seerr.dev', 'https://endpoint.example/admin');
    await seedSubscription(
      'friend@seerr.dev',
      'https://endpoint.example/friend'
    );

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'Friendly note', userIds: [friend.id] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 1);
    assert.strictEqual(res.body.recipients, 1);
    assert.strictEqual(sendNotificationMock.callCount(), 1);

    const subscription = sendNotificationMock.calls[0].arguments[0] as {
      endpoint: string;
    };
    assert.strictEqual(
      subscription.endpoint,
      'https://endpoint.example/friend'
    );
  });

  it('omits message field from payload when empty', async () => {
    await seedSubscription('admin@seerr.dev', 'https://endpoint.example/admin');

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'Title only', message: '   ' });

    assert.strictEqual(res.status, 200);
    const payload = JSON.parse(
      (sendNotificationMock.calls[0].arguments[1] as Buffer).toString('utf-8')
    );
    assert.strictEqual(payload.subject, 'Title only');
    assert.strictEqual(payload.message, undefined);
  });

  it('removes subscriptions that return 410 (gone)', async () => {
    await seedSubscription('admin@seerr.dev', 'https://endpoint.example/dead');

    sendNotificationMock.mockImplementation(async () => {
      const err = Object.assign(new Error('Gone'), { statusCode: 410 });
      throw err;
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'cleanup test' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 0);
    assert.strictEqual(res.body.failed, 1);

    const subRepo = getRepository(UserPushSubscription);
    const remaining = await subRepo.find();
    assert.strictEqual(
      remaining.length,
      0,
      'expected the 410 subscription to be removed'
    );
  });

  it('keeps subscriptions on transient (non-410/404) errors', async () => {
    await seedSubscription(
      'admin@seerr.dev',
      'https://endpoint.example/transient'
    );

    sendNotificationMock.mockImplementation(async () => {
      const err = Object.assign(new Error('Server error'), { statusCode: 500 });
      throw err;
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'transient' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed, 1);

    const subRepo = getRepository(UserPushSubscription);
    const remaining = await subRepo.find();
    assert.strictEqual(
      remaining.length,
      1,
      'transient errors should not remove the subscription'
    );
  });

  it('counts unique recipients when a user has multiple subscriptions', async () => {
    await seedSubscription(
      'admin@seerr.dev',
      'https://endpoint.example/desktop'
    );
    await seedSubscription(
      'admin@seerr.dev',
      'https://endpoint.example/mobile'
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent
      .post('/user/broadcast')
      .send({ subject: 'multi-device' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 2);
    assert.strictEqual(
      res.body.recipients,
      1,
      'two subscriptions for one user should count as one recipient'
    );
  });
});
