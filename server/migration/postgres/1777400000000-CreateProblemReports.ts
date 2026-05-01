import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProblemReports1777400000000 implements MigrationInterface {
  name = 'CreateProblemReports1777400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "problem_report" (
        "id" SERIAL NOT NULL,
        "monitorId" integer NOT NULL,
        "monitorNameSnapshot" character varying NOT NULL,
        "monitorStatusAtReport" character varying NOT NULL,
        "reportedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "resolvedAt" TIMESTAMP,
        "reporterId" integer,
        CONSTRAINT "PK_problem_report" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_problem_report_monitor" ON "problem_report" ("monitorId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_problem_report_reporter" ON "problem_report" ("reporterId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_problem_report_reportedAt" ON "problem_report" ("reportedAt")`
    );
    await queryRunner.query(
      `ALTER TABLE "problem_report" ADD CONSTRAINT "FK_problem_report_reporter" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "problem_report" DROP CONSTRAINT "FK_problem_report_reporter"`
    );
    await queryRunner.query(`DROP INDEX "IDX_problem_report_reportedAt"`);
    await queryRunner.query(`DROP INDEX "IDX_problem_report_reporter"`);
    await queryRunner.query(`DROP INDEX "IDX_problem_report_monitor"`);
    await queryRunner.query(`DROP TABLE "problem_report"`);
  }
}
