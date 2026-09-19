import { ValueTransformer } from 'typeorm';

export const bigintTransformer: ValueTransformer = {
  to(value: bigint | null): string | null {
    return value === null ? null : value.toString();
  },
  from(value: string | null): bigint | null {
    return value === null ? null : BigInt(value);
  },
};
