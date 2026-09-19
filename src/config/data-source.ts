import 'reflect-metadata';
import { DataSource } from 'typeorm';

export const dataSourceOptions = {
  type: 'postgres' as const,
  // Migrations need the owning role; the service connects as the non-owner app role via
  // DATABASE_URL. Fall back so a single-URL setup still works.
  url: (process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL) as string,
  entities: ['src/capacity/infrastructure/entities/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: false,
};

export default new DataSource(dataSourceOptions);
