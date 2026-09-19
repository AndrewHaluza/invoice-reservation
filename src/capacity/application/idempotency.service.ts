import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';

export type IdempotencyDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly outcome: Record<string, unknown> }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'IDEMPOTENCY_CONFLICT'
        | 'IDEMPOTENCY_EXPIRED'
        | 'REQUEST_IN_FLIGHT';
    };

export interface RequestIdentity {
  readonly organisationId: string;
  readonly requestId: string;
  readonly operation: 'RESERVE' | 'RELEASE' | 'CANCEL';
  readonly fingerprint: string;
}

/** SHA-256 over the fields that determine the outcome (FR-006a). */
export function reserveFingerprint(input: {
  programId: string;
  invoiceId: string;
  amountMinor: string;
  currency: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.programId}|${input.invoiceId}|${input.amountMinor}|${input.currency}`,
    )
    .digest('hex');
}

interface RequestRecordRow {
  operation: 'RESERVE' | 'RELEASE' | 'CANCEL';
  state: 'PENDING' | 'COMPLETE' | 'EXPIRED';
  content_fingerprint: string;
  outcome: Record<string, unknown> | null;
}

@Injectable()
export class IdempotencyService {
  async begin(
    manager: EntityManager,
    identity: RequestIdentity,
    now: Date,
  ): Promise<IdempotencyDecision> {
    const inserted = await manager.query<{ request_id: string }[]>(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at)
       VALUES ($1, $2, $3, $4, 'PENDING', NULL, $5)
       ON CONFLICT (organisation_id, request_id) DO NOTHING
       RETURNING request_id`,
      [
        identity.organisationId,
        identity.requestId,
        identity.operation,
        identity.fingerprint,
        now,
      ],
    );

    if (inserted.length > 0) {
      return { kind: 'proceed' };
    }

    const rows = await manager.query<RequestRecordRow[]>(
      `SELECT operation, state, content_fingerprint, outcome
         FROM request_record
        WHERE organisation_id = $1 AND request_id = $2`,
      [identity.organisationId, identity.requestId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('request_record row vanished during idempotency lookup');
    }

    // The operation is part of the identity: a key first used to reserve must
    // not replay a release (or vice versa), even when the content matches.
    if (
      row.operation !== identity.operation ||
      row.content_fingerprint !== identity.fingerprint
    ) {
      return { kind: 'refused', code: 'IDEMPOTENCY_CONFLICT' };
    }

    switch (row.state) {
      case 'PENDING':
        return { kind: 'refused', code: 'REQUEST_IN_FLIGHT' };
      case 'EXPIRED':
        return { kind: 'refused', code: 'IDEMPOTENCY_EXPIRED' };
      case 'COMPLETE':
        if (row.outcome === null) {
          throw new Error(
            'request_record is COMPLETE without an outcome; the state/outcome constraint was violated',
          );
        }
        return { kind: 'replay', outcome: row.outcome };
      default:
        throw new Error('unexpected request_record state');
    }
  }

  async complete(
    manager: EntityManager,
    identity: RequestIdentity,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `UPDATE request_record
          SET state = 'COMPLETE', outcome = $3::jsonb
        WHERE organisation_id = $1 AND request_id = $2`,
      [identity.organisationId, identity.requestId, JSON.stringify(outcome)],
    );
  }
}
