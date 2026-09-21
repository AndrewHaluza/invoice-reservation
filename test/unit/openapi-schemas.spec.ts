import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/docs';
import {
  AvailabilityResponse,
  CancelResponse,
  ErrorResponse,
  LedgerEntryResponse,
  LedgerListResponse,
  MoneyResponse,
  PageResponse,
  PositiveMoneyResponse,
  ReleaseResponse,
  ReservationListResponse,
  ReservationResponse,
  ReserveResponse,
} from '../../src/capacity/api/response';
import { HealthProbeResponse } from '../../src/observability/health.response';
import { CreateReservationDto } from '../../src/capacity/api/dto/create-reservation.dto';
import { CreateReleaseDto } from '../../src/capacity/api/dto/create-release.dto';
import { CancellationDto } from '../../src/capacity/api/dto/cancellation.dto';

type Schema = Record<string, unknown>;

interface PropertyEntry {
  key: string;
  schema: Schema;
}

const MONETARY_KEY =
  /^(amountMinor|amount|creditLimit|available|reserved|delta|total|local|treasury|limit|balance)$/i;

function asSchema(value: unknown): Schema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function schemaName(ref: unknown): string | undefined {
  return typeof ref === 'string' && ref.startsWith('#/components/schemas/')
    ? ref.slice('#/components/schemas/'.length)
    : undefined;
}

function dereference(document: OpenAPIObject, schema: Schema): Schema {
  const name = schemaName(schema.$ref);
  if (!name) return schema;
  return asSchema(document.components?.schemas?.[name]) ?? schema;
}

function effectiveType(document: OpenAPIObject, schema: Schema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const named = schema.type.filter((entry): entry is string => entry !== 'null');
    if (named.length > 0) return named[0];
  }
  const resolved = dereference(document, schema);
  if (resolved !== schema) return effectiveType(document, resolved);
  for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
    const clauses = resolved[keyword];
    if (Array.isArray(clauses)) {
      for (const clause of clauses) {
        const clauseSchema = asSchema(clause);
        const type = clauseSchema ? effectiveType(document, clauseSchema) : undefined;
        if (type) return type;
      }
    }
  }
  return undefined;
}

function declaresMaximum(document: OpenAPIObject, schema: Schema): boolean {
  if (schema.maximum !== undefined) return true;
  const resolved = dereference(document, schema);
  return resolved !== schema && resolved.maximum !== undefined;
}

function collectProperties(document: OpenAPIObject): PropertyEntry[] {
  const entries: PropertyEntry[] = [];
  const visited = new Set<string>();

  const visit = (candidate: unknown): void => {
    const schema = asSchema(candidate);
    if (!schema) return;
    const name = schemaName(schema.$ref);
    if (name) {
      if (visited.has(name)) return;
      visited.add(name);
    }
    const resolved = name ? dereference(document, schema) : schema;
    const properties = asSchema(resolved.properties);
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        const propertySchema = asSchema(value);
        if (!propertySchema) continue;
        entries.push({ key, schema: propertySchema });
        visit(propertySchema);
      }
    }
    const items = asSchema(resolved.items);
    if (items) visit(items);
    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
      const clauses = resolved[keyword];
      if (Array.isArray(clauses)) clauses.forEach(visit);
    }
  };

  Object.values(document.components?.schemas ?? {}).forEach(visit);
  return entries;
}

function schemaNamed(document: OpenAPIObject, name: string): Schema {
  return asSchema(document.components?.schemas?.[name]) ?? {};
}

function propertyOf(schema: Schema, property: string): Schema {
  return asSchema(asSchema(schema.properties)?.[property]) ?? {};
}

@Module({})
class EmptyDocsModule {}

describe('openapi generated schemas', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await NestFactory.create(EmptyDocsModule, { logger: false });
    await app.init();
    document = buildOpenApiDocument(app, 4010, '0.1.0', [
      MoneyResponse,
      PositiveMoneyResponse,
      ErrorResponse,
      PageResponse,
      AvailabilityResponse,
      ReservationResponse,
      ReservationListResponse,
      LedgerEntryResponse,
      LedgerListResponse,
      HealthProbeResponse,
      ReserveResponse,
      ReleaseResponse,
      CancelResponse,
      CreateReservationDto,
      CreateReleaseDto,
      CancellationDto,
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents no monetary value as a JSON number', () => {
    const monetary = collectProperties(document).filter((entry) => MONETARY_KEY.test(entry.key));
    expect(monetary.length).toBeGreaterThan(0);

    const numeric = monetary
      .filter(
        (entry) =>
          !(entry.key.toLowerCase() === 'limit' && declaresMaximum(document, entry.schema)),
      )
      .filter((entry) => {
        const type = effectiveType(document, entry.schema);
        return type === 'number' || type === 'integer';
      })
      .map((entry) => entry.key);

    expect(numeric).toEqual([]);
  });

  it('requires amountMinor and currency on both money schemas', () => {
    for (const name of ['MoneyResponse', 'PositiveMoneyResponse']) {
      const schema = schemaNamed(document, name);
      expect(schema.required).toEqual(expect.arrayContaining(['amountMinor', 'currency']));
    }
  });

  it('documents MoneyResponse.amountMinor as a signed integer string', () => {
    const amountMinor = propertyOf(schemaNamed(document, 'MoneyResponse'), 'amountMinor');
    expect(amountMinor.type).toBe('string');
    expect(amountMinor.pattern).toBe('^-?[0-9]+$');
    expect(typeof amountMinor.example).toBe('string');
  });

  it('documents MoneyResponse.currency as an ISO-4217 code', () => {
    const currency = propertyOf(schemaNamed(document, 'MoneyResponse'), 'currency');
    expect(currency.pattern).toBe('^[A-Z]{3}$');
  });

  it('documents PositiveMoneyResponse.amountMinor as a strictly positive integer string', () => {
    const amountMinor = propertyOf(schemaNamed(document, 'PositiveMoneyResponse'), 'amountMinor');
    expect(amountMinor.pattern).toBe('^[1-9][0-9]{0,18}$');
  });

  it('requires exactly code, message and correlationId on ErrorResponse', () => {
    const required = schemaNamed(document, 'ErrorResponse').required as string[];
    expect([...required].sort()).toEqual(['code', 'message', 'correlationId'].sort());
  });

  it('marks every nextCursor property nullable', () => {
    const cursors = collectProperties(document).filter((entry) => entry.key === 'nextCursor');
    expect(cursors.length).toBeGreaterThan(0);
    for (const cursor of cursors) {
      expect(cursor.schema.nullable).toBe(true);
    }
  });
});
