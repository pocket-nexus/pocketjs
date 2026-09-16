// In-memory transport fixture. Production PSP uses the allocation-free Rust
// reader on its local I/O thread; this fixture drives the real WASM renderer.
import { glyphChecksum } from "../../framework/compiler/font-archive.ts";
import type { OffloadOps } from "../../contracts/spec/offload.ts";
export function archiveProvider(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    strikes: any[] = [];
  for (let i = 0; i < v.getUint32(12, true); i++) {
    const at = 64 + i * 32;
    strikes.push({
      slot: bytes[at],
      width: bytes[at + 1],
      height: bytes[at + 2],
      baseline: bytes[at + 3],
      lineHeight: bytes[at + 4],
      advance: bytes[at + 5],
      density: bytes[at + 6],
      count: v.getUint32(at + 8, true),
      index: v.getUint32(at + 12, true),
      data: v.getUint32(at + 16, true),
    });
  }
  let generation = 0,
    session = 1,
    text = "你好世界。気迫。日本語の文章。",
    glyphs = 0,
    fail = false;
  const requests: any[] = [],
    replies: string[] = [],
    seen: any[] = [];
  const documents = new Map<string, string>([["common.txt", "你好"]]);
  const ops: OffloadOps = {
    session: () => session,
    submit(record) {
      requests.push(JSON.parse(record));
      return true;
    },
    take: () => replies.shift(),
  };
  return {
    ops,
    seen,
    setText: (s: string) => (text = s),
    setDocument: (name: string, value: string) => documents.set(name, value),
    fail: (value: boolean) => (fail = value),
    reconnect: () => session++,
    disconnect: () => session = 0,
    step() {
      const r = requests.shift();
      if (!r) return;
      seen.push(r);
      try {
        if (fail) throw new Error("Injected read failure");
        let payload = "";
        if (r.method === "font.open")
          payload = JSON.stringify({
            generation: ++generation,
            identity: Buffer.from(bytes.subarray(16, 48)).toString("hex"),
            strikes: strikes.map((s) => [
              s.slot,
              s.width,
              s.height,
              s.baseline,
              s.lineHeight,
              s.advance,
              s.density,
              s.count,
            ]),
          });
        else if (r.method === "fs.read-text") payload = documents.get(r.payload) ?? text;
        else if (r.method === "font.close") payload = "";
        else if (r.method === "font.stats")
          payload = JSON.stringify({
            glyphs,
            bytes: glyphs * 256,
            failures: 0,
          });
        else if (r.method === "font.glyphs") {
          const q = JSON.parse(r.payload);
          if (q.generation !== generation) throw new Error("Stale generation");
          const s = strikes.find((s) => s.slot === q.slot),
            packed = Math.ceil((s.width * s.height) / 4),
            stride = 8 + packed;
          const out = new Uint8Array(12 + q.scalars.length * stride),
            dv = new DataView(out.buffer);
          dv.setUint32(0, 0x31474650, true);
          dv.setUint32(4, generation, true);
          out.set([q.slot, q.scalars.length, s.width, s.height], 8);
          q.scalars.forEach((cp: number, i: number) => {
            const at = 12 + i * stride;
            dv.setUint32(at, cp, true);
            let lo = 0,
              hi = s.count;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (v.getUint32(s.index + mid * 12, true) < cp) lo = mid + 1;
              else hi = mid;
            }
            const index = s.index + lo * 12;
            if (lo === s.count || v.getUint32(index, true) !== cp) return;
            const gid = v.getUint16(index + 4, true),
              cell = bytes.subarray(
                s.data + gid * packed,
                s.data + (gid + 1) * packed,
              );
            if (glyphChecksum(cell) !== v.getUint32(index + 8, true))
              throw new Error("Corrupt cell");
            out.set([bytes[index + 6], bytes[index + 7], 1, 0], at + 4);
            out.set(cell, at + 8);
            glyphs++;
          });
          payload = Buffer.from(out).toString("hex");
        } else throw new Error("Unknown capability");
        replies.push(JSON.stringify({ id: r.id, payload }));
      } catch (e) {
        replies.push(JSON.stringify({ id: r.id, error: String(e) }));
      }
    },
  };
}
