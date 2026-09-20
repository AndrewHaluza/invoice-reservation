import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTreasuryAppliedEffectiveAt1758270000000
  implements MigrationInterface
{
  name = 'AddTreasuryAppliedEffectiveAt1758270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE program ADD COLUMN treasury_applied_effective_at TIMESTAMPTZ NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE program DROP COLUMN treasury_applied_effective_at;`,
    );
  }
}
