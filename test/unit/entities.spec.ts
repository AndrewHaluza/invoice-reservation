import {
  CapacityLedgerEntryEntity,
  FxRateEntity,
  InvoiceReservationEntity,
  OrganisationEntity,
  ProcessedMessageEntity,
  ProgramEntity,
  ProgramStreamPositionEntity,
  RequestRecordEntity,
  SnapshotAcknowledgementEntity,
  StreamPositionEntity,
  entities,
} from '../../src/capacity/infrastructure/entities';
import {
  LedgerRepository,
  ProgramRepository,
} from '../../src/capacity/infrastructure/repositories';

describe('entity and repository registries', () => {
  it('exports every entity class from the barrel and the registry array', () => {
    const instances = [
      new OrganisationEntity(),
      new ProgramEntity(),
      new InvoiceReservationEntity(),
      new CapacityLedgerEntryEntity(),
      new RequestRecordEntity(),
      new ProcessedMessageEntity(),
      new StreamPositionEntity(),
      new ProgramStreamPositionEntity(),
      new SnapshotAcknowledgementEntity(),
      new FxRateEntity(),
    ];

    for (const instance of instances) {
      expect(entities).toContain(instance.constructor);
    }
    expect(entities).toHaveLength(instances.length);
  });

  it('exposes the repository classes from the barrel', () => {
    expect(new ProgramRepository().toPosition).toBeDefined();
    expect(new LedgerRepository().sumByComponent).toBeDefined();
  });
});
