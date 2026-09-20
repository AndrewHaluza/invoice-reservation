export type ConsumerStatus = 'up' | 'down';

// Process-global so the observability health probe can report the treasury
// consumer's connectivity without either module importing the other
// (observability may not import treasury). Defaults to 'up': readiness must not
// fail before a consumer has had a chance to start or when it is not run at all
// (FR-007c, R10 — a service that never runs the consumer is still ready).
let status: ConsumerStatus = 'up';

export function setConsumerStatus(next: ConsumerStatus): void {
  status = next;
}

export function getConsumerStatus(): ConsumerStatus {
  return status;
}

/** Tests only. */
export function resetConsumerStatus(): void {
  status = 'up';
}
