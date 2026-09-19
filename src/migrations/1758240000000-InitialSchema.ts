import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1758240000000 implements MigrationInterface {
  name = 'InitialSchema1758240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await queryRunner.query(
      `CREATE TYPE reservation_status AS ENUM ('ACTIVE', 'PARTIALLY_RELEASED', 'FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF');`,
    );
    await queryRunner.query(
      `CREATE TYPE reservation_origin AS ENUM ('LOCAL', 'TREASURY');`,
    );
    await queryRunner.query(
      `CREATE TYPE position_component AS ENUM ('LOCAL', 'TREASURY', 'LIMIT');`,
    );
    await queryRunner.query(
      `CREATE TYPE ledger_cause AS ENUM ('RESERVATION', 'RELEASE', 'CANCELLATION', 'WRITE_OFF', 'TREASURY_EVENT', 'LIMIT_CHANGE', 'RECONCILIATION_ADJUSTMENT', 'OVER_LIMIT_ONSET', 'OVER_LIMIT_CLEARED');`,
    );
    await queryRunner.query(
      `CREATE TYPE request_state AS ENUM ('PENDING', 'COMPLETE');`,
    );
    await queryRunner.query(
      `CREATE TYPE message_kind AS ENUM ('EVENT', 'SNAPSHOT');`,
    );
    await queryRunner.query(
      `CREATE TYPE ack_kind AS ENUM ('EXPLICIT', 'WATERMARK');`,
    );

    await queryRunner.query(`
      CREATE TABLE organisation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE program (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id UUID NOT NULL REFERENCES organisation(id),
        currency CHAR(3) NOT NULL,
        credit_limit_minor BIGINT NOT NULL DEFAULT 0,
        local_reserved_minor BIGINT NOT NULL DEFAULT 0,
        treasury_reserved_minor BIGINT NOT NULL DEFAULT 0,
        next_sequence BIGINT NOT NULL DEFAULT 1,
        over_limit_since TIMESTAMPTZ NULL,
        treasury_version BIGINT NOT NULL DEFAULT 0,
        treasury_effective_at TIMESTAMPTZ NULL,
        position_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        investigation_required BOOLEAN NOT NULL DEFAULT FALSE,
        position_verified BOOLEAN NOT NULL DEFAULT TRUE,
        CONSTRAINT program_local_reserved_non_negative CHECK (local_reserved_minor >= 0),
        CONSTRAINT program_treasury_reserved_non_negative CHECK (treasury_reserved_minor >= 0),
        CONSTRAINT program_credit_limit_non_negative CHECK (credit_limit_minor >= 0),
        CONSTRAINT program_currency_iso4217 CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    await queryRunner.query(`
      CREATE TABLE invoice_reservation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES program(id) ON DELETE RESTRICT,
        invoice_id TEXT NOT NULL,
        invoice_amount_minor BIGINT NOT NULL,
        invoice_currency CHAR(3) NOT NULL,
        program_currency CHAR(3) NOT NULL,
        reserved_minor BIGINT NOT NULL,
        outstanding_invoice_minor BIGINT NOT NULL,
        outstanding_reserved_minor BIGINT NOT NULL,
        fx_rate NUMERIC(20,10) NULL,
        fx_rate_effective_at TIMESTAMPTZ NULL,
        fx_rate_source TEXT NULL,
        status reservation_status NOT NULL,
        origin reservation_origin NOT NULL,
        treasury_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        acknowledged_by_version BIGINT NULL,
        treasury_reference TEXT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT invoice_reservation_program_invoice_unique UNIQUE (program_id, invoice_id),
        CONSTRAINT invoice_reservation_amounts_positive CHECK (invoice_amount_minor > 0 AND reserved_minor > 0),
        CONSTRAINT invoice_reservation_outstanding_invoice_bounded CHECK (outstanding_invoice_minor BETWEEN 0 AND invoice_amount_minor),
        CONSTRAINT invoice_reservation_outstanding_reserved_bounded CHECK (outstanding_reserved_minor BETWEEN 0 AND reserved_minor),
        CONSTRAINT invoice_reservation_fx_presence CHECK ((invoice_currency = program_currency) = (fx_rate IS NULL)),
        CONSTRAINT invoice_reservation_fx_positive CHECK (fx_rate IS NULL OR fx_rate > 0),
        CONSTRAINT invoice_reservation_ack_version CHECK (treasury_acknowledged = (acknowledged_by_version IS NOT NULL))
      );
    `);

    await queryRunner.query(`
      CREATE TABLE capacity_ledger_entry (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES program(id) ON DELETE RESTRICT,
        sequence BIGINT NOT NULL,
        delta_minor BIGINT NOT NULL,
        component position_component NOT NULL,
        cause ledger_cause NOT NULL,
        origin_reference TEXT NULL,
        actor TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT capacity_ledger_entry_program_sequence_unique UNIQUE (program_id, sequence)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE request_record (
        organisation_id UUID NOT NULL REFERENCES organisation(id),
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        state request_state NOT NULL,
        outcome JSONB NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT request_record_pkey PRIMARY KEY (organisation_id, request_id),
        CONSTRAINT request_record_state_outcome CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))
      );
    `);

    await queryRunner.query(`
      CREATE TABLE processed_message (
        message_id TEXT PRIMARY KEY,
        program_id UUID NOT NULL,
        kind message_kind NOT NULL,
        version BIGINT NOT NULL,
        content_hash TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE stream_position (
        topic TEXT NOT NULL,
        partition INT NOT NULL,
        "offset" BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT stream_position_pkey PRIMARY KEY (topic, partition)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE program_stream_position (
        program_id UUID NOT NULL REFERENCES program(id),
        topic TEXT NOT NULL,
        partition INT NOT NULL,
        "offset" BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT program_stream_position_pkey PRIMARY KEY (program_id, topic, partition)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE snapshot_acknowledgement (
        message_id TEXT PRIMARY KEY REFERENCES processed_message(message_id),
        program_id UUID NOT NULL,
        version BIGINT NOT NULL,
        kind ack_kind NOT NULL,
        reservation_references TEXT[] NULL,
        ingested_through TIMESTAMPTZ NULL,
        CONSTRAINT snapshot_acknowledgement_explicit CHECK ((kind = 'EXPLICIT') = (reservation_references IS NOT NULL)),
        CONSTRAINT snapshot_acknowledgement_watermark CHECK ((kind = 'WATERMARK') = (ingested_through IS NOT NULL))
      );
    `);

    await queryRunner.query(`
      CREATE TABLE fx_rate (
        base_currency CHAR(3) NOT NULL,
        quote_currency CHAR(3) NOT NULL,
        effective_at TIMESTAMPTZ NOT NULL,
        rate NUMERIC(20,10) NOT NULL,
        source TEXT NOT NULL,
        CONSTRAINT fx_rate_pkey PRIMARY KEY (base_currency, quote_currency, effective_at)
      );
    `);

    await queryRunner.query(`
      CREATE FUNCTION assert_local_within_limit() RETURNS trigger AS $$
      BEGIN
        IF NEW.local_reserved_minor > NEW.credit_limit_minor THEN
          RAISE EXCEPTION 'local reserved %:% exceeds credit limit %',
            NEW.id, NEW.local_reserved_minor, NEW.credit_limit_minor
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER program_local_within_limit
        BEFORE UPDATE ON program FOR EACH ROW
        WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)
        EXECUTE FUNCTION assert_local_within_limit();
    `);

    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;`,
    );
    await queryRunner.query(
      `REVOKE UPDATE, DELETE ON capacity_ledger_entry FROM app_role;`,
    );

    await queryRunner.query(
      `CREATE INDEX idx_program_organisation ON program (organisation_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_reservation_program_status ON invoice_reservation (program_id, status, created_at DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_reservation_unacked ON invoice_reservation (program_id) WHERE origin = 'LOCAL' AND NOT treasury_acknowledged;`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_reservation_treasury_ref ON invoice_reservation (program_id, treasury_reference);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_ledger_program_sequence ON capacity_ledger_entry (program_id, sequence DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_ledger_program_cause_sequence ON capacity_ledger_entry (program_id, cause, sequence DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_request_recorded_at ON request_record (recorded_at);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_processed_message_processed_at ON processed_message (processed_at);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_processed_message_processed_at;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_request_recorded_at;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ledger_program_cause_sequence;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ledger_program_sequence;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_reservation_treasury_ref;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_reservation_unacked;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_reservation_program_status;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_program_organisation;`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS program_local_within_limit ON program;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_local_within_limit();`);

    await queryRunner.query(`DROP TABLE IF EXISTS snapshot_acknowledgement;`);
    await queryRunner.query(`DROP TABLE IF EXISTS program_stream_position;`);
    await queryRunner.query(`DROP TABLE IF EXISTS stream_position;`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_message;`);
    await queryRunner.query(`DROP TABLE IF EXISTS request_record;`);
    await queryRunner.query(`DROP TABLE IF EXISTS capacity_ledger_entry;`);
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_reservation;`);
    await queryRunner.query(`DROP TABLE IF EXISTS fx_rate;`);
    await queryRunner.query(`DROP TABLE IF EXISTS program;`);
    await queryRunner.query(`DROP TABLE IF EXISTS organisation;`);

    await queryRunner.query(`DROP TYPE IF EXISTS ack_kind;`);
    await queryRunner.query(`DROP TYPE IF EXISTS message_kind;`);
    await queryRunner.query(`DROP TYPE IF EXISTS request_state;`);
    await queryRunner.query(`DROP TYPE IF EXISTS ledger_cause;`);
    await queryRunner.query(`DROP TYPE IF EXISTS position_component;`);
    await queryRunner.query(`DROP TYPE IF EXISTS reservation_origin;`);
    await queryRunner.query(`DROP TYPE IF EXISTS reservation_status;`);
  }
}
