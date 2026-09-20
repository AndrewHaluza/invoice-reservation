import { CompressionCodecs, CompressionTypes } from 'kafkajs';
import snappyCodec from 'kafkajs-snappy';

let registered = false;

/**
 * KafkaJS decodes only GZIP itself; any other compression raises
 * `KafkaJSNotImplemented` while it fetches a batch. That error is not scoped to
 * a single message — the consumer crashes and stops — so one non-GZIP batch
 * (Snappy is a common producer default) permanently halts all ingestion until a
 * redeploy. Registering the Snappy codec makes those batches decode instead.
 * Registration is process-global and idempotent.
 */
export function registerKafkaCodecs(): void {
  if (registered) {
    return;
  }

  CompressionCodecs[CompressionTypes.Snappy] = snappyCodec;
  registered = true;
}
