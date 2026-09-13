// This adapter is worker-only. Native providers call the same Rust Engine.
export async function createTextEngine(wasmBytes, pak, fonts = []) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const e = instance.exports,
    encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const input = (bytes, fn) => {
    const ptr = e.text_alloc(bytes.byteLength);
    try {
      new Uint8Array(e.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return fn(ptr, bytes.byteLength);
    } finally {
      e.text_free(ptr, bytes.byteLength);
    }
  };
  e.text_init();
  if (pak) input(new Uint8Array(pak), (ptr, len) => e.text_load_pak(ptr, len));
  for (const font of fonts)
    if (!input(new Uint8Array(font), (ptr, len) => e.text_load_font(ptr, len)))
      throw Error("Invalid provider font");
  return {
    request(record) {
      if (typeof record !== "string" || encoder.encode(record).length > 4096)
        throw Error("Invalid offload record");
      return input(encoder.encode(record), (ptr, len) => {
        const reply = e.text_request(ptr, len),
          length = e.text_reply_len();
        if (length > 4096) throw Error("Offload reply exceeds budget");
        return decoder.decode(new Uint8Array(e.memory.buffer, reply, length));
      });
    },
  };
}
