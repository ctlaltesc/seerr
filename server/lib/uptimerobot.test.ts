import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import UptimeRobotAPI, {
  UPTIMEROBOT_STATUS,
  type UptimeRobotMonitor,
} from '@server/api/uptimerobot';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserMonitorRecoverySubscription } from '@server/entity/UserMonitorRecoverySubscription';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { getSettings } from '@server/lib/settings';
import uptimeRobotService from '@server/lib/uptimerobot';
import { setupTestDb } from '@server/test/db';
import webpush from 'web-push';

const sendNotificationMock = mock.method(
  webpush,
  'sendNotification',
  async () => ({ statusCode: 201, body: '', headers: {} })
).mock;

mock.method(webpush, 'setVapidDetails', () => undefined);

const getMonitorsMock = mock.method(
  UptimeRobotAPI.prototype,
  'getMonitors',
  async (): Promise<UptimeRobotMonitor[]> => []
).mock;

setupTestDb();

const stableMs = 600_000; // matches default 10 minutes

before(() => {
  const settings = getSettings();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (settings as any).data.vapidPublic =
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (settings as any).data.vapidPrivate =
    'tUxGcU22YJcwZxZL0F4lQNwR3pNnKPM_HlT1cTk5sUQ';
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
  getMonitorsMock.resetCalls();

  const settings = getSettings();
  settings.uptimerobot = {
    ...settings.uptimerobot,
    enabled: true,
    apiKey: 'fake-test-key',
    monitorOrder: [],
    monitorOverrides: [],
    recoveryNotificationsEnabled: true,
    recoveryStableMinutes: 10,
    pollIntervalSeconds: 60,
  };

  // Reset the in-memory recovery state between tests by polling once with no
  // monitors; this clears tracked state.
  getMonitorsMock.mockImplementation(
    async (): Promise<UptimeRobotMonitor[]> => []
  );
});

function fakeMonitor(
  id: number,
  name: string,
  status: (typeof UPTIMEROBOT_STATUS)[keyof typeof UPTIMEROBOT_STATUS]
): UptimeRobotMonitor {
  return {
    id,
    friendly_name: name,
    url: '',
    type: 1,
    status,
    create_datetime: 0,
  };
}

function mockMonitorsOnce(monitors: UptimeRobotMonitor[]) {
  getMonitorsMock.mockImplementationOnce(
    async (): Promise<UptimeRobotMonitor[]> => monitors
  );
}

async function seedRecoverySubscription(email: string, monitorId: number) {
  const userRepo = getRepository(User);
  const subRepo = getRepository(UserMonitorRecoverySubscription);
  const user = await userRepo.findOneOrFail({ where: { email } });
  await subRepo.save(new UserMonitorRecoverySubscription({ user, monitorId }));
}

async function seedPushSubscription(email: string, endpoint: string) {
  const userRepo = getRepository(User);
  const pushRepo = getRepository(UserPushSubscription);
  const user = await userRepo.findOneOrFail({ where: { email } });
  await pushRepo.save(
    new UserPushSubscription({
      user,
      endpoint,
      auth: `auth-${endpoint}`,
      p256dh: `p256dh-${endpoint}`,
      userAgent: 'test',
    })
  );
}

