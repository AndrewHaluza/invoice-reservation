import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';

export interface PostgresFixture {
  container: StartedPostgreSqlContainer;
  ownerUrl: string;
  appUrl: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer('postgres:16.10-alpine')
    .withDatabase('capacity')
    .withUsername('capacity')
    .withPassword('capacity_local_dev')
    .withStartupTimeout(120_000)
    .start();

  const ownerUrl = container.getConnectionUri();
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'capacity_app';
  appUrl.password = 'capacity_local_dev';

  const initSql = await readFile(
    join(__dirname, '..', '..', 'docker', 'postgres-init.sql'),
    'utf8',
  );

  const bootstrap = new DataSource({
    ...dataSourceOptions,
    url: ownerUrl,
    entities: [],
    migrations: [],
  });
  await bootstrap.initialize();
  try {
    await bootstrap.query(initSql);
  } finally {
    await bootstrap.destroy();
  }

  return {
    container,
    ownerUrl,
    appUrl: appUrl.toString(),
    stop: async () => {
      await container.stop();
    },
  };
}
