// The generated styles module is gitignored: a clean checkout does not ship
// it, and tools/build.ts writes it mid-run — after pass 1 has already resolved
// the framework's `./styles.generated.ts` import (a resolver may cache that
// miss). Pass 2 must serve THIS build's in-memory table through the plugin,
// never read the path from disk, or the first clean build fails to resolve
// it. This test pins that contract by bundling the real framework root with
// the file ABSENT and asserting the bundle carries the in-memory marker.
//
// Runs as its own stage (tools/test.ts) so the temporary rename below cannot
// race a parallel test that imports the framework.

import { describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FRAMEWORKS, GENERATED_STYLES_PATH, jsxPlugin } from "../framework/compiler/jsx-plugin.ts";

describe("generated styles module is virtual in pass 2", () => {
  test("bundles the framework root with styles.generated.ts absent, serving the in-memory table", async () => {
    // Hide any on-disk mirror a local build emitted so the test exercises the
    // virtual path; restore it no matter how the build ends.
    let hidden: string | undefined;
    if (existsSync(GENERATED_STYLES_PATH)) {
      hidden = GENERATED_STYLES_PATH + ".test-backup";
      renameSync(GENERATED_STYLES_PATH, hidden);
    }
    try {
      const dir = await mkdtemp(join(tmpdir(), "pocketjs-styles-virtual-"));
      const entry = join(dir, "entry.ts");
      await Bun.write(entry, `export * from ${JSON.stringify(FRAMEWORKS.solid.rootPath)};\n`);
      const marker = `virtual-styles-marker-${Date.now()}`;
      const virtual = `export const STYLE_IDS: Record<string, number> = ${JSON.stringify({ [marker]: 42 })};\n`;

      const result = await Bun.build({
        entrypoints: [entry],
        format: "esm",
        target: "browser",
        conditions: ["browser"],
        define: {
          "process.env.NODE_ENV": '"production"',
          __POCKET_TARGET__: '""',
          __POCKET_HOST_ABI__: "0",
          __POCKET_FEATURES__: "{}",
          __POCKET_MODALITY__: "null",
          __POCKET_PRESENTATION__: '{"id":"default"}',
          __POCKET_PIXEL_RATIO__: "1",
          __POCKET_TICK_HZ__: "60",
        },
        plugins: [jsxPlugin("solid", { entry, generatedStyles: virtual })],
      });

      expect(result.success).toBe(true);
      // The marker exists ONLY in the in-memory table, never on disk: its
      // presence proves onLoad served the virtual source, not the file.
      const out = await result.outputs[0]!.text();
      expect(out).toContain(marker);
      await rm(dir, { recursive: true, force: true });
    } finally {
      if (hidden) renameSync(hidden, GENERATED_STYLES_PATH);
    }
  });
});
