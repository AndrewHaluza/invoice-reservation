declare module 'kafkajs-snappy' {
  interface SnappyCodec {
    compress(encoder: { buffer: Buffer }): Promise<Buffer>;
    decompress(buffer: Buffer): Promise<Buffer>;
  }

  const codecFactory: () => SnappyCodec;
  export default codecFactory;
}
