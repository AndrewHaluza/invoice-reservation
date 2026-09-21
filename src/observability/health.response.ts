import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthProbeResponse {
  @ApiProperty({
    type: String,
    enum: ['ok', 'degraded'],
    example: 'ok',
    description: 'Overall readiness. Degraded means at least one check is down.',
  })
  status!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { consumer: 'up', database: 'up' },
    description:
      'Per-dependency state. Deliberately minimal: names no host, broker, connection string, driver message or version.',
  })
  checks?: Record<string, string>;
}
