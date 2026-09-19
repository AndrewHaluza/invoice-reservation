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
  SNAPSHOT_DELTA_GUARD_RATIO: Joi.number().greater(0).max(1).default(0.5),
  RATE_LIMIT_READ_PER_MINUTE: Joi.number().integer().positive().default(600),
  RATE_LIMIT_WRITE_PER_MINUTE: Joi.number().integer().positive().default(120),
});
