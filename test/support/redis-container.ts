import { GenericContainer } from 'testcontainers';

export interface RedisFixture {
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<RedisFixture> {
  const container = await new GenericContainer('redis:7.4.11-alpine')
    .withExposedPorts(6379)
    .withStartupTimeout(120_000)
    .start();

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
