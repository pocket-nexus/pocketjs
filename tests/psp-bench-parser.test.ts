import { expect, test } from "bun:test";
import { parseBenchOutput } from "../tools/bench-ppsspp-parser.ts";

function row(app: string, checksum?: string, bundle = 10, pak = 20): string {
  return JSON.stringify({
    app,
    frames: 80,
    window_n: 80,
    bundle_bytes: bundle,
    pak_bytes: pak,
    ...(checksum === undefined ? {} : { drawlist_checksum: checksum }),
  });
}

test("selects the requested app from multi-app PSP output", () => {
  const parsed = parseBenchOutput(
    `${row("hero", "1111111111111111", 11, 22)}\n${row("cards", undefined, 33, 44)}`,
    "cards",
    1,
  );

  expect(parsed.app).toBe("cards");
  expect(parsed.bundle_bytes).toBe(33);
  expect(parsed.pak_bytes).toBe(44);
  expect(parsed.drawlist_checksum).toBeUndefined();
});

test("keeps one-line legacy PSP output compatible", () => {
  const parsed = parseBenchOutput(row("legacy-app"), "stats", 1);

  expect(parsed.app).toBe("legacy-app");
  expect(parsed.drawlist_checksum).toBeUndefined();
});

test("reports a missing requested app in multi-app output", () => {
  expect(() => parseBenchOutput(`${row("hero")}\n${row("cards")}`, "stats", 1)).toThrow(
    "stats sample 1: requested app not found in PSP bench output (hero, cards)",
  );
});
