// micro/tests/parity.test.ts — the compiled hero must render the same bytes
// as stock Solid at every captured frame of the golden tape. Builds the
// wasm core, the Solid bundle and the Rust harness; run through
// `bun run micro:test`, not the default suite.

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { runParity } from "./parity.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

test("hero: Pocket Micro frames equal the fresh Solid oracle byte for byte", async () => {
  const out = join(ROOT, ".pocket-build/validation/pocket-micro/parity", String(Date.now()));
  const result = await runParity("hero", out);
  expect((result.state as { state: unknown }).state).toEqual({ count: 5 });
  expect((result.state as { unknownTexture: number }).unknownTexture).toBe(0);
  for (const frame of result.frames) {
    expect(frame.match, `frame ${frame.frame} differs from ${frame.oracle}; artifacts: ${out}`).toBe(true);
  }
}, 900_000);
