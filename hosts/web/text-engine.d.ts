export function createTextEngine(
  wasmBytes: BufferSource,
  pak?: BufferSource,
  fonts?: BufferSource[],
  options?: { freetypeBytes?: BufferSource },
): Promise<{ request(record: string): string }>;
