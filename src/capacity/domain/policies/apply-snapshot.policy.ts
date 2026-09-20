import { ProgramPosition } from '../program';

/**
 * The acknowledgement marker a snapshot carried, as plain data. The policy is
 * the only place the marker is applied, so the ordering marker-then-sums
 * (FR-011d) is expressed here rather than in the service.
 */
export interface SnapshotMarkerInput {
  readonly kind: 'EXPLICIT' | 'WATERMARK';
  readonly reservationReferences: readonly string[] | null;
  readonly ingestedThrough: Date | null;
}

/** A reservation as the snapshot arithmetic sees it. Plain data; no ORM. */
export interface SnapshotReservation {
  readonly id: string;
  readonly origin: 'LOCAL' | 'TREASURY';
  readonly outstandingReservedMinor: bigint;
  readonly treasuryAcknowledged: boolean;
  readonly acknowledgedByVersion: bigint | null;
  readonly treasuryReference: string | null;
  readonly confirmedAt: Date;
}

export interface ApplySnapshotInput {
  readonly program: ProgramPosition;
  readonly version: bigint;
  readonly reservedMinor: bigint;
  readonly creditLimitMinor: bigint;
  readonly marker: SnapshotMarkerInput;
  readonly reservations: readonly SnapshotReservation[];
}

export interface SnapshotDeltas {
  readonly treasury: bigint;
  readonly local: bigint;
  readonly limit: bigint;
}

export type SnapshotDecision =
  | {
      readonly kind: 'apply';
      /** Reservations this snapshot's marker acknowledges (to be flagged). */
      readonly acknowledgedReservationIds: readonly string[];
      readonly investigationRequired: boolean;
      readonly deltas: SnapshotDeltas;
    }
  | { readonly kind: 'refuse'; readonly reason: 'SNAPSHOT_INCONSISTENT' };

function markerMatches(
  marker: SnapshotMarkerInput,
  reservation: SnapshotReservation,
): boolean {
  if (marker.kind === 'EXPLICIT') {
    return (
      reservation.treasuryReference !== null &&
      (marker.reservationReferences ?? []).includes(reservation.treasuryReference)
    );
  }
  return (
    marker.ingestedThrough !== null &&
    reservation.confirmedAt.getTime() <= marker.ingestedThrough.getTime()
  );
}

/**
 * Applies a snapshot's acknowledgement marker FIRST, then derives the totals
 * from the marked reservation set. The two orderings differ by exactly the
 * amount newly acknowledged (FR-011d); this function is the requirement.
 *
 * Pure: takes plain readonly inputs and performs no I/O.
 */
export function applySnapshotPolicy(input: ApplySnapshotInput): SnapshotDecision {
  const { program, marker, reservations, version, reservedMinor, creditLimitMinor } =
    input;

  // 1. Apply the acknowledgement marker. FR-011e: a marker from a snapshot no
  //    newer than the one that last acknowledged a reservation is not applied to
  //    it — the stale marker skips that reservation and the rest proceeds.
  const acknowledgedReservationIds: string[] = [];
  const marked: SnapshotReservation[] = reservations.map((reservation) => {
    if (!markerMatches(marker, reservation)) {
      return reservation;
    }
    if (
      reservation.acknowledgedByVersion !== null &&
      reservation.acknowledgedByVersion >= version
    ) {
      return reservation;
    }
    acknowledgedReservationIds.push(reservation.id);
    return {
      ...reservation,
      treasuryAcknowledged: true,
      acknowledgedByVersion: version,
    };
  });

  // 2. The sums, computed after the marker has been applied.
  let ackedLocal = 0n;
  let localTotal = 0n;
  for (const reservation of marked) {
    if (reservation.origin !== 'LOCAL') {
      continue;
    }
    localTotal += reservation.outstandingReservedMinor;
    if (reservation.treasuryAcknowledged) {
      ackedLocal += reservation.outstandingReservedMinor;
    }
  }

  // 3. Targets. The decomposition is only valid while the snapshot's reserved
  //    total genuinely includes every reservation its marker acknowledges; a
  //    negative target would write a negative TREASURY component, so refuse.
  const targetTreasury = reservedMinor - ackedLocal;
  if (targetTreasury < 0n) {
    return { kind: 'refuse', reason: 'SNAPSHOT_INCONSISTENT' };
  }
  const targetLocal = localTotal;

  // 4. The three per-component deltas.
  return {
    kind: 'apply',
    acknowledgedReservationIds,
    investigationRequired: targetLocal !== program.localReservedMinor,
    deltas: {
      treasury: targetTreasury - program.treasuryReservedMinor,
      local: targetLocal - program.localReservedMinor,
      limit: creditLimitMinor - program.creditLimitMinor,
    },
  };
}
