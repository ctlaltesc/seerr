import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserMonitorRecoverySubscriptions1777200000000
  implements MigrationInterface
{
  name = 'CreateUserMonitorRecoverySubscriptions1777200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_monitor_recovery_subscription" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "monitorId" integer NOT NULL,
        "createdAt" datetime DEFAULT (CURRENT_TIMESTAMP),
        "userId" integer,
        CONSTRAINT "UQ_user_monitor_recovery_user_monitor" UNIQUE ("userId", "monitorId"),
        CONSTRAINT "FK_user_monitor_recovery_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_monitor_recovery_user" ON "user_monitor_recovery_subscription" ("userId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_user_monitor_recovery_user"`);
    await queryRunner.query(`DROP TABLE "user_monitor_recovery_subscription"`);
  }
}
