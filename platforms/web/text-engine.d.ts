export function createTextEngine(
  wasmBytes: BufferSource,
  pak?: BufferSource,
  fonts?: BufferSource[],
): Promise<{ request(record: string): string }>;
