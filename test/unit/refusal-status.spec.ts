import { REFUSAL_STATUS } from '../../src/capacity/api/error.filter';
import { REFUSAL_CODES } from '../../src/capacity/domain/errors';

describe('refusal status contract', () => {
  it('has no duplicate refusal codes', () => {
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
  });

  it('agrees with the status map on the exact set of codes', () => {
    const statusCodes = Object.keys(REFUSAL_STATUS).sort();
    const refusalCodes = [...REFUSAL_CODES].sort();

    expect(statusCodes).toEqual(refusalCodes);
    expect(new Set(statusCodes)).toEqual(new Set(refusalCodes));
  });

  it('maps POSITION_UNVERIFIED to 503', () => {
    expect(REFUSAL_STATUS.POSITION_UNVERIFIED).toBe(503);
  });

  it('maps NOT_FOUND to 404', () => {
    expect(REFUSAL_STATUS.NOT_FOUND).toBe(404);
  });

  it('maps INVALID_AMOUNT to 400', () => {
    expect(REFUSAL_STATUS.INVALID_AMOUNT).toBe(400);
  });

  it('maps every refusal to an integer between 400 and 599', () => {
    for (const status of Object.values(REFUSAL_STATUS)) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
  });
});
