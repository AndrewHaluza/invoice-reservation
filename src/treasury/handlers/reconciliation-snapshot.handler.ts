import { Injectable } from '@nestjs/common';
import {
  ApplySnapshotService,
  SnapshotQuarantineReason,
} from '../../capacity/application/apply-snapshot.service';
import { parseReconciliationSnapshot } from '../schemas/reconciliation-snapshot.schema';
import { InboundMessage } from './capacity-event.handler';

export type SnapshotHandleQuarantineReason =
  | SnapshotQuarantineReason
  | 'SCHEMA_INVALID';

export type SnapshotHandleOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'quarantined';
      readonly reason: SnapshotHandleQuarantineReason;
    };

@Injectable()
export class ReconciliationSnapshotHandler {
  constructor(private readonly applyService: ApplySnapshotService) {}

  async handle(message: InboundMessage): Promise<SnapshotHandleOutcome> {
    const parsed = parseReconciliationSnapshot(message.value);
    if (!parsed.ok) {
      return { kind: 'quarantined', reason: 'SCHEMA_INVALID' };
    }

    const snapshot = parsed.snapshot;

    // Identity dedupe, then the staleness rule; stale snapshots are ignored
    // before the acknowledgement marker is even considered.
    const inspected = await this.applyService.inspect(snapshot);
    if (inspected.kind === 'quarantined') {
      return { kind: 'quarantined', reason: inspected.reason };
    }
    if (inspected.kind === 'ignored') {
      return { kind: 'skipped' };
    }

    // FR-011b: without a marker the additive rule cannot be applied safely.
    if (snapshot.acknowledgement === null) {
      return { kind: 'quarantined', reason: 'MISSING_ACK_MARKER' };
    }

    const outcome = await this.applyService.apply(snapshot, {
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    });
    if (outcome.kind === 'quarantined') {
      return { kind: 'quarantined', reason: outcome.reason };
    }
    if (outcome.kind === 'applied') {
      return { kind: 'applied' };
    }
    return { kind: 'skipped' };
  }
}
