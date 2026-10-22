import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fnv1a64, POCKET_LAYOUT, POCKET_PACKAGE_HEADER_SIZE, POCKET_PACKAGE_VARIANT_SIZE } from "../contracts/spec/pocket-package.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function packageCorpus(): Map<string, Uint8Array> {
  const base = new Uint8Array(readFileSync(resolve(root, "tests/fixtures/packages/synthetic.pocket")));
  const view = new DataView(base.buffer);
  const table = Math.ceil((POCKET_PACKAGE_HEADER_SIZE + view.getUint32(8, true)) / 16) * 16;
  const sections = view.getUint32(table + POCKET_LAYOUT.variant.sectionsOffset, true);
  const cases = new Map<string, Uint8Array>([["ok-valid.pocket", base]]);
  function mutate(name: string, change: (bytes: Uint8Array, view: DataView) => void) {
    const bytes = base.slice();
    const dv = new DataView(bytes.buffer);
    change(bytes, dv);
    dv.setBigUint64(bytes.length - 8, fnv1a64(bytes.subarray(0, bytes.length - 8)), true);
    cases.set(name, bytes);
  }
  mutate("bad-magic.pocket", (_, dv) => dv.setUint32(0, 0, true));
  mutate("bad-version.pocket", (_, dv) => dv.setUint32(4, 99, true));
  mutate("bad-manifest.pocket", (_, dv) => dv.setUint32(8, 0xffffffff, true));
  mutate("bad-variant-count.pocket", (_, dv) => dv.setUint32(12, 0xffffffff, true));
  mutate("bad-empty-target.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.targetSize, 0, true));
  mutate("bad-target-terminator.pocket", (bytes, dv) => { bytes[dv.getUint32(table, true)] = 0; });
  mutate("bad-section-count.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.sectionCount, 0xffffffff, true));
  mutate("bad-section-table.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.sectionsOffset, 0xfffffff0, true));
  mutate("bad-payload-offset.pocket", (_, dv) => dv.setUint32(sections + 8, 0xfffffff0, true));
  mutate("bad-payload-length.pocket", (_, dv) => dv.setUint32(sections + 12, 0xffffffff, true));
  const lastSection = sections + (view.getUint32(table + POCKET_LAYOUT.variant.sectionCount, true) - 1) * 16;
  mutate("ok-unknown-section.pocket", (_, dv) => dv.setUint32(lastSection, 999, true));
  mutate("bad-v1.pocket", (_, dv) => dv.setUint32(4, 1, true));
  mutate("bad-string-table.pocket", (_, dv) => dv.setUint32(POCKET_LAYOUT.header.stringTableOffset, 0xffffffff, true));
  mutate("bad-string-length.pocket", (_, dv) => dv.setUint32(POCKET_LAYOUT.header.stringTableSize, 0xffffffff, true));
  mutate("bad-target-utf8.pocket", (bytes, dv) => { bytes[dv.getUint32(table, true)] = 0xff; });
  mutate("bad-target-overlap.pocket", (_, dv) => dv.setUint32(table + POCKET_PACKAGE_VARIANT_SIZE, dv.getUint32(table, true), true));
  mutate("bad-section-duplicate.pocket", (_, dv) => dv.setUint32(sections + 16, dv.getUint32(sections, true), true));
  mutate("bad-reserved-header.pocket", (_, dv) => dv.setUint32(24, 1, true));
  mutate("bad-reserved-variant.pocket", (_, dv) => dv.setUint32(table + 20, 1, true));
  mutate("bad-reserved-section.pocket", (_, dv) => dv.setUint32(sections + 4, 1, true));
  cases.set("bad-truncated.pocket", base.slice(0, 20));
  return cases;
}

if (import.meta.main) {
  for (const [name, bytes] of packageCorpus())
    await Bun.write(resolve(root, "tests/fixtures/packages/corpus", name), bytes);
}
