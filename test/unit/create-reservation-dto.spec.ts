import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateReservationDto } from '../../src/capacity/api/dto/create-reservation.dto';

const validateBody = async (body: Record<string, unknown>): Promise<ValidationError[]> => {
  const instance = plainToInstance(CreateReservationDto, body);
  return validate(instance, { whitelist: true, forbidNonWhitelisted: true });
};

const validBody = (): Record<string, unknown> => ({
  invoiceId: 'invoice-0001',
  amount: { amountMinor: '100000', currency: 'USD' },
});

describe('CreateReservationDto', () => {
  it('accepts a well-formed body with zero errors', async () => {
    const errors = await validateBody(validBody());
    expect(errors).toHaveLength(0);
  });

  it('rejects an amountMinor above INT64_MAX', async () => {
    const body = validBody();
    body.amount = { amountMinor: '9999999999999999999', currency: 'USD' };
    const errors = await validateBody(body);
    expect(errors).not.toHaveLength(0);
  });

  it('accepts amountMinor equal to INT64_MAX', async () => {
    const body = validBody();
    body.amount = { amountMinor: '9223372036854775807', currency: 'USD' };
    const errors = await validateBody(body);
    expect(errors).toHaveLength(0);
  });

  it('rejects zero and negative amountMinor', async () => {
    const zero = validBody();
    zero.amount = { amountMinor: '0', currency: 'USD' };
    expect(await validateBody(zero)).not.toHaveLength(0);

    const negative = validBody();
    negative.amount = { amountMinor: '-5', currency: 'USD' };
    expect(await validateBody(negative)).not.toHaveLength(0);
  });

  it('rejects a JSON-number amountMinor', async () => {
    const body = validBody();
    body.amount = { amountMinor: 100, currency: 'USD' };
    const errors = await validateBody(body);
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a lowercase currency but accepts uppercase', async () => {
    const lower = validBody();
    lower.amount = { amountMinor: '100000', currency: 'usd' };
    expect(await validateBody(lower)).not.toHaveLength(0);

    const upper = validBody();
    upper.amount = { amountMinor: '100000', currency: 'USD' };
    expect(await validateBody(upper)).toHaveLength(0);
  });

  it('rejects an invoiceId of 129 characters', async () => {
    const body = validBody();
    body.invoiceId = 'a'.repeat(129);
    const errors = await validateBody(body);
    expect(errors).not.toHaveLength(0);
  });

  it('rejects an unknown property under forbidNonWhitelisted', async () => {
    const body = validBody();
    body.unexpected = 'nope';
    const errors = await validateBody(body);
    expect(errors).not.toHaveLength(0);
  });
});
