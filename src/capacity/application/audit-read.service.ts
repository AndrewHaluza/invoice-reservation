import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CapacityRefusal } from '../domain/errors';
import { LedgerCause, PositionComponent } from '../domain/ledger-entry';
import { InvoiceReservationEntity } from '../infrastructure/entities/invoice-reservation.entity';
import {
  MoneyBody,
  ReservationBody,
  toReservationBody,
} from './reservation.projection';

export type ReservationStatus = InvoiceReservationEntity['status'];

export interface Page<T> {
  readonly nextCursor: string | null;
  readonly items: readonly T[];
}

export interface ListReservationsQuery {
  readonly status?: ReservationStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListLedgerQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly cause?: LedgerCause;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface LedgerEntryBody {
  readonly sequence: number;
  readonly delta: MoneyBody;
  readonly component: PositionComponent;
  readonly cause: LedgerCause;
  readonly originReference: string | null;
  readonly actor: string;
  readonly correlationId: string;
  readonly occurredAt: string;
}

const RESERVATION_DEFAULT_LIMIT = 50;
const RESERVATION_MAX_LIMIT = 200;
const LEDGER_DEFAULT_LIMIT = 100;
const LEDGER_MAX_LIMIT = 1000;

interface InvoiceReservationRow {
  id: string;
  program_id: string;
  invoice_id: string;
  invoice_amount_minor: string;
  invoice_currency: string;
  program_currency: string;
  reserved_minor: string;
  outstanding_invoice_minor: string;
  outstanding_reserved_minor: string;
  fx_rate: string | null;
  fx_rate_effective_at: Date | null;
  fx_rate_source: string | null;
  status: ReservationStatus;
  created_at: Date;
  created_at_cursor: string;
}

interface LedgerEntryRow {
  sequence: string;
  delta_minor: string;
  component: PositionComponent;
  cause: LedgerCause;
  origin_reference: string | null;
  actor: string;
  correlation_id: string;
  occurred_at: Date;
}

interface CurrencyRow {
  currency: string;
}

interface ReservationCursor {
  createdAt: string;
  id: string;
}

interface LedgerCursor {
  sequence: string;
}

function encodeCursor(value: ReservationCursor | LedgerCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string): T {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'The cursor is malformed.',
    });
  }
}

function boundLimit(
  limit: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (limit === undefined) {
    return fallback;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'The limit is out of range.',
    });
  }
  return limit;
}

function toInvoiceReservationEntity(
  row: InvoiceReservationRow,
): InvoiceReservationEntity {
  const entity = new InvoiceReservationEntity();
  entity.id = row.id;
  entity.programId = row.program_id;
  entity.invoiceId = row.invoice_id;
  entity.invoiceAmountMinor = BigInt(row.invoice_amount_minor);
  entity.invoiceCurrency = row.invoice_currency;
  entity.programCurrency = row.program_currency;
  entity.reservedMinor = BigInt(row.reserved_minor);
  entity.outstandingInvoiceMinor = BigInt(row.outstanding_invoice_minor);
  entity.outstandingReservedMinor = BigInt(row.outstanding_reserved_minor);
  entity.fxRate = row.fx_rate;
  entity.fxRateEffectiveAt = row.fx_rate_effective_at;
  entity.fxRateSource = row.fx_rate_source;
  entity.status = row.status;
  entity.createdAt = row.created_at;
  return entity;
}

@Injectable()
export class AuditReadService {
  constructor(private readonly dataSource: DataSource) {}

  // Paged on (created_at DESC, id DESC). `created_at` is not unique, so the id
  // tiebreak is what makes the page deterministic; a cursor on the timestamp
  // alone would skip or repeat rows.
  async listReservations(
    programId: string,
    query: ListReservationsQuery,
  ): Promise<Page<ReservationBody>> {
    const limit = boundLimit(
      query.limit,
      RESERVATION_DEFAULT_LIMIT,
      RESERVATION_MAX_LIMIT,
    );

    const parameters: unknown[] = [programId];
    const conditions: string[] = ['program_id = $1'];

    if (query.status !== undefined) {
      parameters.push(query.status);
      conditions.push(`status = $${parameters.length}`);
    }

    if (query.cursor !== undefined) {
      const cursor = decodeCursor<ReservationCursor>(query.cursor);
      parameters.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(created_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`,
      );
    }

    parameters.push(limit + 1);
    const rows = await this.dataSource.query<InvoiceReservationRow[]>(
      `SELECT *,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
         FROM invoice_reservation
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${parameters.length}`,
      parameters,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({
              createdAt: last.created_at_cursor,
              id: last.id,
            })
          : null,
      items: page.map((row) => toReservationBody(toInvoiceReservationEntity(row))),
    };
  }

  async getReservation(
    programId: string,
    invoiceId: string,
  ): Promise<ReservationBody> {
    const rows = await this.dataSource.query<InvoiceReservationRow[]>(
      `SELECT *
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, invoiceId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new CapacityRefusal('NOT_FOUND');
    }
    return toReservationBody(toInvoiceReservationEntity(row));
  }

  // Paged on `sequence DESC`, not `occurred_at`: sequence is gapless and totally
  // ordered per program, so the cursor is deterministic on ties.
  async listLedger(
    programId: string,
    query: ListLedgerQuery,
  ): Promise<Page<LedgerEntryBody>> {
    const limit = boundLimit(
      query.limit,
      LEDGER_DEFAULT_LIMIT,
      LEDGER_MAX_LIMIT,
    );
    const currency = await this.programCurrency(programId);

    const parameters: unknown[] = [programId];
    const conditions: string[] = ['program_id = $1'];

    if (query.from !== undefined) {
      parameters.push(query.from);
      conditions.push(`occurred_at >= $${parameters.length}::timestamptz`);
    }
    if (query.to !== undefined) {
      parameters.push(query.to);
      conditions.push(`occurred_at <= $${parameters.length}::timestamptz`);
    }
    if (query.cause !== undefined) {
      parameters.push(query.cause);
      conditions.push(`cause = $${parameters.length}`);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor<LedgerCursor>(query.cursor);
      parameters.push(cursor.sequence);
      conditions.push(`sequence < $${parameters.length}::bigint`);
    }

    parameters.push(limit + 1);
    const rows = await this.dataSource.query<LedgerEntryRow[]>(
      `SELECT *
         FROM capacity_ledger_entry
        WHERE ${conditions.join(' AND ')}
        ORDER BY sequence DESC
        LIMIT $${parameters.length}`,
      parameters,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ sequence: last.sequence })
          : null,
      items: page.map((row) => ({
        sequence: Number(row.sequence),
        delta: {
          amountMinor: BigInt(row.delta_minor).toString(),
          currency,
        },
        component: row.component,
        cause: row.cause,
        originReference: row.origin_reference,
        actor: row.actor,
        correlationId: row.correlation_id,
        occurredAt: row.occurred_at.toISOString(),
      })),
    };
  }

  private async programCurrency(programId: string): Promise<string> {
    const rows = await this.dataSource.query<CurrencyRow[]>(
      'SELECT currency FROM program WHERE id = $1',
      [programId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new CapacityRefusal('NOT_FOUND');
    }
    return row.currency;
  }
}