describe('UptimeRobotService', () => {
  it('skips polling when disabled', async () => {
    const settings = getSettings();
    settings.uptimerobot.enabled = false;

    await uptimeRobotService.poll();
    assert.strictEqual(getMonitorsMock.callCount(), 0);
    assert.strictEqual(uptimeRobotService.getMonitors().length, 0);
  });

  it('caches monitors after a successful poll', async () => {
    mockMonitorsOnce([fakeMonitor(1, 'Edge', UPTIMEROBOT_STATUS.UP)]);

    await uptimeRobotService.poll();
    const cached = uptimeRobotService.getMonitors();
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].name, 'Edge');
    assert.strictEqual(cached[0].status, 'up');
  });

  it('applies admin overrides for monitor name and description', async () => {
    mockMonitorsOnce([
      fakeMonitor(42, 'raw-name', UPTIMEROBOT_STATUS.UP),
      fakeMonitor(43, 'unchanged', UPTIMEROBOT_STATUS.UP),
    ]);
    await uptimeRobotService.poll();

    getSettings().uptimerobot.monitorOverrides = [
      { id: 42, name: '  Custom Name  ', description: '  Important service  ' },
      { id: 99, name: 'orphan' }, // for a monitor that doesn't exist
    ];

    const monitors = uptimeRobotService.getMonitors();
    const overridden = monitors.find((m) => m.id === 42);
    const untouched = monitors.find((m) => m.id === 43);

    assert.strictEqual(overridden?.name, 'Custom Name');
    assert.strictEqual(overridden?.defaultName, 'raw-name');
    assert.strictEqual(overridden?.description, 'Important service');
    assert.strictEqual(untouched?.name, 'unchanged');
    assert.strictEqual(untouched?.description, undefined);
  });

  it('respects the admin-configured monitor order', async () => {
    mockMonitorsOnce([
      fakeMonitor(10, 'Ten', UPTIMEROBOT_STATUS.UP),
      fakeMonitor(20, 'Twenty', UPTIMEROBOT_STATUS.UP),
      fakeMonitor(30, 'Thirty', UPTIMEROBOT_STATUS.UP),
    ]);
    await uptimeRobotService.poll();

    getSettings().uptimerobot.monitorOrder = [30, 10];

    const ordered = uptimeRobotService.getMonitors();
    assert.deepStrictEqual(
      ordered.map((m) => m.id),
      [30, 10, 20]
    );
  });

  it('does not push notifications until the stable window has elapsed', async () => {
    await seedRecoverySubscription('friend@seerr.dev', 555);
    await seedPushSubscription('friend@seerr.dev', 'https://endpoint.test/a');

    mockMonitorsOnce([fakeMonitor(555, 'API', UPTIMEROBOT_STATUS.DOWN)]);
    await uptimeRobotService.poll();

    mockMonitorsOnce([fakeMonitor(555, 'API', UPTIMEROBOT_STATUS.UP)]);
    await uptimeRobotService.poll();
    assert.strictEqual(sendNotificationMock.callCount(), 0);

    const subs = await getRepository(UserMonitorRecoverySubscription).find();
    assert.strictEqual(subs.length, 1);
  });

  it('pushes notifications once the monitor stays up beyond the stable window', async () => {
    await seedRecoverySubscription('friend@seerr.dev', 666);
    await seedPushSubscription('friend@seerr.dev', 'https://endpoint.test/b');

    const realDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;

    try {
      mockMonitorsOnce([fakeMonitor(666, 'Web', UPTIMEROBOT_STATUS.DOWN)]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 0);

      now += 1_000;
      mockMonitorsOnce([fakeMonitor(666, 'Web', UPTIMEROBOT_STATUS.UP)]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 0);

      now += stableMs + 1_000;
      mockMonitorsOnce([fakeMonitor(666, 'Web', UPTIMEROBOT_STATUS.UP)]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 1);

      const subs = await getRepository(UserMonitorRecoverySubscription).find();
      assert.strictEqual(subs.length, 0);

      const payload = JSON.parse(
        (sendNotificationMock.calls[0].arguments[1] as Buffer).toString('utf-8')
      );
      assert.strictEqual(payload.notificationType, 'MONITOR_RECOVERED');
      assert.match(payload.subject, /Web is back online/);
      assert.strictEqual(payload.actionUrl, '/status');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('uses the admin override for the recovery push subject and body', async () => {
    await seedRecoverySubscription('friend@seerr.dev', 700);
    await seedPushSubscription('friend@seerr.dev', 'https://endpoint.test/o');

    getSettings().uptimerobot.monitorOverrides = [
      { id: 700, name: 'Plex Server', description: 'Streaming for the family' },
    ];

    const realDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;

    try {
      mockMonitorsOnce([
        fakeMonitor(700, 'plex.example', UPTIMEROBOT_STATUS.DOWN),
      ]);
      await uptimeRobotService.poll();

      now += 1_000;
      mockMonitorsOnce([
        fakeMonitor(700, 'plex.example', UPTIMEROBOT_STATUS.UP),
      ]);
      await uptimeRobotService.poll();

      now += stableMs + 1_000;
      mockMonitorsOnce([
        fakeMonitor(700, 'plex.example', UPTIMEROBOT_STATUS.UP),
      ]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 1);

      const payload = JSON.parse(
        (sendNotificationMock.calls[0].arguments[1] as Buffer).toString('utf-8')
      );
      assert.strictEqual(payload.subject, 'Plex Server is back online');
      assert.strictEqual(payload.message, 'Streaming for the family');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('cancels a pending recovery if the monitor goes back down', async () => {
    await seedRecoverySubscription('friend@seerr.dev', 777);
    await seedPushSubscription('friend@seerr.dev', 'https://endpoint.test/c');

    const realDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;

    try {
      mockMonitorsOnce([fakeMonitor(777, 'Z', UPTIMEROBOT_STATUS.DOWN)]);
      await uptimeRobotService.poll();

      now += 1_000;
      mockMonitorsOnce([fakeMonitor(777, 'Z', UPTIMEROBOT_STATUS.UP)]);
      await uptimeRobotService.poll();

      now += 60_000;
      mockMonitorsOnce([fakeMonitor(777, 'Z', UPTIMEROBOT_STATUS.DOWN)]);
      await uptimeRobotService.poll();

      now += stableMs + 1_000;
      mockMonitorsOnce([fakeMonitor(777, 'Z', UPTIMEROBOT_STATUS.DOWN)]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 0);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('does not send recovery notifications when disabled in settings', async () => {
    getSettings().uptimerobot.recoveryNotificationsEnabled = false;
    await seedRecoverySubscription('friend@seerr.dev', 888);
    await seedPushSubscription('friend@seerr.dev', 'https://endpoint.test/d');

    const realDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;

    try {
      mockMonitorsOnce([fakeMonitor(888, 'M', UPTIMEROBOT_STATUS.DOWN)]);
      await uptimeRobotService.poll();

      now += stableMs + 60_000;
      mockMonitorsOnce([fakeMonitor(888, 'M', UPTIMEROBOT_STATUS.UP)]);
      await uptimeRobotService.poll();
      assert.strictEqual(sendNotificationMock.callCount(), 0);

      const subs = await getRepository(UserMonitorRecoverySubscription).find();
      assert.strictEqual(subs.length, 1);
    } finally {
      Date.now = realDateNow;
    }
  });
});
