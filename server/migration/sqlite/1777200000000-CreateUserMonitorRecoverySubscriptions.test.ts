import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

/**
 * Boots a fresh in-memory SQLite DataSource and runs the actual migration
 * chain — no `synchronize: true` — so the migration SQL is exercised end
 * to end. Uses an isolated DataSource (rather than the shared singleton
 * in @server/datasource) so this test can't interfere with the other
 * test files that rely on `setupTestDb` + synchronize.
 */
describe('Migration: 1777200000000 CreateUserMonitorRecoverySubscriptions (sqlite)', () => {
  let ds: DataSource;

  before(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      entities: ['server/entity/**/*.ts'],
      migrations: ['server/migration/sqlite/**/*.ts'],
      subscribers: ['server/subscriber/**/*.ts'],
    });
    await ds.initialize();
    await ds.runMigrations();
  });

  after(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('creates the user_monitor_recovery_subscription table', async () => {
    const rows = await ds.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_monitor_recovery_subscription'"
    );
    assert.strictEqual(rows.length, 1);
  });

  it('declares the expected columns', async () => {
    const cols: { name: string; type: string; notnull: number }[] =
      await ds.query("PRAGMA table_info('user_monitor_recovery_subscription')");
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.ok(byName.id, 'id column is missing');
    assert.ok(byName.monitorId, 'monitorId column is missing');
    assert.ok(byName.userId, 'userId column is missing');
    assert.ok(byName.createdAt, 'createdAt column is missing');
    assert.strictEqual(byName.monitorId.notnull, 1);
  });

  it('declares the user FK with cascade delete', async () => {
    const fks: {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[] = await ds.query(
      "PRAGMA foreign_key_list('user_monitor_recovery_subscription')"
    );
    const userFk = fks.find((fk) => fk.table === 'user');
    assert.ok(userFk, 'user FK is missing');
    assert.strictEqual(userFk!.from, 'userId');
    assert.strictEqual(userFk!.to, 'id');
    assert.strictEqual(userFk!.on_delete, 'CASCADE');
  });

  it('declares the (userId, monitorId) unique constraint', async () => {
    const indexes: { name: string; unique: number }[] = await ds.query(
      "PRAGMA index_list('user_monitor_recovery_subscription')"
    );
    const uniqueIndex = indexes.find((i) => i.unique === 1);
    assert.ok(uniqueIndex, 'unique constraint is missing');

    const cols: { name: string }[] = await ds.query(
      `PRAGMA index_info('${uniqueIndex!.name}')`
    );
    const colNames = cols.map((c) => c.name).sort();
    assert.deepStrictEqual(colNames, ['monitorId', 'userId']);
  });

  it('rejects duplicate (userId, monitorId) inserts', async () => {
    await ds.query(`PRAGMA foreign_keys = ON`);
    await ds.query(
      `INSERT INTO "user" ("email", "userType", "permissions", "avatar")
         VALUES ('dup-test@seerr.dev', 1, 0, '')`
    );
    const created = await ds.query(
      `SELECT id FROM "user" WHERE email = 'dup-test@seerr.dev'`
    );
    const userId = created[0].id;

    await ds.query(
      `INSERT INTO "user_monitor_recovery_subscription" ("userId", "monitorId") VALUES (?, ?)`,
      [userId, 4242]
    );
    await assert.rejects(
      ds.query(
        `INSERT INTO "user_monitor_recovery_subscription" ("userId", "monitorId") VALUES (?, ?)`,
        [userId, 4242]
      ),
      /UNIQUE/
    );
  });

  it('cascades deletes when the user is removed', async () => {
    await ds.query(`PRAGMA foreign_keys = ON`);
    await ds.query(
      `INSERT INTO "user" ("email", "userType", "permissions", "avatar")
         VALUES ('cascade-test@seerr.dev', 1, 0, '')`
    );
    const created = await ds.query(
      `SELECT id FROM "user" WHERE email = 'cascade-test@seerr.dev'`
    );
    const userId = created[0].id;

    await ds.query(
      `INSERT INTO "user_monitor_recovery_subscription" ("userId", "monitorId") VALUES (?, ?)`,
      [userId, 7777]
    );
    const beforeCount = await ds.query(
      `SELECT COUNT(*) as c FROM "user_monitor_recovery_subscription" WHERE "userId" = ?`,
      [userId]
    );
    assert.strictEqual(Number(beforeCount[0].c), 1);

    await ds.query(`DELETE FROM "user" WHERE id = ?`, [userId]);

    const afterCount = await ds.query(
      `SELECT COUNT(*) as c FROM "user_monitor_recovery_subscription" WHERE "userId" = ?`,
      [userId]
    );
    assert.strictEqual(Number(afterCount[0].c), 0);
  });
});
