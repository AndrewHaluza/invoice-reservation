import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExpiredRequestState1758250000000 implements MigrationInterface {
  name = 'AddExpiredRequestState1758250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'EXPIRED';`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop a value from an enum. The type is rebuilt without it.
    // Any row already carrying EXPIRED would block this, which is correct: the
    // down migration must refuse rather than silently discard an expiry tombstone.
    // The CHECK constraint is dropped and restored verbatim around the rebuild:
    // PostgreSQL stores its 'COMPLETE' literal as the old enum type, so the
    // constraint cannot be recompiled against the rebuilt type. Restoring the
    // identical expression leaves the constraint semantically unchanged.
    await queryRunner.query(
      `ALTER TABLE request_record DROP CONSTRAINT request_record_state_outcome;`,
    );
    await queryRunner.query(`ALTER TYPE request_state RENAME TO request_state_old;`);
    await queryRunner.query(`CREATE TYPE request_state AS ENUM ('PENDING', 'COMPLETE');`);
    await queryRunner.query(
      `ALTER TABLE request_record
         ALTER COLUMN state TYPE request_state
         USING state::text::request_state;`,
    );
    await queryRunner.query(
      `ALTER TABLE request_record
         ADD CONSTRAINT request_record_state_outcome
         CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL));`,
    );
    await queryRunner.query(`DROP TYPE request_state_old;`);
  }
}
