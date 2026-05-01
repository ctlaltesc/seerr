import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { Announcement } from '@server/entity/Announcement';
import { ProblemReport } from '@server/entity/ProblemReport';
import { User } from '@server/entity/User';
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

describe('GET /uptimerobot/announcements', () => {
  async function seedAnnouncement(
    email: string,
    subject: string,
    ageMs: number
  ): Promise<number> {
    const user = await getRepository(User).findOneOrFail({
      where: { email },
    });
    const repo = getRepository(Announcement);
    const saved = await repo.save(
      new Announcement({
        subject,
        message: 'context',
        postedBy: user,
      })
    );
    // Backdate so we can exercise the expiry rules without sleeping.
    await repo.update(saved.id, {
      postedAt: new Date(Date.now() - ageMs),
    });
    return saved.id;
  }

  it('returns 403 for unauthenticated requests', async () => {
    const res = await request(app).get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 403);
  });

  it('returns active announcements for any logged-in user', async () => {
    await seedAnnouncement('admin@seerr.dev', 'Hello world', 60_000);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].subject, 'Hello world');
    assert.ok(res.body[0].postedBy);
  });

  it('drops anything older than the 72h hard cap', async () => {
    await seedAnnouncement('admin@seerr.dev', 'Old', 73 * 60 * 60 * 1000);
    await seedAnnouncement('admin@seerr.dev', 'Fresh', 60_000);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 200);
    const subjects = res.body.map(
      (a: { subject: string }) => a.subject
    ) as string[];
    assert.deepStrictEqual(subjects, ['Fresh']);

    // Hard-cap row was deleted opportunistically.
    const remaining = await getRepository(Announcement).find();
    assert.strictEqual(remaining.length, 1);
  });

  it('drops 24h+ announcements when the system has been all-up for 24h', async () => {
    mock.method(
      uptimeRobotService,
      'getLastDowntime',
      () => Date.now() - 25 * 60 * 60 * 1000
    );
    await seedAnnouncement('admin@seerr.dev', 'Mediumold', 25 * 60 * 60 * 1000);
    await seedAnnouncement('admin@seerr.dev', 'Recent', 60_000);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 200);
    const subjects = res.body.map(
      (a: { subject: string }) => a.subject
    ) as string[];
    assert.deepStrictEqual(subjects, ['Recent']);
  });

  it('keeps 24h+ announcements when something has been down recently', async () => {
    mock.method(
      uptimeRobotService,
      'getLastDowntime',
      () => Date.now() - 60_000
    );
    await seedAnnouncement('admin@seerr.dev', 'Mediumold', 25 * 60 * 60 * 1000);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].subject, 'Mediumold');
  });

  it('keeps 24h+ announcements when no downtime has been observed yet', async () => {
    mock.method(uptimeRobotService, 'getLastDowntime', () => undefined);
    await seedAnnouncement('admin@seerr.dev', 'Mediumold', 25 * 60 * 60 * 1000);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get('/uptimerobot/announcements');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
  });
});

