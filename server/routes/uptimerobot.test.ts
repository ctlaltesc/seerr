import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import { getSettings } from '@server/lib/settings';
import uptimeRobotService from '@server/lib/uptimerobot';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import uptimeRobotRoutes from './uptimerobot';

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
  app.use('/uptimerobot', isAuthenticated(), uptimeRobotRoutes);
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

setupTestDb();

beforeEach(() => {
  // Stub the UptimeRobot service so tests don't poll the real API.
  mock.method(uptimeRobotService, 'hasFetchedAtLeastOnce', () => true);
  mock.method(uptimeRobotService, 'poll', async () => undefined);
  mock.method(uptimeRobotService, 'getMonitors', () => [
    {
      id: 1001,
      name: 'API',
      url: 'https://api.example.test',
      type: 1,
      status: 'up',
      rawStatus: 2,
    },
    {
      id: 1002,
      name: 'Web',
      url: 'https://web.example.test',
      type: 1,
      status: 'down',
      rawStatus: 9,
    },
  ]);
  mock.method(uptimeRobotService, 'getStatus', () => ({
    configured: true,
    monitors: uptimeRobotService.getMonitors(),
    lastFetched: 1_700_000_000_000,
    fetchError: undefined,
  }));

  const settings = getSettings();
  settings.main.localLogin = true;
});

async function loginAs(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });
  assert.strictEqual(res.status, 200);
  return agent;
}

describe('GET /uptimerobot', () => {
  it('returns 403 for unauthenticated requests', async () => {
    const res = await request(app).get('/uptimerobot');
    assert.strictEqual(res.status, 403);
  });

  it('returns monitors and an empty subscription list for new user', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.monitors.length, 2);
    assert.deepStrictEqual(res.body.subscribedMonitorIds, []);
  });

  it('reports the user’s subscriptions', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    await agent.post('/uptimerobot/subscribe/1002');
    const res = await agent.get('/uptimerobot');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.subscribedMonitorIds, [1002]);
  });
});

describe('POST /uptimerobot/subscribe/:monitorId', () => {
  it('returns 403 for unauthenticated requests', async () => {
    const res = await request(app).post('/uptimerobot/subscribe/1002');
    assert.strictEqual(res.status, 403);
  });

  it('returns 400 for an invalid monitor id', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/uptimerobot/subscribe/abc');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 when the monitor is unknown to the service', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/uptimerobot/subscribe/9999');
    assert.strictEqual(res.status, 404);
  });

  it('creates a recovery subscription and is idempotent', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const first = await agent.post('/uptimerobot/subscribe/1002');
    assert.strictEqual(first.status, 204);
    const second = await agent.post('/uptimerobot/subscribe/1002');
    assert.strictEqual(second.status, 204);

    const repo = getRepository(UserMonitorRecoverySubscription);
    const all = await repo.find();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].monitorId, 1002);
  });
});

describe('DELETE /uptimerobot/subscribe/:monitorId', () => {
  it('returns 204 even when no subscription exists (idempotent)', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete('/uptimerobot/subscribe/1002');
    assert.strictEqual(res.status, 204);
  });

  it('removes an existing subscription', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    await agent.post('/uptimerobot/subscribe/1002');
    const before = await getRepository(UserMonitorRecoverySubscription).find();
    assert.strictEqual(before.length, 1);

    const res = await agent.delete('/uptimerobot/subscribe/1002');
    assert.strictEqual(res.status, 204);

    const after = await getRepository(UserMonitorRecoverySubscription).find();
    assert.strictEqual(after.length, 0);
  });

  it('does not affect another user’s subscription', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/subscribe/1002');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete('/uptimerobot/subscribe/1002');
    assert.strictEqual(res.status, 204);

    // Friend's subscription should still exist
    const all = await getRepository(UserMonitorRecoverySubscription).find();
    assert.strictEqual(all.length, 1);
  });
});
