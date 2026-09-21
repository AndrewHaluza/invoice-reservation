import { REFUSAL_CODES } from '../../src/capacity/domain/errors';
import { MESSAGES, REFUSAL_STATUS } from '../../src/capacity/api/error.filter';

const messages = MESSAGES as unknown as Record<string, string | undefined>;
const statuses = REFUSAL_STATUS as unknown as Record<string, number | undefined>;

describe('refusal code table completeness', () => {
  it('gives every refusal code a message', () => {
    const missing = REFUSAL_CODES.filter((code) => messages[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('gives every refusal code a status', () => {
    const missing = REFUSAL_CODES.filter((code) => statuses[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('has no empty or whitespace-only message', () => {
    const empty = REFUSAL_CODES.filter((code) => (messages[code] ?? '').trim() === '');
    expect(empty).toEqual([]);
  });

  it('maps every status to a 4xx or 5xx range', () => {
    const invalid = REFUSAL_CODES.filter((code) => {
      const status = statuses[code];
      return (
        status === undefined ||
        !Number.isInteger(status) ||
        status < 400 ||
        status >= 600
      );
    });
    expect(invalid).toEqual([]);
  });

  it('leaks no internals in any message', () => {
    const leaky = REFUSAL_CODES.filter((code) => {
      const message = messages[code] ?? '';
      return (
        /\b(select|insert|update|delete|from where)\b/i.test(message) ||
        message.includes('Error:')
      );
    });
    expect(leaky).toEqual([]);
  });

  it('has no stale message entry absent from the refusal codes', () => {
    const known = new Set<string>(REFUSAL_CODES);
    const stale = Object.keys(MESSAGES).filter((key) => !known.has(key));
    expect(stale).toEqual([]);
  });
});
