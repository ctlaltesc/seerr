import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Grants the two new status-page permissions (STATUS_VIEW = 1,
 * STATUS_REPORT = 536870912) to every existing user so accounts created
 * before this fork's status feature don't suddenly lose access. New
 * users created from now on inherit these bits via `defaultPermissions`.
 */
export class GrantStatusPermissions1777500000000 implements MigrationInterface {
  name = 'GrantStatusPermissions1777500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "user" SET "permissions" = "permissions" | 1 | 536870912`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Strip both bits on rollback. Bitwise NOT in SQLite is `~`.
    await queryRunner.query(
      `UPDATE "user" SET "permissions" = "permissions" & ~1 & ~536870912`
    );
  }
}
