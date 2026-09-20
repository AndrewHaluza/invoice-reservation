import { Injectable } from '@nestjs/common';
import { ApplyTreasuryEventService } from '../../capacity/application/apply-treasury-event.service';
import { parseCapacityEvent } from '../schemas/capacity-event.schema';

export interface InboundMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Record<string, string | Buffer | undefined>;
}

export type QuarantineReason =
  | 'SCHEMA_INVALID'
  | 'UNKNOWN_PROGRAM'
  | 'CURRENCY_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'HANDLER_FAILURE';

export type HandleOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'quarantined'; readonly reason: QuarantineReason };

@Injectable()
export class CapacityEventHandler {
  constructor(private readonly applyService: ApplyTreasuryEventService) {}

  async handle(message: InboundMessage): Promise<HandleOutcome> {
    const parsed = parseCapacityEvent(message.value);
    if (!parsed.ok) {
      return { kind: 'quarantined', reason: 'SCHEMA_INVALID' };
    }

    const inspected = await this.applyService.inspect(parsed.event);
    if (inspected.kind === 'quarantined') {
      return { kind: 'quarantined', reason: inspected.reason };
    }
    if (inspected.kind === 'already_applied') {
      return { kind: 'skipped' };
    }

    const outcome = await this.applyService.apply(parsed.event, {
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
