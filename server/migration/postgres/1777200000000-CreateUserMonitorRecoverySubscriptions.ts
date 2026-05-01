import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserMonitorRecoverySubscriptions1777200000000 implements MigrationInterface {
  name = 'CreateUserMonitorRecoverySubscriptions1777200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_monitor_recovery_subscription" (
        "id" SERIAL NOT NULL,
        "monitorId" integer NOT NULL,
        "createdAt" TIMESTAMP DEFAULT now(),
        "userId" integer,
        CONSTRAINT "UQ_user_monitor_recovery_user_monitor" UNIQUE ("userId", "monitorId"),
        CONSTRAINT "PK_user_monitor_recovery_subscription" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_monitor_recovery_user" ON "user_monitor_recovery_subscription" ("userId")`
    );
    await queryRunner.query(
      `ALTER TABLE "user_monitor_recovery_subscription" ADD CONSTRAINT "FK_user_monitor_recovery_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_monitor_recovery_subscription" DROP CONSTRAINT "FK_user_monitor_recovery_user"`
    );
    await queryRunner.query(`DROP INDEX "IDX_user_monitor_recovery_user"`);
    await queryRunner.query(`DROP TABLE "user_monitor_recovery_subscription"`);
  }
}
