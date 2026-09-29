import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BEAT_SECONDS, RUNTIME_SECONDS, TOTAL_BEATS } from "../apps/sortie/timing.ts";
import { decodePng } from "../framework/compiler/pak.ts";
import { TEX_MAX_DIM } from "../contracts/spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = ROOT + "apps/sortie/";

async function stepTo(world: SimWorld, frame: number, from: number): Promise<number> {
  for (let f = from; f < frame; f++) {
    world.frame(0);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
    await Promise.resolve();
  }
  return frame;
}

describe("Pocket Sortie", () => {
  // The MV is a fold over the frame index: nothing but the virtual clock moves
  // it from one cut to the next, so walking the frames IS the whole contract.
  test("cuts land on their beats from the virtual clock alone", async () => {
    const world = await bootWorld("sortie-main", 60);
    let at = 0;

    // beat -> the text that cut is the only one to show.
    const expected: readonly (readonly [number, string])[] = [
      [1, "QUICKJS"],
      [5, "FLEXBOX / TAFFY"],
      [19, "SORTIE 00"],
      [26.5, "NO DOM"],
      [28.5, "NO CSS"],
      [41, "ONE NATIVE TREE — NO INTERMEDIATE"],
      [42, "QUICKJS — ONE ENGINE BUNDLE"],
      [57, "SYNC RATIO"],
      [58, "FIXED dt — THE SAME PIXELS ON EVERY RUN"],
      [70.5, "ALL UNITS — STAND BY"],
      [72.5, "SONY PSP"],
      [73.5, "PS VITA"],
      [83.5, "THE BROWSER"],
      [90, "pocketjs.dev"],
      [98, "TO BE CONTINUED"],
    ];

    for (const [beat, text] of expected) {
      at = await stepTo(world, Math.round(beat * BEAT_SECONDS * 60), at);
      expect(`beat ${beat}: ${treeHasText(world.getTree(), text)}`).toBe(`beat ${beat}: true`);
    }

    // The last cut is still on screen at the final frame: the MV ends on the
    // card rather than on an empty tree.
    at = await stepTo(world, Math.round(RUNTIME_SECONDS * 60) - 1, at);
    expect(treeHasText(world.getTree(), "TO BE CONTINUED")).toBe(true);
  }, 180_000);

  test("every readout is Latin, so no run falls back to tofu", () => {
    // The atlases are baked from Inter and JetBrains Mono. Japanese belongs in
    // the artwork (./gen-assets.ts); a CJK character in a Text run would render
    // as a hollow box on every host.
    const code = readFileSync(APP + "app.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments name the cards they draw
      .replace(/^\s*\/\/.*$/gm, "");
    const cjk = code.match(/[　-ヿ㐀-鿿＀-￯]/g);
    expect(cjk ?? []).toEqual([]);
  });

  test("artwork is pow2 and fits one texture", () => {
    const source = readFileSync(APP + "app.tsx", "utf8");
    const names = [...new Set([...source.matchAll(/src="([\w.-]+\.png)"/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      const image = decodePng(new Uint8Array(readFileSync(APP + name)));
      const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
      const fits = pow2(image.width) && pow2(image.height) &&
        Math.max(image.width, image.height) <= TEX_MAX_DIM;
      expect(`${name} ${image.width}x${image.height}: ${fits}`).toBe(
        `${name} ${image.width}x${image.height}: true`,
      );
    }
  });

  test("the score is exactly as long as the cut list", () => {
    const pak = JSON.parse(readFileSync(APP + "pak.json", "utf8")) as { key: string; file: string }[];
    expect(pak).toEqual([{ key: "audio:wav.sortie", file: "media/sortie.wav" }]);

    const wav = readFileSync(APP + pak[0].file);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    const channels = view.getUint16(22, true);
    const rate = view.getUint32(24, true);
    const bits = view.getUint16(34, true);
    const bytes = view.getUint32(40, true);
    expect({ channels, rate, bits }).toEqual({ channels: 1, rate: 22_050, bits: 16 });
    expect(bytes / (rate * channels * (bits / 8))).toBe(RUNTIME_SECONDS);
    expect(RUNTIME_SECONDS).toBe(TOTAL_BEATS * BEAT_SECONDS);
  });

  test("records the typeface the title cards were cut from", () => {
    const attribution = readFileSync(APP + "ATTRIBUTION.md", "utf8");
    const generator = readFileSync(APP + "gen-assets.ts", "utf8");
    const url = generator.match(/"(https:\/\/[^"]*ZenOldMincho-Black\.ttf)"/)?.[1];
    const sha = generator.match(/const FONT_SHA256 = "([0-9a-f]{64})"/)?.[1];
    expect(url).toBeTruthy();
    expect(sha).toBeTruthy();
    expect(attribution).toContain(url!);
    expect(attribution).toContain(sha!);
    expect(attribution).toContain("SIL Open Font License 1.1");
    // The binary stays out of the repository; only the outlines ship.
    expect(generator).toContain(".pocket-build/sortie-fonts/");
  });
});
