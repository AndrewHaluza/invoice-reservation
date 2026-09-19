import {
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrapOr,
} from '../../src/shared/result';

describe('result', () => {
  it('isOk(ok(1)) is true, isErr(ok(1)) is false, and the mirror', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isErr(err('boom'))).toBe(true);
    expect(isOk(err('boom'))).toBe(false);
  });

  it('map applies to Ok and passes Err through untouched', () => {
    expect(map(ok(1), (n) => n + 1)).toEqual(ok(2));

    const failure = err<string>('boom');
    expect(map(failure, (n: number) => n + 1)).toBe(failure);
  });

  it('mapErr applies to Err and passes Ok through untouched', () => {
    expect(mapErr(err('boom'), (e) => e.toUpperCase())).toEqual(err('BOOM'));

    const success = ok(1);
    expect(mapErr(success, (e: string) => e.toUpperCase())).toBe(success);
  });

  it('ok(1) is frozen: assigning .value throws in strict mode', () => {
    const result = ok(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as unknown as { value: number }).value = 2;
    }).toThrow(TypeError);
  });

  it('unwrapOr returns the value for Ok and the fallback for Err', () => {
    expect(unwrapOr(ok(1), 0)).toBe(1);
    expect(unwrapOr(err('boom'), 0)).toBe(0);
  });
});
