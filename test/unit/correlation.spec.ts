import {
  CORRELATION_HEADER,
  CorrelationMiddleware,
  MAX_CORRELATION_LENGTH,
  correlationFromKafkaHeaders,
  currentCorrelationId,
  resolveCorrelationId,
  sanitiseCorrelationId,
} from '../../src/shared/correlation';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('correlation', () => {
  it('round-trips a valid id unchanged', () => {
    expect(sanitiseCorrelationId('abc-123')).toBe('abc-123');
    expect(resolveCorrelationId('abc-123')).toBe('abc-123');
  });

  it('rejects a 129-character id and resolves a UUID instead', () => {
    const tooLong = 'a'.repeat(MAX_CORRELATION_LENGTH + 1);
    expect(sanitiseCorrelationId(tooLong)).toBeNull();
    expect(resolveCorrelationId(tooLong)).toMatch(UUID_V4);
  });

  it('rejects the repeated-header array shape', () => {
    expect(sanitiseCorrelationId(['a', 'b'])).toBeNull();
  });

  it('rejects the format-string injection case', () => {
    expect(sanitiseCorrelationId('%s%s%s')).toBeNull();
  });

  it('rejects the SQL-injection-shaped value', () => {
    expect(sanitiseCorrelationId("a' OR 1=1")).toBeNull();
  });

  it('rejects empty, undefined, null, numeric and object values', () => {
    expect(sanitiseCorrelationId('')).toBeNull();
    expect(sanitiseCorrelationId(undefined)).toBeNull();
    expect(sanitiseCorrelationId(null)).toBeNull();
    expect(sanitiseCorrelationId(42)).toBeNull();
    expect(sanitiseCorrelationId({})).toBeNull();
  });

  it('resolveCorrelationId(undefined) returns a UUID v4', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V4);
  });

  it('decodes a Buffer Kafka header', () => {
    expect(
      correlationFromKafkaHeaders({
        [CORRELATION_HEADER]: Buffer.from('abc-123'),
      }),
    ).toBe('abc-123');
  });

  it('propagates the id to the request, the response and the async store', () => {
    type MiddlewareArgs = Parameters<CorrelationMiddleware['use']>;
    const request = {
      headers: { [CORRELATION_HEADER]: 'abc-123' },
    } as unknown as MiddlewareArgs[0];
    const setHeader = jest.fn();
    const response = { setHeader } as unknown as MiddlewareArgs[1];
    let insideNext: string | undefined;
    const next = ((): void => {
      insideNext = currentCorrelationId();
    }) as MiddlewareArgs[2];

    new CorrelationMiddleware().use(request, response, next);

    expect(
      (request as unknown as { correlationId?: string }).correlationId,
    ).toBe('abc-123');
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_HEADER, 'abc-123');
    expect(insideNext).toBe('abc-123');
    expect(currentCorrelationId()).toBeUndefined();
  });
});
