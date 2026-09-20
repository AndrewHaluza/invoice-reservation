import { MigrationInterface, QueryRunner } from 'typeorm';

// The phase 2 trigger is the backstop for the reservation path: a direct write
// that raises `local_reserved_minor` above the limit is a bug. A reconciliation
// snapshot is the one legitimate writer that may need to raise the LOCAL
// component while the program is, or becomes, over-limit (FR-011g, FR-011c) —
// the plan tolerates `total > limit`, and refusing here would strand the
// correction forever. `apply-snapshot.service.ts` sets
// `capacity.reconciliation_in_progress = 'on'` for the duration of its
// transaction; the trigger stands down only for that write. The reservation
// path never sets the setting, so the backstop is unchanged for it.
export class SnapshotLocalCorrectionTrigger1758260000000
  implements MigrationInterface
{
  name = 'SnapshotLocalCorrectionTrigger1758260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_local_within_limit() RETURNS trigger AS $$
      BEGIN
        IF current_setting('capacity.reconciliation_in_progress', true) = 'on' THEN
          RETURN NEW;
        END IF;
        IF NEW.local_reserved_minor > NEW.credit_limit_minor THEN
          RAISE EXCEPTION 'local reserved %:% exceeds credit limit %',
            NEW.id, NEW.local_reserved_minor, NEW.credit_limit_minor
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_local_within_limit() RETURNS trigger AS $$
      BEGIN
        IF NEW.local_reserved_minor > NEW.credit_limit_minor THEN
          RAISE EXCEPTION 'local reserved %:% exceeds credit limit %',
            NEW.id, NEW.local_reserved_minor, NEW.credit_limit_minor
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
  }
}
