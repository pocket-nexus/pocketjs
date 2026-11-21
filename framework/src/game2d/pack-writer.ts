// @pocketjs/framework/game2d — writes the pack format `packs.ts` reads. Build-time code: a bake tool
// imports it directly, a game bundle has no reason to.
//
// A store looks a name up by its 32-bit hash alone, across every mounted pack, and never reads a name
// back. So two different names with one hash draw the wrong image with no error, and only a writer can
// see that: keep one `PackNames` for the whole build, not one per pack.

import { packNameHash } from "./packs.ts";

/** The 12 numbers of one image row, in file order, before the offset is added. */
export interface PackImageRow { w: number; h: number; tw: number; th: number; ox?: number; oy?: number; fw?: number; fh?: number; ax?: number; ay?: number }

/** Every image name in one build. Throws when two different names share a hash. */
export class PackNames {
  private seen = new Map<number, string>();
  claim(name: string): number {
    const hash = packNameHash(name), had = this.seen.get(hash);
    if (had !== undefined && had !== name) throw new Error(`pack name hash collision: ${had} / ${name}`);
    this.seen.set(hash, name);
    return hash;
  }
}

/** One pack being written. `add` takes the encoded IMG entry; `same` shares the bytes of an earlier image. */
export class PackWriter {
  private rows = new Map<string, number[]>();
  private entries: Uint8Array[] = [];
  private at = 0;
  constructor(private names: PackNames = new PackNames()) {}
  /** Add an image, returning the [offset, length] a later `share` can reuse. */
  add(name: string, entry: Uint8Array, row: PackImageRow): [number, number] {
    const where: [number, number] = [this.at, entry.length];
    this.entries.push(entry);
    this.at += entry.length;
    this.share(name, where, row);
    return where;
  }
  /** A second name for bytes already in this pack. */
  share(name: string, where: [number, number], row: PackImageRow): void {
    this.names.claim(name);
    this.rows.set(name, [where[0], where[1], row.tw, row.th, row.w, row.h, row.ox ?? 0, row.oy ?? 0, row.fw ?? row.w, row.fh ?? row.h, row.ax ?? 0, row.ay ?? 0]);
  }
  has(name: string): boolean { return this.rows.has(name); }
  /** The finished file. `data` becomes ASCII JSON, so a reader needs no UTF-8 decoder. */
  encode(data: unknown = {}): Uint8Array {
    const json = JSON.stringify(data).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const sorted = [...this.rows.keys()].map((name) => [packNameHash(name), name] as const).sort((a, b) => a[0] - b[0]);
    const n = sorted.length, head = new Uint8Array(12 + n * 52), view = new DataView(head.buffer);
    head.set([0x47, 0x50, 0x4b, 0x32]); // "GPK2"
    view.setUint32(4, n, true);
    view.setUint32(8, json.length, true);
    sorted.forEach(([hash, name], i) => {
      this.rows.get(name)!.forEach((v, k) => view.setInt32(12 + i * 48 + k * 4, v, true));
      view.setUint32(12 + n * 48 + i * 4, hash, true);
    });
    const parts = [head, new TextEncoder().encode(json), ...this.entries];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }
}
