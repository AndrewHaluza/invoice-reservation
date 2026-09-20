import { StreamLagRegistry } from '../../src/shared/stream-lag';

describe('StreamLagRegistry', () => {
  let registry: StreamLagRegistry;

  beforeEach(() => {
    registry = new StreamLagRegistry();
  });

  it('returns null for a program with no observation', () => {
    expect(registry.newestObservedFor('unknown')).toBeNull();
  });

  it('returns the observed effective time for a program', () => {
    registry.observe('program-a', 1500);
    expect(registry.newestObservedFor('program-a')).toBe(1500);
  });

  it('keeps the newest effective time when an older one is observed afterwards', () => {
    registry.observe('program-a', 2000);
    registry.observe('program-a', 1000);
    expect(registry.newestObservedFor('program-a')).toBe(2000);
  });

  it('tracks programs independently', () => {
    registry.observe('program-a', 1000);
    registry.observe('program-b', 3000);
    expect(registry.newestObservedFor('program-a')).toBe(1000);
    expect(registry.newestObservedFor('program-b')).toBe(3000);
  });

  it('ignores a non-positive effective time', () => {
    registry.observe('program-a', -1);
    expect(registry.newestObservedFor('program-a')).toBeNull();
  });
});