describe('DELETE /uptimerobot/announcements/:id', () => {
  it('lets an admin retract', async () => {
    const owner = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const saved = await getRepository(Announcement).save(
      new Announcement({ subject: 'x', postedBy: owner })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/uptimerobot/announcements/${saved.id}`);
    assert.strictEqual(res.status, 204);
    const remaining = await getRepository(Announcement).find();
    assert.strictEqual(remaining.length, 0);
  });

  it('rejects non-admin users', async () => {
    const owner = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const saved = await getRepository(Announcement).save(
      new Announcement({ subject: 'x', postedBy: owner })
    );

    const friend = await loginAs('friend@seerr.dev', 'test1234');
    const res = await friend.delete(`/uptimerobot/announcements/${saved.id}`);
    assert.strictEqual(res.status, 403);
    const remaining = await getRepository(Announcement).find();
    assert.strictEqual(remaining.length, 1);
  });

  it('rejects an invalid id with 400', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete('/uptimerobot/announcements/abc');
    assert.strictEqual(res.status, 400);
  });

  it('returns 204 when the id does not exist (idempotent)', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete('/uptimerobot/announcements/99999');
    assert.strictEqual(res.status, 204);
  });
});

describe('Problem Reports', () => {
  beforeEach(() => {
    // Reset any leftover suppression window between tests so the routes are
    // exercised on their happy path. Per-channel admin opt-in is now driven
    // off each user's notification preferences (set elsewhere), so there's
    // no global toggle to clear here.
    const settings = getSettings();
    settings.uptimerobot.reportsSuppressedUntil = undefined;
  });

  it('POST /reports requires auth', async () => {
    const res = await request(app)
      .post('/uptimerobot/reports')
      .send({ monitorIds: [1002] });
    assert.strictEqual(res.status, 403);
  });

  it('POST /reports rejects an empty payload with 400', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent
      .post('/uptimerobot/reports')
      .send({ monitorIds: [] });
    assert.strictEqual(res.status, 400);
  });

  it('POST /reports drops unknown monitor ids and 400s when none survive', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent
      .post('/uptimerobot/reports')
      .send({ monitorIds: [99999] });
    assert.strictEqual(res.status, 400);
  });

  it('POST /reports persists one row per visible monitor', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent
      .post('/uptimerobot/reports')
      .send({ monitorIds: [1001, 1002] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created, 2);
    assert.strictEqual(res.body.alreadyReported, 0);

    const stored = await getRepository(ProblemReport).find();
    assert.strictEqual(stored.length, 2);
    // Snapshots match what the public monitor list reported
    assert.deepStrictEqual(stored.map((r) => r.monitorNameSnapshot).sort(), [
      'API',
      'Web',
    ]);
  });

  it('POST /reports dedupes — re-submitting the same monitor is a no-op', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    await agent.post('/uptimerobot/reports').send({ monitorIds: [1002] });
    const second = await agent
      .post('/uptimerobot/reports')
      .send({ monitorIds: [1002] });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.created, 0);
    assert.strictEqual(second.body.alreadyReported, 1);

    const stored = await getRepository(ProblemReport).find();
    assert.strictEqual(stored.length, 1);
  });

  it('GET /reports returns aggregated counts per monitor', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/reports').send({ monitorIds: [1002] });
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    await admin.post('/uptimerobot/reports').send({ monitorIds: [1002] });

    const res = await admin.get('/uptimerobot/reports');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].monitorId, 1002);
    assert.strictEqual(res.body[0].count, 2);
  });

  it('GET /reports prunes the 24h hard cap and resolves the row', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/reports').send({ monitorIds: [1002] });

    const repo = getRepository(ProblemReport);
    const row = (await repo.find())[0];
    await repo.update(row.id, {
      reportedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const res = await friend.get('/uptimerobot/reports');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);

    const after = await repo.findOneOrFail({ where: { id: row.id } });
    assert.ok(after.resolvedAt, 'expired row should have been auto-resolved');
  });

  it('GET /reports prunes a downed report when monitor has been up for 24h', async () => {
    // Force the service to think the monitor was last seen down >24h ago.
    mock.method(
      uptimeRobotService,
      'getMonitorLastDown',
      () => Date.now() - 25 * 60 * 60 * 1000
    );

    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/reports').send({ monitorIds: [1002] });
    // Backdate the report by an hour to ensure age > 0.
    const repo = getRepository(ProblemReport);
    const row = (await repo.find())[0];
    await repo.update(row.id, {
      reportedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await friend.get('/uptimerobot/reports');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);
  });

  it('GET /reports keeps a downed report when monitor was recently down', async () => {
    mock.method(
      uptimeRobotService,
      'getMonitorLastDown',
      () => Date.now() - 60_000
    );

    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/reports').send({ monitorIds: [1002] });

    const res = await friend.get('/uptimerobot/reports');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
  });

  it('POST /reports/resolve clears all reports', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend
      .post('/uptimerobot/reports')
      .send({ monitorIds: [1001, 1002] });

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post('/uptimerobot/reports/resolve');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.resolved, 2);

    const remaining = await admin.get('/uptimerobot/reports');
    assert.strictEqual(remaining.body.length, 0);
  });

  it('POST /reports/resolve?monitorId scopes resolve to one monitor', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend
      .post('/uptimerobot/reports')
      .send({ monitorIds: [1001, 1002] });

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin
      .post('/uptimerobot/reports/resolve?monitorId=1002')
      .send();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.resolved, 1);

    const remaining = await admin.get('/uptimerobot/reports');
    assert.strictEqual(remaining.body.length, 1);
    assert.strictEqual(remaining.body[0].monitorId, 1001);
  });

  it('POST /reports/resolve rejects non-admin users with 403', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    const res = await friend.post('/uptimerobot/reports/resolve');
    assert.strictEqual(res.status, 403);
  });

  it('DELETE /reports/:id is admin-only and idempotent', async () => {
    const friend = await loginAs('friend@seerr.dev', 'test1234');
    await friend.post('/uptimerobot/reports').send({ monitorIds: [1002] });
    const stored = await getRepository(ProblemReport).find();
    const id = stored[0].id;

    const friendDel = await friend.delete(`/uptimerobot/reports/${id}`);
    assert.strictEqual(friendDel.status, 403);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const adminDel = await admin.delete(`/uptimerobot/reports/${id}`);
    assert.strictEqual(adminDel.status, 204);

    // Idempotent — second call against a now-resolved id returns 204.
    const adminDelAgain = await admin.delete(`/uptimerobot/reports/${id}`);
    assert.strictEqual(adminDelAgain.status, 204);
  });
});
