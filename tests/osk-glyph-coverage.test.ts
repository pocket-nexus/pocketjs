// tests/osk-glyph-coverage.test.ts — every glyph the on-screen keyboard can
// insert or display must be a source literal in framework/src/osk-layout.ts.
//
// The font bake only knows codepoints harvested from literals during pass 1.
// OSK apps therefore need no app.runtimeText declaration ONLY because
// OSK_LAYERS spells every key out as a string literal. That property is
// accidental, not enforced: turning a key into String.fromCharCode(126) or
// reading it from config would remove the codepoint from the harvest while
// the keyboard still inserts it, and the key cap would silently bake as tofu.
// This test derives the required set from the runtime table and checks it
// against the collector's view of the table's source.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OSK_LAYERS, type OskKeyDef } from "../framework/src/osk-layout.ts";
import { transformFile } from "../framework/compiler/jsx-plugin.ts";

const OSK_LAYOUT_PATH = join(import.meta.dir, "..", "framework", "src", "osk-layout.ts");

/** Codepoints the live keyboard table actually inserts or paints on caps. */
function expectedCodepoints(): { typed: Set<number>; labels: Set<number> } {
  const typed = new Set<number>();
  const labels = new Set<number>();
  for (const rows of Object.values(OSK_LAYERS)) {
    for (const row of rows as OskKeyDef[][]) {
      for (const key of row) {
        if (key.ch !== undefined) {
          for (const ch of key.ch) typed.add(ch.codePointAt(0)!);
        }
        if (key.label !== undefined) {
          for (const ch of key.label) labels.add(ch.codePointAt(0)!);
        }
      }
    }
  }
  return { typed, labels };
}

const hex = (cp: number): string => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

test("every OSK glyph is harvested from osk-layout.ts source literals", async () => {
  const { typed, labels } = expectedCodepoints();

  // Anti-vacuity: the derived set must be the real keyboard, not an empty table.
  expect(typed.size).toBeGreaterThan(70);
  for (const ch of ["a", "Z", "0", " ", "@", "_", '"']) {
    expect(typed.has(ch.codePointAt(0)!)).toBe(true);
  }
  for (const ch of ["⌫", "↵", "✓"]) {
    expect(labels.has(ch.codePointAt(0)!)).toBe(true);
  }

  const source = readFileSync(OSK_LAYOUT_PATH, "utf8");
  // The collector is framework-independent for this JSX-free module; "solid"
  // runs the same makeCollector pass the build runs on this file.
  const collected = (await transformFile(OSK_LAYOUT_PATH, source, "solid")).textCodepoints;

  const missingTyped = [...typed].filter((cp) => !collected.has(cp));
  const missingLabels = [...labels].filter((cp) => !collected.has(cp));
  expect({
    missingTyped: missingTyped.map(hex),
    missingLabels: missingLabels.map(hex),
  }).toEqual({ missingTyped: [], missingLabels: [] });
});
