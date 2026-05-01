import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAnnouncements1777300000000 implements MigrationInterface {
  name = 'CreateAnnouncements1777300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "announcement" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "subject" varchar NOT NULL,
        "message" text,
        "postedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "postedById" integer,
        CONSTRAINT "FK_announcement_postedBy" FOREIGN KEY ("postedById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_announcement_postedAt" ON "announcement" ("postedAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_announcement_postedAt"`);
    await queryRunner.query(`DROP TABLE "announcement"`);
  }
}
