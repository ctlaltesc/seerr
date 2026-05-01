import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAnnouncements1777300000000 implements MigrationInterface {
  name = 'CreateAnnouncements1777300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "announcement" (
        "id" SERIAL NOT NULL,
        "subject" character varying NOT NULL,
        "message" text,
        "postedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "postedById" integer,
        CONSTRAINT "PK_announcement" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_announcement_postedAt" ON "announcement" ("postedAt")`
    );
    await queryRunner.query(
      `ALTER TABLE "announcement" ADD CONSTRAINT "FK_announcement_postedBy" FOREIGN KEY ("postedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "announcement" DROP CONSTRAINT "FK_announcement_postedBy"`
    );
    await queryRunner.query(`DROP INDEX "IDX_announcement_postedAt"`);
    await queryRunner.query(`DROP TABLE "announcement"`);
  }
}
