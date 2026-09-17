// Deterministic art-pipeline checks for the PixelLab-backed GBA RPG assets.

import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { buildBackground } from "../scripts/rpg-assets.ts";

const ROOT = join(import.meta.dir, "..", "examples", "rpg", "assets");
const SOURCE = join(ROOT, "source");
const FINAL = join(ROOT, "final");
const SCRIPT = join(import.meta.dir, "..", "scripts", "rpg-assets.ts");
const HEADER = join(import.meta.dir, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");

const BG = [
  "0,0,0", "24,41,74", "33,123,66", "66,198,90", "132,90,41", "198,156,82",
  "74,82,99", "156,165,173", "24,74,148", "57,148,231", "33,82,41", "41,165,66",
  "255,214,66", "33,49,99", "239,222,148", "255,82,82",
];
const HERO = [
  "24,41,74", "198,107,66", "255,173,99", "33,82,173", "66,132,255",
  "132,181,255", "181,66,49", "255,123,74", "239,222,148",
];
const ELDER = [
  "24,41,74", "198,107,66", "255,173,99", "74,82,99", "115,123,140",
  "156,165,173", "198,214,222", "255,255,255", "66,132,255",
];
const SLIME = ["24,41,74", "0,90,90", "0,173,173", "57,214,198", "148,247,222", "255,255,255"];
const WALK_FILES = ["south", "north", "west", "east"]
  .flatMap((direction) => Array.from({ length: 4 }, (_, frame) => `hero-walk-${direction}-${frame}.png`));
const SOURCE_FILES = [
  "style-anchor.png",
  "grass.png", "path.png", "wall.png", "water.png", "tree.png", "flower.png",
  "hero-south-reference.png", "hero-south.png", "hero-north.png", "hero-west.png", "hero-east.png",
  "elder.png", "slime.png",
  ...WALK_FILES,
].sort();

async function rgba(path: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

function generatedWordCount(name: string): number {
  const header = readFileSync(HEADER, "utf8");
  const match = header.match(new RegExp(`static const u16 ${name}\\[(\\d+)\\] = \\{([\\s\\S]*?)\\n\\};`));
  if (!match) throw new Error(`missing generated array ${name}`);
  expect([...match[2].matchAll(/0x[0-9a-f]{4}/g)]).toHaveLength(Number(match[1]));
  return Number(match[1]);
}

describe("Vapor Quest GBA art pipeline", () => {
  test("reviewed PNG inputs reproduce every committed output offline", async () => {
    await $`bun ${SCRIPT} check`.quiet();
    expect(generatedWordCount("vp_rpg_bg_palette")).toBe(16);
    expect(generatedWordCount("vp_rpg_obj_palettes")).toBe(48);
    expect(generatedWordCount("vp_rpg_bg_tiles")).toBe(54 * 16);
    expect(generatedWordCount("vp_rpg_obj_tiles")).toBe(480 * 16);
    const header = readFileSync(HEADER, "utf8");
    expect(header).toContain("#define VP_RPG_WORLD_WALK_DIRECTION_COUNT 4");
    expect(header).toContain("#define VP_RPG_WORLD_WALK_FRAMES 4");
    expect(header).toContain("#define VP_RPG_WORLD_WALK_TILE_BASE (VP_RPG_WORLD_STATIC_ACTOR_FRAME_COUNT * VP_RPG_WORLD_ACTOR_FRAME_TILES)");
  });

  test("generation provenance is complete and contains no credential", () => {
    const text = readFileSync(join(ROOT, "generation.json"), "utf8");
    expect(text).not.toMatch(/PIXELLAB_API_KEY|Authorization|Bearer\s/i);
    const manifest = JSON.parse(text) as {
      provider: string;
      apiBase: string;
      assets: {
        heroWalk: {
          endpoint: string;
          templateAnimationId: string;
          animationName: string;
          directions: string[];
          frameCount: number;
          prompt: string;
          seed: number;
        };
      };
      records: {
        world: Record<string, unknown>;
        heroRotations: { characterId: string };
        heroWalk: {
          characterId: string;
          animationGroupId: string;
          backgroundJobIds: Record<string, string>;
          hashes: Record<string, string>;
        };
      };
      sourceHashes: Record<string, string>;
    };
    expect(manifest.provider).toBe("PixelLab");
    expect(manifest.apiBase).toBe("https://api.pixellab.ai/v2");
    expect(Object.keys(manifest.records.world).sort()).toEqual(["barriers", "field", "flower", "tree"]);
    expect(manifest.records.heroRotations.characterId).toMatch(/^[0-9a-f-]{36}$/);
    expect(manifest.assets.heroWalk).toEqual({
      endpoint: "/characters/animations",
      templateAnimationId: "walking-4-frames",
      directions: ["south", "north", "west", "east"],
      frameCount: 4,
      animationName: "Vapor Quest Walk",
      prompt: expect.any(String),
      seed: 23071,
    });
    expect(manifest.records.heroWalk.characterId).toBe(manifest.records.heroRotations.characterId);
    expect(manifest.records.heroWalk.animationGroupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(manifest.records.heroWalk.backgroundJobIds)).toEqual(["south", "north", "west", "east"]);
    expect(Object.keys(manifest.sourceHashes).sort()).toEqual(SOURCE_FILES);
    expect(Object.keys(manifest.records.heroWalk.hashes)).toEqual(WALK_FILES);
    for (const id of Object.values(manifest.records.heroWalk.backgroundJobIds)) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
      const actual = createHash("sha256").update(readFileSync(join(SOURCE, file))).digest("hex");
      expect(actual, file).toBe(expected);
    }
    for (const file of WALK_FILES) {
      expect(manifest.records.heroWalk.hashes[file], file).toBe(manifest.sourceHashes[file]);
    }
  });

  test("the background sheet combines ten 16x16 world cells with fourteen 8x8 UI tiles", async () => {
    const image = await rgba(join(FINAL, "background.png"));
    expect([image.width, image.height]).toEqual([160, 24]);
    const allowed = new Set(BG);
    for (let at = 0; at < image.data.length; at += 4) {
      expect(image.data[at + 3]).toBe(255);
      expect(allowed.has(`${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`)).toBe(true);
    }
  });

  test("each reviewed PixelLab terrain source materially changes the final atlas", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vapor-rpg-terrain-"));
    const files = ["grass.png", "path.png", "wall.png", "water.png", "tree.png", "flower.png"];
    try {
      for (const file of files) copyFileSync(join(SOURCE, file), join(directory, file));
      const baseline = await buildBackground(directory);
      expect(createHash("sha256").update((await buildBackground(directory)).png).digest("hex"))
        .toBe(createHash("sha256").update(baseline.png).digest("hex"));
      for (const file of ["grass.png", "path.png", "wall.png", "water.png"]) {
        const path = join(directory, file);
        const original = readFileSync(path);
        const image = await loadImage(original);
        const canvas = createCanvas(16, 16);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        for (let y = 4; y < 8; y++) {
          for (let x = 4; x < 8; x++) {
            context.fillStyle = (x + y) % 2 === 0 ? "#000000" : "#ffffff";
            context.fillRect(x, y, 1, 1);
          }
        }
        writeFileSync(path, canvas.toBuffer("image/png"));
        const changed = await buildBackground(directory);
        expect(createHash("sha256").update(changed.png).digest("hex"), file)
          .not.toBe(createHash("sha256").update(baseline.png).digest("hex"));
        writeFileSync(path, original);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the review palette guide pads unused OBJ slots exactly like GBA RAM", async () => {
    const image = await rgba(join(FINAL, "palette-guide.png"));
    expect([image.width, image.height]).toEqual([64, 64]);
    const lengths = [16, 10, 10, 7];
    for (let row = 0; row < lengths.length; row++) {
      for (let index = lengths[row]; index < 16; index++) {
        const at = ((row * 16 + 8) * image.width + index * 4 + 1) * 4;
        expect([...image.data.slice(at, at + 4)]).toEqual([0, 0, 0, 255]);
      }
    }
    const header = readFileSync(HEADER, "utf8");
    const match = header.match(/static const u16 vp_rpg_obj_palettes\[48\] = \{([\s\S]*?)\n\};/);
    if (!match) throw new Error("missing generated OBJ palette");
    const words = [...match[1].matchAll(/0x([0-9a-f]{4})/g)].map((entry) => Number.parseInt(entry[1], 16));
    for (const [base, used] of [[0, 10], [16, 10], [32, 7]] as const) {
      expect(words.slice(base + used, base + 16)).toEqual(Array(16 - used).fill(0));
    }
  });

  test("six detailed 32x32 actor frames share a foot line and stay inside their OBJ banks", async () => {
    const image = await rgba(join(FINAL, "actors.png"));
    expect([image.width, image.height]).toEqual([192, 32]);
    const frameHashes: string[] = [];
    const frameColors: Set<string>[] = [];
    for (let frame = 0; frame < 6; frame++) {
      const allowed = new Set(frame < 4 ? HERO : frame === 4 ? ELDER : SLIME);
      const colors = new Set<string>();
      let visible = 0;
      let grounded = false;
      const bytes: number[] = [];
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const at = (y * 192 + frame * 32 + x) * 4;
          const alpha = image.data[at + 3];
          expect(alpha === 0 || alpha === 255).toBe(true);
          bytes.push(image.data[at], image.data[at + 1], image.data[at + 2], alpha);
          if (alpha === 0) continue;
          visible++;
          if (y === 31) grounded = true;
          const color = `${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`;
          colors.add(color);
          expect(allowed.has(color)).toBe(true);
        }
      }
      expect(visible).toBeGreaterThanOrEqual(frame === 5 ? 220 : 280);
      expect(grounded).toBe(true);
      expect(colors.size).toBeGreaterThanOrEqual(frame === 5 ? 5 : 6);
      frameHashes.push(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
      frameColors.push(colors);
    }
    expect(new Set(frameHashes.slice(0, 4)).size).toBe(4);
    expect(frameColors[5].has("255,255,255")).toBe(true);
  });

  test("four directional walk cycles stay anchored, distinct and inside the hero palette", async () => {
    const image = await rgba(join(FINAL, "hero-walk.png"));
    expect([image.width, image.height]).toEqual([128, 128]);
    const allowed = new Set(HERO);
    for (let direction = 0; direction < 4; direction++) {
      const frames: string[][] = [];
      const hashes = new Set<string>();
      const centers: number[] = [];
      for (let frame = 0; frame < 4; frame++) {
        const source = await rgba(join(SOURCE, `hero-walk-${["south", "north", "west", "east"][direction]}-${frame}.png`));
        expect([source.width, source.height]).toEqual([88, 88]);
        expect(source.data[3]).toBe(0);
        expect(source.data[source.data.length - 1]).toBe(0);

        const pixels: string[] = [];
        const colors = new Set<string>();
        const bytes: number[] = [];
        let visible = 0;
        let weightedX = 0;
        let minX = 32;
        let minY = 32;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            const at = ((direction * 32 + y) * image.width + frame * 32 + x) * 4;
            const alpha = image.data[at + 3];
            expect(alpha === 0 || alpha === 255).toBe(true);
            const color = alpha === 0 ? "" : `${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`;
            pixels.push(color);
            bytes.push(image.data[at], image.data[at + 1], image.data[at + 2], alpha);
            if (alpha === 0) continue;
            expect(allowed.has(color)).toBe(true);
            colors.add(color);
            visible++;
            weightedX += x;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
        expect(visible).toBeGreaterThanOrEqual(260);
        expect(maxY).toBe(31);
        expect(maxX - minX + 1).toBeGreaterThanOrEqual(16);
        expect(maxY - minY + 1).toBeGreaterThanOrEqual(28);
        expect(colors.size).toBeGreaterThanOrEqual(8);
        centers.push(weightedX / visible);
        frames.push(pixels);
        hashes.add(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
      }
      expect(hashes.size).toBe(4);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      for (let frame = 0; frame < 4; frame++) {
        const changed = frames[frame].filter((pixel, at) => pixel !== frames[(frame + 1) % 4][at]).length;
        expect(changed).toBeGreaterThanOrEqual(90);
        expect(changed).toBeLessThanOrEqual(400);
      }
    }
  });

  test("battle reuses the same actors and palettes at a readable 64x64 scale", async () => {
    expect(createHash("sha256").update(readFileSync(join(FINAL, "battle-actors.png"))).digest("hex"))
      .toBe("854493423c1c2c070bc7ca70c27fc4049e8ed9630e9c20a0508b3c6b9f14a521");
    const image = await rgba(join(FINAL, "battle-actors.png"));
    expect([image.width, image.height]).toEqual([128, 64]);
    for (let frame = 0; frame < 2; frame++) {
      const allowed = new Set(frame === 0 ? HERO : SLIME);
      let visible = 0;
      let grounded = false;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const at = (y * 128 + frame * 64 + x) * 4;
          const alpha = image.data[at + 3];
          expect(alpha === 0 || alpha === 255).toBe(true);
          if (alpha === 0) continue;
          visible++;
          if (y === 63) grounded = true;
          expect(allowed.has(`${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`)).toBe(true);
        }
      }
      expect(visible).toBeGreaterThan(frame === 0 ? 1000 : 900);
      expect(grounded).toBe(true);
    }
  });
});
