import Joi from 'joi';

export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri().required(),
  MIGRATION_DATABASE_URL: Joi.string().uri().optional(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_SASL_USERNAME: Joi.string().required(),
  KAFKA_SASL_PASSWORD: Joi.string().required(),
  KAFKA_CAPACITY_EVENTS_TOPIC: Joi.string().default('treasury.capacity.events'),
  KAFKA_SNAPSHOTS_TOPIC: Joi.string().default('treasury.capacity.snapshots'),
  KAFKA_DLQ_TOPIC: Joi.string().default('treasury.capacity.dlq'),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_CLOCK_SKEW_SECONDS: Joi.number().integer().min(0).default(60),
  RATE_LIMIT_READ_PER_MINUTE: Joi.number().integer().positive().default(600),
  RATE_LIMIT_WRITE_PER_MINUTE: Joi.number().integer().positive().default(120),
  KAFKA_CONSUMER_GROUP_ID: Joi.string().default('capacity-treasury-consumer'),
  KAFKA_RETRY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  KAFKA_RETRY_BASE_DELAY_MS: Joi.number().integer().min(0).default(200),
  KAFKA_RETRY_MAX_DELAY_MS: Joi.number().integer().min(0).default(10000),
});
