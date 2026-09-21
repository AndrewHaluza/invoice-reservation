import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponse {
  @ApiProperty({
    type: String,
    example: 'INSUFFICIENT_CAPACITY',
    description: 'Machine-readable. Branch on this, never on message.',
  })
  code!: string;

  @ApiProperty({
    type: String,
    example: 'The amount exceeds available capacity.',
    description: 'Fixed human-readable prose. Never interpolates an amount, identifier, or program id.',
  })
  message!: string;

  @ApiProperty({
    type: String,
    example: '3f2a9c14-8e7b-4a51-9f10-2d6c4b8e1a37',
    description: 'Echoes the request correlation id, or "unknown" when none was supplied.',
  })
  correlationId!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Field-level validation information only. Never stack traces, SQL, driver messages, or identifiers belonging to another organisation. At most 20 entries.',
    example: { 'amount.amountMinor': 'amountMinor must be a positive integer string' },
  })
  details?: Record<string, string>;
}
