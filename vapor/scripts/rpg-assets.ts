// PixelLab -> deterministic GBA 4bpp assets for the Vapor Quest POC.
//
// `generate` is the only networked step. It reads PIXELLAB_API_KEY from the
// environment and commits no credential. `build` and `check` are offline and
// turn the reviewed source PNGs into exact palette-indexed sheets plus a C
// header consumed by the GBA runtime.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

const ROOT = join(import.meta.dir, "..", "examples", "rpg", "assets");
const SOURCE = join(ROOT, "source");
const FINAL = join(ROOT, "final");
const HEADER = join(import.meta.dir, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");
const MANIFEST = join(ROOT, "generation.json");
const API = "https://api.pixellab.ai/v2";

const WORLD_TILE_SIZE = 16;
const WORLD_TILE_COLUMNS = 10;
const WORLD_ACTOR_SIZE = 32;
const BATTLE_ACTOR_SIZE = 64;
const WALK_DIRECTIONS = ["south", "north", "west", "east"] as const;
const WALK_FRAME_COUNT = 4;

type Rgb = readonly [number, number, number];
type Palette = readonly Rgb[];
type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

const BG: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x29, 0x4a], [0x21, 0x7b, 0x42], [0x42, 0xc6, 0x5a],
  [0x84, 0x5a, 0x29], [0xc6, 0x9c, 0x52], [0x4a, 0x52, 0x63], [0x9c, 0xa5, 0xad],
  [0x18, 0x4a, 0x94], [0x39, 0x94, 0xe7], [0x21, 0x52, 0x29], [0x29, 0xa5, 0x42],
  [0xff, 0xd6, 0x42], [0x21, 0x31, 0x63], [0xef, 0xde, 0x94], [0xff, 0x52, 0x52],
] as const;

const HERO: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x29, 0x4a], [0xc6, 0x6b, 0x42], [0xff, 0xad, 0x63],
  [0x21, 0x52, 0xad], [0x42, 0x84, 0xff], [0x84, 0xb5, 0xff], [0xb5, 0x42, 0x31],
  [0xff, 0x7b, 0x4a], [0xef, 0xde, 0x94],
] as const;
const ELDER: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x29, 0x4a], [0xc6, 0x6b, 0x42], [0xff, 0xad, 0x63],
  [0x4a, 0x52, 0x63], [0x73, 0x7b, 0x8c], [0x9c, 0xa5, 0xad], [0xc6, 0xd6, 0xde],
  [0xff, 0xff, 0xff], [0x42, 0x84, 0xff],
] as const;
const SLIME: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x29, 0x4a], [0x00, 0x5a, 0x5a], [0x00, 0xad, 0xad],
  [0x39, 0xd6, 0xc6], [0x94, 0xf7, 0xde], [0xff, 0xff, 0xff],
] as const;

const STYLE_PALETTE: Palette = [
  [0x18, 0x29, 0x4a], [0x21, 0x31, 0x63], [0x21, 0x7b, 0x42], [0x42, 0xc6, 0x5a],
  [0x84, 0x5a, 0x29], [0xc6, 0x9c, 0x52], [0x18, 0x4a, 0x94], [0x39, 0x94, 0xe7],
  [0xc6, 0x6b, 0x42], [0xff, 0xad, 0x63], [0x42, 0x84, 0xff], [0xff, 0x7b, 0x4a],
  [0x73, 0x7b, 0x8c], [0xff, 0xff, 0xff], [0x00, 0xad, 0xad], [0x94, 0xf7, 0xde],
] as const;

const WORLD_TILE_NAMES = [
  "blank", "grass-a", "grass-b", "path-a", "path-b", "wall", "water-a", "water-b",
  "tree", "flower",
] as const;
const UI_TILE_NAMES = [
  "box-fill", "box-top", "box-bottom", "box-left", "box-right", "box-tl", "box-tr", "box-bl",
  "box-br", "battle-sky", "battle-ground", "hp-empty", "hp-full", "hud",
] as const;
const ACTOR_NAMES = ["hero-south", "hero-north", "hero-west", "hero-east", "elder", "slime"] as const;
const WALK_SOURCE_FILES = WALK_DIRECTIONS.flatMap((direction) =>
  Array.from({ length: WALK_FRAME_COUNT }, (_, frame) => `hero-walk-${direction}-${frame}.png`)
);

const STYLE = [
  "Original cheerful early-2000s handheld cartridge RPG pixel art.",
  "High top-down world view, expressive 32-pixel chibi characters, crisp hard-edged native pixels.",
  "One-pixel selective deep-navy outlines, flat clusters, fixed top-left lighting.",
  "Readable silhouettes and restrained surface texture; no imitation of any existing game.",
].join(" ");

const TERRAIN_STYLE = [
  "Original cheerful early-2000s handheld cartridge RPG terrain pixel art.",
  "Strict high top-down orthographic view, crisp hard-edged native pixels.",
  "Small flat color clusters, fixed top-left lighting, restrained readable texture.",
  "No characters, items, icons, perspective, canvas border or imitation of an existing game.",
].join(" ");

const MONSTER_STYLE = [
  "Original cheerful early-2000s handheld cartridge RPG monster pixel art.",
  "High top-down view, crisp hard-edged native pixels, flat color clusters and fixed top-left lighting.",
  "One-pixel selective deep-navy outline, readable non-humanoid silhouette, no imitation of any existing game.",
].join(" ");

const EXCLUSIONS = [
  "antialiasing", "blur", "gradients", "dithering", "soft shadows", "bloom", "photorealism",
  "painterly texture", "isometric view", "perspective", "text", "letters", "numbers", "labels",
  "watermark", "logo", "mockup", "enlarged preview", "multiple characters", "duplicate subject",
  "sprite sheet", "contact sheet", "lineup", "alternate poses",
].join(", ");

const GENERATION = {
  version: 3,
  provider: "PixelLab",
  apiBase: API,
  artDirection: "Vapor Quest close-up: 16px world cells, 32px actors, deep-navy information layer",
  assets: {
    styleAnchor: {
      endpoint: "/create-image-pixen",
      seed: 23050,
      size: { width: 64, height: 64 },
      prompt: `${STYLE} Exactly one single south-facing full-body blue-tunic adventurer with short brown hair and a warm orange scarf, centered in a neutral standing pose on transparent background. Blue clothing must be the largest color area. This is a canonical style reference, not a sprite sheet: one subject, one pose, no duplicate, no alternate view, no scenery, text or UI.`,
    },
    terrainSets: [
      {
        name: "field",
        endpoint: "/tilesets",
        seed: 23061,
        lower: `${TERRAIN_STYLE} Native 16x16 seamless bright green meadow grass, quiet walkable ground, four or five deliberate dark grass blades, no objects or border.`,
        upper: `${TERRAIN_STYLE} Native 16x16 seamless warm tan compacted village footpath, quiet walkable ground, a few readable brown pebbles, no grass edge or border.`,
        lowerFile: "grass.png",
        upperFile: "path.png",
      },
      {
        name: "barriers",
        endpoint: "/tilesets",
        seed: 23062,
        lower: `${TERRAIN_STYLE} Native 16x16 seamless deep blue stream water, clearly impassable, three crisp horizontal ripple clusters, quiet even field, no shore or border.`,
        upper: `${TERRAIN_STYLE} Native 16x16 seamless gray stone barrier, clearly solid and impassable, chunky rectangular stones, dark mortar and bright top-left edges, no grass or border.`,
        lowerFile: "water.png",
        upperFile: "wall.png",
      },
    ],
    mapObjects: [
      {
        name: "tree",
        endpoint: "/map-objects",
        seed: 23069,
        prompt: `${STYLE} One centered top-down deciduous tree map object designed to fill one 16x16 world cell after reduction. A single compact, solid, filled round dome canopy occupies most of the image and must never form a hollow ring, split crown, doorway or arch. Dense leaves read as impassable, with dark lower-right foliage, bright top-left leaf clusters and exactly one short centered trunk. No grass tile and no cast shadow.`,
      },
      {
        name: "flower",
        endpoint: "/map-objects",
        seed: 23066,
        prompt: `${STYLE} One readable gold-and-cream meadow flower cluster designed for one 16x16 world cell after reduction. Low-profile walkable decoration, three small blossoms and delicate green stems, no enclosing outline, no ground tile and no cast shadow.`,
      },
    ],
    heroSouth: {
      endpoint: "/create-image-bitforge",
      seed: 23063,
      size: { width: 64, height: 64 },
      prompt: `${STYLE} Exactly one south-facing native 64x64 source sprite designed to retain facial, clothing and limb detail in a 32x32 GBA character. Full-body chibi adventurer with a readable head, short brown hair, torso, two arms, gloves, boots and two separated feet. Blue tunic and darker blue trousers are the largest color blocks; warm orange-red scarf is the identity accent; warm skin and selective deep-navy outline. Centered, feet at the bottom, strong silhouette, no weapon, no detached pixels, no duplicate, no alternate pose, no sprite sheet.`,
    },
    heroRotations: {
      endpoint: "/create-character-v3",
      seed: 23054,
      prompt: "The same expressive blue-tunic adventurer with short brown hair, orange-red scarf, gloves and boots, rotated consistently for a high top-down RPG; preserve face, head height, shoulder width, clothing blocks, palette, outline and foot anchor in every direction.",
    },
    heroWalk: {
      endpoint: "/characters/animations",
      seed: 23071,
      templateAnimationId: "walking-4-frames",
      animationName: "Vapor Quest Walk",
      directions: WALK_DIRECTIONS,
      frameCount: WALK_FRAME_COUNT,
      prompt: "A compact, cyclic four-frame walk with alternating arms and legs, steady high top-down camera, stable body proportions, fixed ground plane and no translation inside the source canvas.",
    },
    elder: {
      endpoint: "/create-image-pixen",
      seed: 23060,
      size: { width: 64, height: 64 },
      prompt: `${STYLE} Exactly one south-facing native 64x64 source sprite designed to retain facial, hair and robe detail in a 32x32 GBA character. Full-body chibi village elder with swept white hair, eyebrows, short white beard, broad layered gray robe, blue sash, warm skin, deep-navy outline, two visible arms and a grounded hem. Same height, head ratio, lighting and foot anchor as the blue-tunic adventurer. No staff, centered, no skeleton or ghost appearance, no detached pixels, no duplicate, no alternate pose, no sprite sheet.`,
    },
    slime: {
      endpoint: "/map-objects",
      seed: 23065,
      size: { width: 64, height: 64 },
      prompt: `${MONSTER_STYLE} Exactly one native 64x64 source sprite designed to retain face, highlight and volume detail in a 32x32 GBA monster. A compact teal tentacled puddle ooze with a rounded central body and several short grounded pseudopods. Its amorphous body is at least ninety percent a four-step teal ramp, with a deep-navy outline, broad grounded base, two tiny white eyes and a small dark mouth. Cute but clearly an enemy, wider than tall, with no humanoid torso, clothing, hands or feet, no floating parts, centered at the bottom, no duplicate, no alternate pose, no sprite sheet.`,
    },
  },
} as const;

function ensureDirs(): void {
  mkdirSync(SOURCE, { recursive: true });
  mkdirSync(FINAL, { recursive: true });
}

function hex([r, g, b]: Rgb): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function paletteText(palette: Palette): string {
  return palette.map(hex).join(", ");
}

function palettePng(palette: Palette): Buffer {
  const canvas = createCanvas(64, 16);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 16; i++) {
    const color = palette[Math.min(i, palette.length - 1)];
    ctx.fillStyle = hex(color);
    ctx.fillRect(i * 4, 0, 4, 16);
  }
  return canvas.toBuffer("image/png");
}

function paletteGuidePng(): Buffer {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  for (const [row, palette] of [BG, HERO, ELDER, SLIME].entries()) {
    for (let i = 0; i < 16; i++) {
      // Match the generated GBA palette banks: unused OBJ entries are zero,
      // not repetitions of the last authored color.
      const color = palette[i] ?? ([0, 0, 0] as const);
      ctx.fillStyle = hex(color);
      ctx.fillRect(i * 4, row * 16, 4, 16);
    }
  }
  return canvas.toBuffer("image/png");
}

function base64Image(bytes: Buffer): { type: "base64"; base64: string; format: "png" } {
  return { type: "base64", base64: bytes.toString("base64"), format: "png" };
}

async function resizePng(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer("image/png");
}

async function pixelLab<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.PIXELLAB_API_KEY;
  if (!key) throw new Error("PIXELLAB_API_KEY is not set; source ~/code/.env first");
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`PixelLab ${path} failed (${response.status}): ${detail}`);
  }
  return await response.json() as T;
}

function imageBytes(image: { base64: string }): Buffer {
  const encoded = image.base64.includes("base64,")
    ? image.base64.slice(image.base64.indexOf("base64,") + 7)
    : image.base64;
  return Buffer.from(encoded, "base64");
}

async function generatePixen(
  file: string,
  spec: { prompt: string; seed: number; size: { width: number; height: number } },
  palette: Palette,
): Promise<{ hash: string }> {
  console.log(`PixelLab: generating ${file}`);
  const response = await pixelLab<{ image: { base64: string } }>("/create-image-pixen", {
    description: `${spec.prompt} Use this fixed color language: ${paletteText(palette)}. Avoid ${EXCLUSIONS}.`,
    image_size: spec.size,
    outline: "selective outline",
    detail: "medium detail",
    view: "high top-down",
    direction: "south",
    no_background: true,
    background_removal_task: "remove_simple_background",
    seed: spec.seed,
  });
  const bytes = imageBytes(response.image);
  writeFileSync(join(SOURCE, file), bytes);
  return { hash: sha256(bytes) };
}

async function generateBitforge(
  file: string,
  spec: { prompt: string; seed: number; size: { width: number; height: number } },
  palette: Palette,
  styleImage: Buffer,
): Promise<{ hash: string }> {
  console.log(`PixelLab: generating ${file}`);
  const styleReference = await resizePng(styleImage, spec.size.width, spec.size.height);
  const response = await pixelLab<{ image: { base64: string } }>("/create-image-bitforge", {
    description: `${spec.prompt} Use only these palette colors: ${paletteText(palette)}.`,
    negative_description: EXCLUSIONS,
    image_size: spec.size,
    text_guidance_scale: 12,
    style_strength: 35,
    outline: "selective outline",
    shading: "basic shading",
    detail: "medium detail",
    view: "high top-down",
    direction: "south",
    no_background: true,
    coverage_percentage: 84,
    color_image: base64Image(palettePng(palette)),
    style_image: base64Image(styleReference),
    seed: spec.seed,
  });
  const bytes = imageBytes(response.image);
  writeFileSync(join(SOURCE, file), bytes);
  return { hash: sha256(bytes) };
}

async function generateHeroRotations(reference: Buffer): Promise<{
  backgroundJobId: string;
  characterId: string;
  hashes: Record<string, string>;
}> {
  const spec = GENERATION.assets.heroRotations;
  console.log("PixelLab: generating consistent hero rotations");
  const created = await pixelLab<{
    background_job_id: string;
    character_id: string;
  }>("/create-character-v3", {
    description: spec.prompt,
    reference_image: base64Image(reference),
    view: "high top-down",
    template_id: "mannequin",
    name: "Vapor Quest Hero",
    seed: spec.seed,
    no_background: true,
    outline: "selective outline",
    detail: "medium detail",
  });

  for (;;) {
    await Bun.sleep(5000);
    const response = await fetch(`${API}/background-jobs/${created.background_job_id}`, {
      headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
    });
    if (!response.ok) throw new Error(`PixelLab job poll failed (${response.status})`);
    const job = await response.json() as { status: string; last_response?: unknown };
    console.log(`PixelLab: hero rotations ${job.status}`);
    if (job.status === "failed") throw new Error(`PixelLab hero rotation job failed: ${JSON.stringify(job.last_response)}`);
    if (job.status === "completed") break;
  }

  const detailResponse = await fetch(`${API}/characters/${created.character_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!detailResponse.ok) throw new Error(`PixelLab character fetch failed (${detailResponse.status})`);
  const detail = await detailResponse.json() as {
    rotation_urls: Record<string, string | null> | null;
  };
  if (!detail.rotation_urls) throw new Error("PixelLab returned no hero rotations");
  const hashes: Record<string, string> = {};
  for (const direction of ["south", "north", "west", "east"] as const) {
    const url = detail.rotation_urls[direction];
    if (!url) throw new Error(`PixelLab returned no ${direction} hero rotation`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PixelLab ${direction} rotation download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(SOURCE, `hero-${direction}.png`), bytes);
    hashes[direction] = sha256(bytes);
  }
  return {
    backgroundJobId: created.background_job_id,
    characterId: created.character_id,
    hashes,
  };
}

async function waitForJob(jobId: string, label: string): Promise<Record<string, unknown>> {
  for (;;) {
    await Bun.sleep(5000);
    const response = await fetch(`${API}/background-jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
    });
    if (!response.ok) throw new Error(`PixelLab ${label} job poll failed (${response.status})`);
    const job = await response.json() as { status: string; last_response?: Record<string, unknown> };
    console.log(`PixelLab: ${label} ${job.status}`);
    if (job.status === "failed") throw new Error(`PixelLab ${label} failed: ${JSON.stringify(job.last_response)}`);
    if (job.status === "completed") return job.last_response ?? {};
  }
}

type CharacterAnimationGroup = {
  animation_type: string;
  display_name?: string | null;
  animation_group_id?: string | null;
  directions: Array<{ direction: string; frame_count: number; frames: string[] }>;
};

async function generateHeroWalk(characterId: string): Promise<{
  characterId: string;
  animationGroupId: string;
  backgroundJobIds: Record<string, string>;
  hashes: Record<string, string>;
}> {
  const spec = GENERATION.assets.heroWalk;
  console.log("PixelLab: generating consistent four-direction hero walk");
  const created = await pixelLab<{
    background_job_ids: string[];
    directions: string[];
  }>(spec.endpoint, {
    character_id: characterId,
    mode: "template",
    template_animation_id: spec.templateAnimationId,
    animation_name: spec.animationName,
    action_description: spec.prompt,
    directions: spec.directions,
    outline: "selective outline",
    shading: "basic shading",
    detail: "medium detail",
    color_image: base64Image(palettePng(HERO)),
    force_colors: true,
    seed: spec.seed,
  });
  if (created.background_job_ids.length !== WALK_DIRECTIONS.length ||
      created.directions.length !== WALK_DIRECTIONS.length) {
    throw new Error("PixelLab hero walk did not queue exactly four directions");
  }
  const backgroundJobIds: Record<string, string> = {};
  const groupIds = new Set<string>();
  for (let index = 0; index < created.background_job_ids.length; index++) {
    const direction = created.directions[index];
    const jobId = created.background_job_ids[index];
    if (!WALK_DIRECTIONS.includes(direction as typeof WALK_DIRECTIONS[number])) {
      throw new Error(`PixelLab hero walk returned unexpected direction ${direction}`);
    }
    backgroundJobIds[direction] = jobId;
    const result = await waitForJob(jobId, `hero walk ${direction}`);
    const groupId = result.animation_group_id;
    if (typeof groupId === "string") groupIds.add(groupId);
  }
  if (Object.keys(backgroundJobIds).length !== WALK_DIRECTIONS.length) {
    throw new Error("PixelLab hero walk returned duplicate directions");
  }

  let group: CharacterAnimationGroup | undefined;
  for (let attempt = 0; attempt < 12 && !group; attempt++) {
    const detailResponse = await fetch(`${API}/characters/${characterId}`, {
      headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
    });
    if (!detailResponse.ok) throw new Error(`PixelLab hero walk character fetch failed (${detailResponse.status})`);
    const detail = await detailResponse.json() as { animations?: CharacterAnimationGroup[] };
    const animations = detail.animations ?? [];
    group = animations.find((candidate) =>
      !!candidate.animation_group_id && groupIds.has(candidate.animation_group_id)
    ) ?? [...animations].reverse().find((candidate) =>
      candidate.display_name === spec.animationName && candidate.animation_type === spec.templateAnimationId
    ) ?? [...animations].reverse().find((candidate) => candidate.animation_type === spec.templateAnimationId);
    if (!group) await Bun.sleep(5000);
  }
  if (!group) throw new Error("PixelLab hero walk animation group did not become available");
  if (!group.animation_group_id) throw new Error("PixelLab hero walk animation has no group ID");

  const hashes: Record<string, string> = {};
  for (const direction of WALK_DIRECTIONS) {
    const sequence = group.directions.find((candidate) => candidate.direction === direction);
    if (!sequence || sequence.frame_count !== WALK_FRAME_COUNT || sequence.frames.length !== WALK_FRAME_COUNT) {
      throw new Error(`PixelLab hero walk ${direction} must contain exactly ${WALK_FRAME_COUNT} frames`);
    }
    for (let frame = 0; frame < WALK_FRAME_COUNT; frame++) {
      const response = await fetch(sequence.frames[frame]);
      if (!response.ok) throw new Error(`PixelLab hero walk ${direction} frame ${frame} download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const file = `hero-walk-${direction}-${frame}.png`;
      writeFileSync(join(SOURCE, file), bytes);
      hashes[file] = sha256(bytes);
    }
  }
  return {
    characterId,
    animationGroupId: group.animation_group_id,
    backgroundJobIds,
    hashes,
  };
}

async function generateTileset(spec: typeof GENERATION.assets.terrainSets[number]): Promise<Record<string, string>> {
  console.log(`PixelLab: generating ${spec.name} terrain tileset`);
  const created = await pixelLab<{ background_job_id: string; tileset_id: string }>("/tilesets", {
    lower_description: spec.lower,
    upper_description: spec.upper,
    transition_description: "clean hard pixel boundary",
    tile_size: { width: 16, height: 16 },
    mode: "standard",
    text_guidance_scale: 10,
    outline: "selective outline",
    shading: "basic shading",
    detail: "low detail",
    view: "high top-down",
    tile_strength: 1.3,
    tileset_adherence_freedom: 400,
    tileset_adherence: 120,
    transition_size: 0.25,
    seed: spec.seed,
  });
  await waitForJob(created.background_job_id, `${spec.name} terrain`);
  const response = await fetch(`${API}/tilesets/${created.tileset_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!response.ok) throw new Error(`PixelLab ${spec.name} tileset fetch failed (${response.status})`);
  const result = await response.json() as {
    tileset: { tiles: Array<{
      corners: Record<string, string>;
      image: { type: "base64"; base64: string; format: string };
    }> };
  };
  const hashes: Record<string, string> = {};
  for (const [terrain, file] of [["lower", spec.lowerFile], ["upper", spec.upperFile]] as const) {
    const tile = result.tileset.tiles.find((candidate) =>
      Object.values(candidate.corners).every((corner) => corner === terrain));
    if (!tile) throw new Error(`PixelLab ${spec.name} tileset has no all-${terrain} base tile`);
    const bytes = imageBytes(tile.image);
    writeFileSync(join(SOURCE, file), bytes);
    hashes[file] = sha256(bytes);
  }
  return { backgroundJobId: created.background_job_id, tilesetId: created.tileset_id, ...hashes };
}

async function generateMapObject(spec: typeof GENERATION.assets.mapObjects[number]): Promise<Record<string, string>> {
  console.log(`PixelLab: generating ${spec.name} map object`);
  const created = await pixelLab<{ background_job_id: string; object_id: string }>("/map-objects", {
    description: `${spec.prompt} Use only these palette colors: ${paletteText(BG)}.`,
    image_size: { width: 32, height: 32 },
    view: "high top-down",
    outline: "selective outline",
    shading: "basic shading",
    detail: "low detail",
    text_guidance_scale: 10,
    color_image: base64Image(await resizePng(palettePng(BG), 32, 32)),
    seed: spec.seed,
  });
  await waitForJob(created.background_job_id, `${spec.name} object`);
  const detail = await fetch(`${API}/map-objects/${created.object_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!detail.ok) throw new Error(`PixelLab ${spec.name} object fetch failed (${detail.status})`);
  const object = await detail.json() as { download_url?: string | null };
  if (!object.download_url) throw new Error(`PixelLab ${spec.name} object has no download URL`);
  const download = await fetch(object.download_url);
  if (!download.ok) throw new Error(`PixelLab ${spec.name} object download failed (${download.status})`);
  const bytes = Buffer.from(await download.arrayBuffer());
  writeFileSync(join(SOURCE, `${spec.name}.png`), bytes);
  return { backgroundJobId: created.background_job_id, objectId: created.object_id, hash: sha256(bytes) };
}

async function generateMapSprite(
  file: string,
  spec: { prompt: string; seed: number; size: { width: number; height: number } },
  palette: Palette,
): Promise<Record<string, string>> {
  console.log(`PixelLab: generating ${file}`);
  const created = await pixelLab<{ background_job_id: string; object_id: string }>("/map-objects", {
    description: `${spec.prompt} Use only these palette colors: ${paletteText(palette)}.`,
    image_size: spec.size,
    view: "high top-down",
    outline: "selective outline",
    shading: "basic shading",
    detail: "medium detail",
    text_guidance_scale: 12,
    color_image: base64Image(await resizePng(palettePng(palette), spec.size.width, spec.size.height)),
    seed: spec.seed,
  });
  await waitForJob(created.background_job_id, file);
  const detail = await fetch(`${API}/map-objects/${created.object_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!detail.ok) throw new Error(`PixelLab ${file} fetch failed (${detail.status})`);
  const object = await detail.json() as { download_url?: string | null };
  if (!object.download_url) throw new Error(`PixelLab ${file} has no download URL`);
  const download = await fetch(object.download_url);
  if (!download.ok) throw new Error(`PixelLab ${file} download failed (${download.status})`);
  const bytes = Buffer.from(await download.arrayBuffer());
  writeFileSync(join(SOURCE, file), bytes);
  return {
    backgroundJobId: created.background_job_id,
    objectId: created.object_id,
    hash: sha256(bytes),
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function generate(force: boolean): Promise<void> {
  ensureDirs();
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg?.slice("--only=".length) ?? "missing";
  if (!["missing", "all", "style", "world", "tree", "flower", "characters", "hero", "walk", "elder", "slime"].includes(only)) {
    throw new Error("--only must be one of missing, all, style, world, tree, flower, characters, hero, walk, elder, slime");
  }
  const previous = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { records?: Record<string, unknown> }
    : {};
  const records: Record<string, unknown> = { ...previous.records };
  const selected = (group: string, files: string[]): boolean =>
    only === "all" || only === group || files.some((file) => !existsSync(join(SOURCE, file)));

  if (selected("style", ["style-anchor.png"]) && (force || !existsSync(join(SOURCE, "style-anchor.png")))) {
    records.styleAnchor = await generatePixen("style-anchor.png", GENERATION.assets.styleAnchor, STYLE_PALETTE);
  }
  const anchor = readFileSync(join(SOURCE, "style-anchor.png"));
  const worldFiles = [
    ...GENERATION.assets.terrainSets.flatMap((asset) => [asset.lowerFile, asset.upperFile]),
    ...GENERATION.assets.mapObjects.map((asset) => `${asset.name}.png`),
  ];
  const worldSelected = only === "all" || only === "world" || only === "tree" || only === "flower"
    || worldFiles.some((file) => !existsSync(join(SOURCE, file)));
  if (worldSelected) {
    records.world = {
      ...(typeof records.world === "object" && records.world !== null
        ? records.world as Record<string, unknown>
        : {}),
    };
    for (const asset of GENERATION.assets.terrainSets) {
      const forceTerrain = force && (only === "all" || only === "world");
      if (forceTerrain || !existsSync(join(SOURCE, asset.lowerFile)) || !existsSync(join(SOURCE, asset.upperFile))) {
        (records.world as Record<string, unknown>)[asset.name] = await generateTileset(asset);
      }
    }
    for (const asset of GENERATION.assets.mapObjects) {
      const file = `${asset.name}.png`;
      const forceObject = force && (only === "all" || only === "world" || only === asset.name);
      if (forceObject || !existsSync(join(SOURCE, file))) {
        (records.world as Record<string, unknown>)[asset.name] = await generateMapObject(asset);
      }
    }
  }

  const characterFiles = [
    "hero-south-reference.png", "hero-south.png", "hero-north.png", "hero-west.png", "hero-east.png",
    "elder.png", "slime.png",
  ];
  const charactersMissing = characterFiles.some((file) => !existsSync(join(SOURCE, file)));
  const charactersSelected = only === "all" || only === "characters" || only === "hero"
    || only === "elder" || only === "slime" || charactersMissing;
  let heroRegenerated = false;
  if (charactersSelected) {
    const forceHero = force && (only === "all" || only === "characters" || only === "hero");
    if (forceHero || !existsSync(join(SOURCE, "hero-south-reference.png"))) {
      records.heroSouth = await generateBitforge("hero-south-reference.png", GENERATION.assets.heroSouth, HERO, anchor);
    }
    const rotationsMissing = ["hero-south.png", "hero-north.png", "hero-west.png", "hero-east.png"]
      .some((file) => !existsSync(join(SOURCE, file)));
    if (forceHero || rotationsMissing) {
      records.heroRotations = await generateHeroRotations(readFileSync(join(SOURCE, "hero-south-reference.png")));
      heroRegenerated = true;
    }
    const forceElder = force && (only === "all" || only === "characters" || only === "elder");
    if (forceElder || !existsSync(join(SOURCE, "elder.png"))) {
      records.elder = await generatePixen("elder.png", GENERATION.assets.elder, ELDER);
    }
    const forceSlime = force && (only === "all" || only === "characters" || only === "slime");
    if (forceSlime || !existsSync(join(SOURCE, "slime.png"))) {
      records.slime = await generateMapSprite("slime.png", GENERATION.assets.slime, SLIME);
    }
  }
  const walkRecord = records.heroWalk as { characterId?: unknown } | undefined;
  const walkMissing = WALK_SOURCE_FILES.some((file) => !existsSync(join(SOURCE, file)))
    || typeof walkRecord?.characterId !== "string";
  const walkSelected = only === "all" || only === "characters" || only === "hero" || only === "walk" || walkMissing;
  const forceWalk = heroRegenerated || (force && ["all", "characters", "hero", "walk"].includes(only));
  if (walkSelected && (forceWalk || walkMissing)) {
    const rotations = records.heroRotations as { characterId?: unknown } | undefined;
    if (typeof rotations?.characterId !== "string") {
      throw new Error("hero walk needs a generated PixelLab character; run --only=hero first");
    }
    records.heroWalk = await generateHeroWalk(rotations.characterId);
  }
  delete records.backgroundAtlas;
  const sourceHashes = Object.fromEntries(
    ["style-anchor.png", ...worldFiles, ...characterFiles, ...WALK_SOURCE_FILES]
      .map((file) => [file, sha256(readFileSync(join(SOURCE, file)))]),
  );
  writeFileSync(MANIFEST, `${JSON.stringify({ ...GENERATION, records, sourceHashes }, null, 2)}\n`);
  await build(false);
}

function nearestColor(r: number, g: number, b: number, palette: Palette, start = 0): number {
  let best = start;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = start; i < palette.length; i++) {
    const color = palette[i];
    const distance = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Preserve a generated terrain tile's pixel clusters while translating its
 * arbitrary colors into a small semantic GBA ramp. The input luminance range
 * determines the authored texture; the ramp only fixes material identity.
 */
export function projectTerrain(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  shadow: number,
  base: number,
  highlight: number,
  shadowCount: number,
  highlightCount: number,
): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error("terrain RGBA dimensions do not match");
  if (shadowCount < 0 || highlightCount < 0 || shadowCount + highlightCount > width * height) {
    throw new Error("terrain projection counts exceed the source tile");
  }
  const ranked = Array.from({ length: width * height }, (_, index) => ({
    index,
    // Integer Rec. 709-style weights plus an index tie-break make the same
    // reviewed PNG produce byte-identical art on every build host.
    luminance: rgba[index * 4] * 54 + rgba[index * 4 + 1] * 183 + rgba[index * 4 + 2] * 19,
  })).sort((a, b) => a.luminance - b.luminance || a.index - b.index);
  const result = new Uint8Array(width * height);
  result.fill(base);
  for (let i = 0; i < shadowCount; i++) result[ranked[i].index] = shadow;
  for (let i = 0; i < highlightCount; i++) result[ranked[ranked.length - 1 - i].index] = highlight;
  return result;
}

function indicesFromContext(ctx: SKRSContext2D, width: number, height: number, palette: Palette, transparent: boolean): Uint8Array {
  const raw = ctx.getImageData(0, 0, width, height) as ImageDataLike;
  const result = new Uint8Array(width * height);
  for (let i = 0; i < result.length; i++) {
    const alpha = raw.data[i * 4 + 3];
    if (transparent && alpha < 128) {
      result[i] = 0;
    } else {
      result[i] = nearestColor(raw.data[i * 4], raw.data[i * 4 + 1], raw.data[i * 4 + 2], palette, transparent ? 1 : 0);
    }
  }
  return result;
}

function drawIndices(ctx: SKRSContext2D, pixels: Uint8Array, width: number, height: number, palette: Palette, dx: number, dy: number, transparent: boolean): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixels[y * width + x];
      if (transparent && index === 0) continue;
      ctx.fillStyle = hex(palette[index]);
      ctx.fillRect(dx + x, dy + y, 1, 1);
    }
  }
}

async function loadExact(path: string, width: number, height: number) {
  if (!existsSync(path)) throw new Error(`missing source asset: ${path}; run vapor:rpg:assets:generate`);
  const image = await loadImage(path);
  if (image.width !== width || image.height !== height) {
    throw new Error(`${path} must be ${width}x${height}, got ${image.width}x${image.height}`);
  }
  return image;
}

export async function buildBackground(sourceDir = SOURCE): Promise<{ png: Buffer; pixels: Uint8Array }> {
  const sheetWidth = WORLD_TILE_COLUMNS * WORLD_TILE_SIZE;
  const sheetHeight = WORLD_TILE_SIZE + 8;
  const canvas = createCanvas(sheetWidth, sheetHeight);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = hex(BG[1]);
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);
  const images = Object.fromEntries(await Promise.all([
    ...["grass", "path", "wall", "water"].map(async (name) => [name, await loadExact(join(sourceDir, `${name}.png`), 16, 16)]),
    ...["tree", "flower"].map(async (name) => [name, await loadExact(join(sourceDir, `${name}.png`), 32, 32)]),
  ]));
  const drawWorldTile = (name: string, frame: number, flip = false) => {
    const dx = frame * WORLD_TILE_SIZE;
    ctx.save();
    if (flip) {
      ctx.translate(dx + WORLD_TILE_SIZE, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(images[name], 0, 0, WORLD_TILE_SIZE, WORLD_TILE_SIZE);
    } else {
      ctx.drawImage(images[name], dx, 0, WORLD_TILE_SIZE, WORLD_TILE_SIZE);
    }
    ctx.restore();
  };
  const drawObject = (name: string, frame: number, maxWidth: number, maxHeight: number): Set<number> => {
    const image = images[name];
    const scratch = createCanvas(image.width, image.height);
    const scratchCtx = scratch.getContext("2d");
    scratchCtx.drawImage(image, 0, 0);
    const raw = scratchCtx.getImageData(0, 0, image.width, image.height) as ImageDataLike;
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (raw.data[(y * image.width + x) * 4 + 3] >= 128) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < minX || maxY < minY) throw new Error(`${name}.png has no opaque pixels`);
    const sourceWidth = maxX - minX + 1;
    const sourceHeight = maxY - minY + 1;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const localX = Math.floor((WORLD_TILE_SIZE - width) / 2);
    const localY = WORLD_TILE_SIZE - height;
    const ox = frame * WORLD_TILE_SIZE + localX;
    const oy = localY;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, minX, minY, sourceWidth, sourceHeight, ox, oy, width, height);
    const mask = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = minX + Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
        const sy = minY + Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
        if (raw.data[(sy * image.width + sx) * 4 + 3] >= 128) {
          mask.add((localY + y) * WORLD_TILE_SIZE + localX + x);
        }
      }
    }
    return mask;
  };
  drawWorldTile("grass", 1);
  drawWorldTile("grass", 2, true);
  drawWorldTile("path", 3);
  drawWorldTile("path", 4, true);
  drawWorldTile("wall", 5);
  drawWorldTile("water", 6);
  drawWorldTile("water", 7, true);
  drawWorldTile("grass", 8);
  drawWorldTile("grass", 9, true);
  const treeMask = drawObject("tree", 8, 15, 16);
  const flowerMask = drawObject("flower", 9, 10, 11);
  const indices = indicesFromContext(ctx, sheetWidth, sheetHeight, BG, false);

  const worldAt = (frame: number, x: number, y: number): number =>
    y * sheetWidth + frame * WORLD_TILE_SIZE + x;
  const paintWorld = (frame: number, x: number, y: number, color: number): void => {
    indices[worldAt(frame, x, y)] = color;
  };

  // The generated PNGs own the base texture. Translate their luminance
  // clusters into material-specific ramps, then add only sparse readability
  // accents below. This keeps PixelLab input materially present in the ROM.
  const sourceRgba = (ctx.getImageData(0, 0, sheetWidth, WORLD_TILE_SIZE) as ImageDataLike).data;
  for (const [frame, sourceFrame, shadow, base, highlight, shadowCount, highlightCount] of [
    [1, 1, 10, 3, 11, 8, 4], [2, 2, 10, 3, 11, 8, 4],
    [3, 3, 4, 5, 14, 20, 10], [4, 4, 4, 5, 14, 20, 10],
    [5, 5, 6, 7, 14, 32, 12],
    [6, 6, 8, 9, 13, 28, 8], [7, 7, 8, 9, 13, 28, 8],
    // Object frames reuse pristine grass projection; their PixelLab masks are
    // applied afterwards and cannot perturb the surrounding ground texture.
    [8, 1, 10, 3, 11, 8, 4], [9, 2, 10, 3, 11, 8, 4],
  ] as const) {
    const tile = new Uint8ClampedArray(WORLD_TILE_SIZE * WORLD_TILE_SIZE * 4);
    for (let y = 0; y < WORLD_TILE_SIZE; y++) {
      for (let x = 0; x < WORLD_TILE_SIZE; x++) {
        const sourceAt = (y * sheetWidth + sourceFrame * WORLD_TILE_SIZE + x) * 4;
        const targetAt = (y * WORLD_TILE_SIZE + x) * 4;
        tile[targetAt] = sourceRgba[sourceAt];
        tile[targetAt + 1] = sourceRgba[sourceAt + 1];
        tile[targetAt + 2] = sourceRgba[sourceAt + 2];
        tile[targetAt + 3] = sourceRgba[sourceAt + 3];
      }
    }
    const mapped = projectTerrain(
      tile,
      WORLD_TILE_SIZE,
      WORLD_TILE_SIZE,
      shadow,
      base,
      highlight,
      shadowCount,
      highlightCount,
    );
    for (let y = 0; y < WORLD_TILE_SIZE; y++) {
      for (let x = 0; x < WORLD_TILE_SIZE; x++) paintWorld(frame, x, y, mapped[y * WORLD_TILE_SIZE + x]);
    }
  }
  for (const [frame, color, marks] of [
    [1, 2, [[2, 3], [11, 5], [5, 12], [14, 14]]],
    [2, 2, [[12, 2], [4, 6], [9, 11], [1, 14]]],
    [3, 4, [[3, 2], [12, 6], [6, 11], [14, 14]]],
    [4, 4, [[12, 2], [5, 5], [2, 11], [10, 14]]],
  ] as const) {
    for (const [x, y] of marks) paintWorld(frame, x, y, color);
  }
  for (const [frame, marks] of [
    [1, [[3, 4], [12, 6], [6, 13]]],
    [2, [[11, 3], [5, 7], [2, 13]]],
  ] as const) for (const [x, y] of marks) paintWorld(frame, x, y, 10);
  for (const [frame, marks] of [
    [3, [[8, 3], [2, 9], [13, 12]]],
    [4, [[4, 2], [11, 8], [6, 13]]],
  ] as const) for (const [x, y] of marks) paintWorld(frame, x, y, 14);
  for (let x = 0; x < WORLD_TILE_SIZE; x++) {
    paintWorld(5, x, 5, 6);
    paintWorld(5, x, 11, 6);
  }
  for (let y = 0; y < 5; y++) paintWorld(5, 7, y, 6);
  for (let y = 6; y < 11; y++) paintWorld(5, 3, y, 6);
  for (let y = 12; y < 16; y++) paintWorld(5, 12, y, 6);
  paintWorld(5, 1, 1, 14);
  paintWorld(5, 9, 7, 14);
  paintWorld(5, 14, 13, 14);
  for (const [frame, rows] of [[6, [3, 10]], [7, [6, 13]]] as const) {
    for (const y of rows) {
      for (let x = 1; x < 7; x++) paintWorld(frame, x, y, 8);
      for (let x = 10; x < 15; x++) paintWorld(frame, x, (y + 5) % 16, 8);
    }
  }
  paintWorld(6, 12, 2, 13);
  paintWorld(6, 4, 12, 13);
  paintWorld(7, 3, 4, 13);
  paintWorld(7, 12, 11, 13);

  for (const local of treeMask) {
    const x = local % WORLD_TILE_SIZE;
    const y = Math.floor(local / WORLD_TILE_SIZE);
    const at = worldAt(8, x, y);
    if (y >= 12 && x >= 6 && x <= 9) indices[at] = y === 12 ? 5 : 4;
    else indices[at] = ((x * 3 + y * 5) % 11 < 3) ? 11 : 10;
  }
  for (const local of flowerMask) {
    const x = local % WORLD_TILE_SIZE;
    const y = Math.floor(local / WORLD_TILE_SIZE);
    indices[worldAt(9, x, y)] = y < 9 ? ((x + y) % 3 ? 12 : 14) : 11;
  }

  // UI remains a screen-space 8x8 system. These exact pieces guarantee that
  // dialog borders, HUD and HP bars tile without seams beside 16px world cells.
  const setUiTile = (tile: number, fill: number, border: "none" | "top" | "bottom" | "left" | "right" | "tl" | "tr" | "bl" | "br") => {
    const ox = tile * 8;
    const oy = WORLD_TILE_SIZE;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) indices[(oy + y) * sheetWidth + ox + x] = fill;
    const edge = 14;
    if (border === "top" || border === "tl" || border === "tr") for (let x = 0; x < 8; x++) indices[oy * sheetWidth + ox + x] = edge;
    if (border === "bottom" || border === "bl" || border === "br") for (let x = 0; x < 8; x++) indices[(oy + 7) * sheetWidth + ox + x] = edge;
    if (border === "left" || border === "tl" || border === "bl") for (let y = 0; y < 8; y++) indices[(oy + y) * sheetWidth + ox] = edge;
    if (border === "right" || border === "tr" || border === "br") for (let y = 0; y < 8; y++) indices[(oy + y) * sheetWidth + ox + 7] = edge;
  };
  setUiTile(0, 13, "none");
  setUiTile(1, 13, "top");
  setUiTile(2, 13, "bottom");
  setUiTile(3, 13, "left");
  setUiTile(4, 13, "right");
  setUiTile(5, 13, "tl");
  setUiTile(6, 13, "tr");
  setUiTile(7, 13, "bl");
  setUiTile(8, 13, "br");
  setUiTile(9, 8, "none");
  setUiTile(10, 2, "none");
  setUiTile(11, 1, "none");
  setUiTile(12, 1, "none");
  setUiTile(13, 1, "none");
  const paintUi = (tile: number, x: number, y: number, color: number) => {
    const ox = tile * 8;
    const oy = WORLD_TILE_SIZE;
    indices[(oy + y) * sheetWidth + ox + x] = color;
  };
  for (let x = 0; x < 8; x++) {
    for (let y = 2; y <= 5; y++) {
      paintUi(11, x, y, y === 2 || y === 5 || x === 0 || x === 7 ? 6 : 7);
      paintUi(12, x, y, y === 2 || y === 5 || x === 0 || x === 7 ? 10 : 12);
    }
    paintUi(13, x, 7, 12);
  }

  const finalCanvas = createCanvas(sheetWidth, sheetHeight);
  const finalCtx = finalCanvas.getContext("2d");
  drawIndices(finalCtx, indices, sheetWidth, sheetHeight, BG, 0, 0, false);
  return { png: finalCanvas.toBuffer("image/png"), pixels: indices };
}

async function normalizeSprite(
  path: string,
  palette: Palette,
  size: number,
  maxWidth: number,
  maxHeight: number,
): Promise<Uint8Array> {
  if (!existsSync(path)) throw new Error(`missing source asset: ${path}; run vapor:rpg:assets:generate`);
  const image = await loadImage(path);
  const source = createCanvas(image.width, image.height);
  const sourceCtx = source.getContext("2d");
  sourceCtx.drawImage(image, 0, 0);
  const raw = sourceCtx.getImageData(0, 0, image.width, image.height) as ImageDataLike;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (raw.data[(y * image.width + x) * 4 + 3] >= 128) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) throw new Error(`${path} has no opaque actor pixels`);
  if (minX === 0 || minY === 0 || maxX === image.width - 1 || maxY === image.height - 1) {
    throw new Error(`${path} actor touches the source canvas edge; reject scene/background leakage`);
  }
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.floor((size - width) / 2);
  const y = size - height;
  const target = createCanvas(size, size);
  const ctx = target.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, minX, minY, sourceWidth, sourceHeight, x, y, width, height);
  return indicesFromContext(ctx, size, size, palette, true);
}

async function normalizeWalkDirection(direction: typeof WALK_DIRECTIONS[number]): Promise<Uint8Array[]> {
  const sources: Array<{
    image: Awaited<ReturnType<typeof loadImage>>;
    width: number;
    height: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }> = [];
  for (let frame = 0; frame < WALK_FRAME_COUNT; frame++) {
    const path = join(SOURCE, `hero-walk-${direction}-${frame}.png`);
    if (!existsSync(path)) throw new Error(`missing source asset: ${path}; run vapor:rpg:assets:generate --only=walk`);
    const image = await loadImage(path);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const raw = ctx.getImageData(0, 0, image.width, image.height) as ImageDataLike;
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (raw.data[(y * image.width + x) * 4 + 3] < 128) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY) throw new Error(`${path} has no opaque actor pixels`);
    if (minX === 0 || minY === 0 || maxX === image.width - 1 || maxY === image.height - 1) {
      throw new Error(`${path} actor touches the source canvas edge; reject scene/background leakage`);
    }
    sources.push({ image, width: image.width, height: image.height, minX, minY, maxX, maxY });
  }
  const sourceWidth = sources[0].width;
  const sourceHeight = sources[0].height;
  if (sources.some((source) => source.width !== sourceWidth || source.height !== sourceHeight)) {
    throw new Error(`hero walk ${direction} source canvases must have identical dimensions`);
  }

  // One horizontal crop and one scale per direction keep the torso anchored
  // while limbs alternate. Each frame's lowest contacting foot is then placed
  // on y=31, so generated canvas drift never becomes world-space vibration.
  const minX = Math.min(...sources.map((source) => source.minX));
  const maxX = Math.max(...sources.map((source) => source.maxX));
  const cropWidth = maxX - minX + 1;
  const maxHeight = Math.max(...sources.map((source) => source.maxY - source.minY + 1));
  const scale = Math.min(28 / cropWidth, 30 / maxHeight);
  const width = Math.max(1, Math.round(cropWidth * scale));
  const x = Math.floor((WORLD_ACTOR_SIZE - width) / 2);
  return sources.map((source) => {
    const cropHeight = source.maxY - source.minY + 1;
    const height = Math.max(1, Math.round(cropHeight * scale));
    const y = WORLD_ACTOR_SIZE - height;
    const target = createCanvas(WORLD_ACTOR_SIZE, WORLD_ACTOR_SIZE);
    const ctx = target.getContext("2d");
    ctx.clearRect(0, 0, WORLD_ACTOR_SIZE, WORLD_ACTOR_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source.image, minX, source.minY, cropWidth, cropHeight, x, y, width, height);
    return indicesFromContext(ctx, WORLD_ACTOR_SIZE, WORLD_ACTOR_SIZE, HERO, true);
  });
}

function polishSlime(slime: Uint8Array, size: number): void {
  const dark = 2;
  const mid = 3;
  const bright = 4;
  const pale = 5;
  const eye = 6;
  for (let i = 0; i < slime.length; i++) {
    if (slime[i] === eye) slime[i] = bright;
  }
  let slimeMinX = size;
  let slimeMinY = size;
  let slimeMaxX = -1;
  let slimeMaxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (slime[y * size + x] !== 0) {
        slimeMinX = Math.min(slimeMinX, x);
        slimeMinY = Math.min(slimeMinY, y);
        slimeMaxX = Math.max(slimeMaxX, x);
        slimeMaxY = Math.max(slimeMaxY, y);
      }
    }
  }
  const slimeWidth = slimeMaxX - slimeMinX + 1;
  const slimeHeight = slimeMaxY - slimeMinY + 1;
  const eyeY = slimeMinY + Math.max(1, Math.floor(slimeHeight * 0.36));
  const leftEye = eyeY * size + slimeMinX + Math.floor(slimeWidth * 0.34);
  const rightEye = eyeY * size + slimeMinX + Math.floor(slimeWidth * 0.66);
  const tealRows: number[] = [];
  for (let y = 0; y < size; y++) {
    if (slime.slice(y * size, y * size + size).some((pixel) => pixel >= dark && pixel <= pale)) tealRows.push(y);
  }
  const shadeFrom = tealRows.length > 0
    ? Math.floor((tealRows[0] + tealRows[tealRows.length - 1] + 1) / 2)
    : size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      if (y < shadeFrom && slime[at] === dark) slime[at] = mid;
      if (y >= shadeFrom && slime[at] >= bright && slime[at] <= pale) slime[at] = mid;
    }
  }
  const body = [...slime.keys()].filter((at) => slime[at] >= dark && slime[at] <= pale);
  if (body.length > 3) {
    slime[body[0]] = bright;
    slime[body[Math.floor(body.length / 4)]] = pale;
    slime[body[body.length - 1]] = dark;
  }
  slime[leftEye] = eye;
  slime[rightEye] = eye;
}

async function buildActors(): Promise<{
  png: Buffer;
  pixels: Uint8Array[];
  walkPng: Buffer;
  walkPixels: Uint8Array[];
  battlePng: Buffer;
  battlePixels: Uint8Array[];
}> {
  const specs = [
    ["hero-south.png", HERO, "person"],
    ["hero-north.png", HERO, "person"],
    ["hero-west.png", HERO, "person"],
    ["hero-east.png", HERO, "person"],
    ["elder.png", ELDER, "person"],
    ["slime.png", SLIME, "slime"],
  ] as const;
  const pixels: Uint8Array[] = [];
  for (const [file, palette, kind] of specs) {
    pixels.push(await normalizeSprite(
      join(SOURCE, file), palette, WORLD_ACTOR_SIZE,
      kind === "slime" ? 28 : 20,
      kind === "slime" ? 21 : 30,
    ));
  }
  // Reassert the reviewed eyes and top-left/lower-right teal shading so the
  // generated puddle-ooze silhouette survives RGB555 quantization and the
  // dimmer original GBA LCD without changing its PixelLab-authored outline.
  const slime = pixels[5];
  polishSlime(slime, WORLD_ACTOR_SIZE);
  const canvas = createCanvas(ACTOR_NAMES.length * WORLD_ACTOR_SIZE, WORLD_ACTOR_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.length; i++) {
    const palette = i < 4 ? HERO : i === 4 ? ELDER : SLIME;
    drawIndices(ctx, pixels[i], WORLD_ACTOR_SIZE, WORLD_ACTOR_SIZE, palette, i * WORLD_ACTOR_SIZE, 0, true);
  }
  const walkPixels: Uint8Array[] = [];
  for (const direction of WALK_DIRECTIONS) {
    walkPixels.push(...await normalizeWalkDirection(direction));
  }
  const walkCanvas = createCanvas(WALK_FRAME_COUNT * WORLD_ACTOR_SIZE, WALK_DIRECTIONS.length * WORLD_ACTOR_SIZE);
  const walkCtx = walkCanvas.getContext("2d");
  walkCtx.clearRect(0, 0, walkCanvas.width, walkCanvas.height);
  for (let direction = 0; direction < WALK_DIRECTIONS.length; direction++) {
    for (let frame = 0; frame < WALK_FRAME_COUNT; frame++) {
      drawIndices(
        walkCtx,
        walkPixels[direction * WALK_FRAME_COUNT + frame],
        WORLD_ACTOR_SIZE,
        WORLD_ACTOR_SIZE,
        HERO,
        frame * WORLD_ACTOR_SIZE,
        direction * WORLD_ACTOR_SIZE,
        true,
      );
    }
  }
  const battlePixels = [
    await normalizeSprite(join(SOURCE, "hero-east.png"), HERO, BATTLE_ACTOR_SIZE, 48, 60),
    await normalizeSprite(join(SOURCE, "slime.png"), SLIME, BATTLE_ACTOR_SIZE, 54, 44),
  ];
  polishSlime(battlePixels[1], BATTLE_ACTOR_SIZE);
  const battleCanvas = createCanvas(2 * BATTLE_ACTOR_SIZE, BATTLE_ACTOR_SIZE);
  const battleCtx = battleCanvas.getContext("2d");
  battleCtx.clearRect(0, 0, battleCanvas.width, battleCanvas.height);
  drawIndices(battleCtx, battlePixels[0], BATTLE_ACTOR_SIZE, BATTLE_ACTOR_SIZE, HERO, 0, 0, true);
  drawIndices(battleCtx, battlePixels[1], BATTLE_ACTOR_SIZE, BATTLE_ACTOR_SIZE, SLIME, BATTLE_ACTOR_SIZE, 0, true);
  return {
    png: canvas.toBuffer("image/png"),
    pixels,
    walkPng: walkCanvas.toBuffer("image/png"),
    walkPixels,
    battlePng: battleCanvas.toBuffer("image/png"),
    battlePixels,
  };
}

function bgr555([r, g, b]: Rgb): number {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

function packTile(pixels: Uint8Array, stride: number, ox: number, oy: number): number[] {
  const words: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x += 4) {
      words.push(
        pixels[(oy + y) * stride + ox + x]
        | (pixels[(oy + y) * stride + ox + x + 1] << 4)
        | (pixels[(oy + y) * stride + ox + x + 2] << 8)
        | (pixels[(oy + y) * stride + ox + x + 3] << 12),
      );
    }
  }
  return words;
}

function wordsForBackground(pixels: Uint8Array): number[] {
  const words: number[] = [];
  const stride = WORLD_TILE_COLUMNS * WORLD_TILE_SIZE;
  for (let frame = 0; frame < WORLD_TILE_NAMES.length; frame++) {
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        words.push(...packTile(pixels, stride, frame * WORLD_TILE_SIZE + tx * 8, ty * 8));
      }
    }
  }
  for (let tile = 0; tile < UI_TILE_NAMES.length; tile++) {
    words.push(...packTile(pixels, stride, tile * 8, WORLD_TILE_SIZE));
  }
  return words;
}

function wordsForActors(actors: Uint8Array[], walkActors: Uint8Array[], battleActors: Uint8Array[]): number[] {
  const words: number[] = [];
  for (const pixels of [...actors, ...walkActors]) {
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) words.push(...packTile(pixels, WORLD_ACTOR_SIZE, tx * 8, ty * 8));
  }
  for (const pixels of battleActors) {
    for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) words.push(...packTile(pixels, BATTLE_ACTOR_SIZE, tx * 8, ty * 8));
  }
  return words;
}

function formatWords(name: string, words: readonly number[], columns = 8): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += columns) {
    lines.push(`  ${words.slice(i, i + columns).map((word) => `0x${word.toString(16).padStart(4, "0")}`).join(", ")},`);
  }
  return `static const u16 ${name}[${words.length}] = {\n${lines.join("\n")}\n};`;
}

function generatedHeader(
  bgPixels: Uint8Array,
  actorPixels: Uint8Array[],
  walkPixels: Uint8Array[],
  battlePixels: Uint8Array[],
): string {
  const paddedPalette = (palette: Palette): number[] => [
    ...palette.map(bgr555),
    ...Array(Math.max(0, 16 - palette.length)).fill(0),
  ];
  const palettes = [paddedPalette(HERO), paddedPalette(ELDER), paddedPalette(SLIME)].flat();
  return [
    "/* Generated by vapor/scripts/rpg-assets.ts. Do not edit by hand. */",
    "#ifndef VP_RPG_ASSETS_GENERATED_H",
    "#define VP_RPG_ASSETS_GENERATED_H",
    "",
    `#define VP_RPG_WORLD_TILE_FRAME_COUNT ${WORLD_TILE_NAMES.length}`,
    "#define VP_RPG_WORLD_TILE_FRAME_TILES 4",
    `#define VP_RPG_UI_TILE_COUNT ${UI_TILE_NAMES.length}`,
    "#define VP_RPG_UI_TILE_BASE (VP_RPG_WORLD_TILE_FRAME_COUNT * VP_RPG_WORLD_TILE_FRAME_TILES)",
    "#define VP_RPG_BG_TILE_COUNT (VP_RPG_UI_TILE_BASE + VP_RPG_UI_TILE_COUNT)",
    "#define VP_RPG_WORLD_ACTOR_FRAME_TILES 16",
    `#define VP_RPG_WORLD_STATIC_ACTOR_FRAME_COUNT ${ACTOR_NAMES.length}`,
    `#define VP_RPG_WORLD_WALK_DIRECTION_COUNT ${WALK_DIRECTIONS.length}`,
    `#define VP_RPG_WORLD_WALK_FRAMES ${WALK_FRAME_COUNT}`,
    "#define VP_RPG_WORLD_WALK_TILE_BASE (VP_RPG_WORLD_STATIC_ACTOR_FRAME_COUNT * VP_RPG_WORLD_ACTOR_FRAME_TILES)",
    "#define VP_RPG_WORLD_ACTOR_FRAME_COUNT (VP_RPG_WORLD_STATIC_ACTOR_FRAME_COUNT + VP_RPG_WORLD_WALK_DIRECTION_COUNT * VP_RPG_WORLD_WALK_FRAMES)",
    "#define VP_RPG_WORLD_ELDER_TILE (4 * VP_RPG_WORLD_ACTOR_FRAME_TILES)",
    "#define VP_RPG_WORLD_SLIME_TILE (5 * VP_RPG_WORLD_ACTOR_FRAME_TILES)",
    "#define VP_RPG_BATTLE_HERO_TILE (VP_RPG_WORLD_ACTOR_FRAME_COUNT * VP_RPG_WORLD_ACTOR_FRAME_TILES)",
    "#define VP_RPG_BATTLE_SLIME_TILE (VP_RPG_BATTLE_HERO_TILE + 64)",
    "#define VP_RPG_OBJ_TILE_COUNT (VP_RPG_BATTLE_SLIME_TILE + 64)",
    "",
    formatWords("vp_rpg_bg_palette", paddedPalette(BG)),
    "",
    formatWords("vp_rpg_obj_palettes", palettes),
    "",
    formatWords("vp_rpg_bg_tiles", wordsForBackground(bgPixels)),
    "",
    formatWords("vp_rpg_obj_tiles", wordsForActors(actorPixels, walkPixels, battlePixels)),
    "",
    "#endif",
    "",
  ].join("\n");
}

function assertAssetSemantics(
  bg: Uint8Array,
  actors: Uint8Array[],
  walkActors: Uint8Array[],
  battleActors: Uint8Array[],
): void {
  const bounds = (frame: Uint8Array, size: number): { width: number; height: number } => {
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (frame[y * size + x] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  };
  const connectedComponents = (frame: Uint8Array, size: number): number => {
    const visited = new Uint8Array(frame.length);
    let components = 0;
    for (let start = 0; start < frame.length; start++) {
      if (frame[start] === 0 || visited[start]) continue;
      components++;
      const stack = [start];
      visited[start] = 1;
      while (stack.length > 0) {
        const at = stack.pop()!;
        const x = at % size;
        const y = Math.floor(at / size);
        for (const next of [x > 0 ? at - 1 : -1, x + 1 < size ? at + 1 : -1, y > 0 ? at - size : -1, y + 1 < size ? at + size : -1]) {
          if (next >= 0 && frame[next] !== 0 && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    return components;
  };
  const bottomContactSpans = (frame: Uint8Array, size: number): number => {
    let spans = 0;
    let opaque = false;
    for (let x = 0; x < size; x++) {
      const next = frame[(size - 1) * size + x] !== 0;
      if (next && !opaque) spans++;
      opaque = next;
    }
    return spans;
  };
  if (bg.length !== WORLD_TILE_COLUMNS * WORLD_TILE_SIZE * (WORLD_TILE_SIZE + 8)) {
    throw new Error("background preview must contain ten 16x16 world frames and fourteen 8x8 UI tiles");
  }
  if (actors.length !== 6 || actors.some((frame) => frame.length !== WORLD_ACTOR_SIZE ** 2)) {
    throw new Error("actor sheet must contain six 32x32 frames");
  }
  for (const [index, frame] of actors.entries()) {
    const visible = frame.filter((pixel) => pixel !== 0).length;
    if (visible < (index === 5 ? 220 : 280)) throw new Error(`${ACTOR_NAMES[index]} silhouette is too sparse (${visible} pixels)`);
    if (!frame.slice(31 * WORLD_ACTOR_SIZE).some((pixel) => pixel !== 0)) throw new Error(`${ACTOR_NAMES[index]} does not touch the shared y=31 foot line`);
    const box = bounds(frame, WORLD_ACTOR_SIZE);
    if (box.width < (index === 5 ? 22 : 18) || box.height < (index === 5 ? 14 : 26)) {
      throw new Error(`${ACTOR_NAMES[index]} bbox is too small (${box.width}x${box.height})`);
    }
    const max = index < 4 ? HERO.length - 1 : index === 4 ? ELDER.length - 1 : SLIME.length - 1;
    if (frame.some((pixel) => pixel > max)) throw new Error(`${ACTOR_NAMES[index]} exceeds its OBJ palette`);
    if (connectedComponents(frame, WORLD_ACTOR_SIZE) !== 1) throw new Error(`${ACTOR_NAMES[index]} must be one connected silhouette`);
    if (index === 5 && (box.width < box.height || bottomContactSpans(frame, WORLD_ACTOR_SIZE) < 2)) {
      throw new Error("slime must remain a wide puddle ooze with at least two grounded pseudopod contacts");
    }
  }
  const heroHashes = actors.slice(0, 4).map((pixels) => sha256(pixels));
  if (new Set(heroHashes).size !== 4) throw new Error("hero directions must be visually distinct");
  const heroHeights = actors.slice(0, 4).map((frame) => bounds(frame, WORLD_ACTOR_SIZE).height);
  if (Math.max(...heroHeights) - Math.min(...heroHeights) > 2) throw new Error("hero direction heights drift by more than two pixels");
  const slimeTeals = new Set(actors[5].filter((pixel) => pixel >= 2 && pixel <= 5));
  if (slimeTeals.size < 3) throw new Error("slime must retain at least three teal shades");
  if (actors[5].filter((pixel) => pixel === 6).length !== 2) throw new Error("slime must have exactly two white eye pixels");
  if (walkActors.length !== WALK_DIRECTIONS.length * WALK_FRAME_COUNT ||
      walkActors.some((frame) => frame.length !== WORLD_ACTOR_SIZE ** 2)) {
    throw new Error("hero walk sheet must contain four frames for each of four directions");
  }
  for (let direction = 0; direction < WALK_DIRECTIONS.length; direction++) {
    const sequence = walkActors.slice(direction * WALK_FRAME_COUNT, (direction + 1) * WALK_FRAME_COUNT);
    const hashes = new Set<string>();
    const heights: number[] = [];
    const centers: number[] = [];
    for (const [frameIndex, frame] of sequence.entries()) {
      const visible = frame.filter((pixel) => pixel !== 0).length;
      if (visible < 260) throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frame ${frameIndex} is too sparse (${visible} pixels)`);
      if (!frame.slice(31 * WORLD_ACTOR_SIZE).some((pixel) => pixel !== 0)) {
        throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frame ${frameIndex} does not touch y=31`);
      }
      const box = bounds(frame, WORLD_ACTOR_SIZE);
      if (box.width < 16 || box.height < 26) {
        throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frame ${frameIndex} bbox is too small (${box.width}x${box.height})`);
      }
      if (frame.some((pixel) => pixel >= HERO.length)) {
        throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frame ${frameIndex} exceeds the hero OBJ palette`);
      }
      if (connectedComponents(frame, WORLD_ACTOR_SIZE) !== 1) {
        throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frame ${frameIndex} must be one connected silhouette`);
      }
      let weightedX = 0;
      for (let at = 0; at < frame.length; at++) if (frame[at] !== 0) weightedX += at % WORLD_ACTOR_SIZE;
      centers.push(weightedX / visible);
      heights.push(box.height);
      hashes.add(sha256(frame));
    }
    if (hashes.size !== WALK_FRAME_COUNT) throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} frames must be distinct`);
    if (Math.max(...heights) - Math.min(...heights) > 3) {
      throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} height drifts by more than three pixels`);
    }
    if (Math.max(...centers) - Math.min(...centers) > 3) {
      throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} horizontal center drifts by more than three pixels`);
    }
    for (let frame = 0; frame < WALK_FRAME_COUNT; frame++) {
      const next = (frame + 1) % WALK_FRAME_COUNT;
      let changed = 0;
      for (let at = 0; at < sequence[frame].length; at++) {
        if (sequence[frame][at] !== sequence[next][at]) changed++;
      }
      if (changed < 40 || changed > 520) {
        throw new Error(`hero walk ${WALK_DIRECTIONS[direction]} transition ${frame}->${next} changes ${changed} pixels`);
      }
    }
  }
  if (battleActors.length !== 2 || battleActors.some((frame) => frame.length !== BATTLE_ACTOR_SIZE ** 2)) {
    throw new Error("battle actor sheet must contain two 64x64 frames");
  }
  for (const [index, frame] of battleActors.entries()) {
    if (frame.filter((pixel) => pixel !== 0).length < (index === 0 ? 1000 : 900)) throw new Error(`battle actor ${index} silhouette is too sparse`);
    if (!frame.slice(63 * BATTLE_ACTOR_SIZE).some((pixel) => pixel !== 0)) throw new Error(`battle actor ${index} does not touch y=63`);
    const box = bounds(frame, BATTLE_ACTOR_SIZE);
    if (box.width < (index === 0 ? 38 : 44) || box.height < (index === 0 ? 52 : 30)) {
      throw new Error(`battle actor ${index} bbox is too small (${box.width}x${box.height})`);
    }
    const max = index === 0 ? HERO.length - 1 : SLIME.length - 1;
    if (frame.some((pixel) => pixel > max)) throw new Error(`battle actor ${index} exceeds its OBJ palette`);
    if (connectedComponents(frame, BATTLE_ACTOR_SIZE) !== 1) throw new Error(`battle actor ${index} must be one connected silhouette`);
    if (index === 1 && box.width < box.height) throw new Error("battle slime must remain wider than it is tall");
  }
}

async function build(check: boolean): Promise<void> {
  ensureDirs();
  const background = await buildBackground();
  const actors = await buildActors();
  assertAssetSemantics(background.pixels, actors.pixels, actors.walkPixels, actors.battlePixels);
  const header = generatedHeader(background.pixels, actors.pixels, actors.walkPixels, actors.battlePixels);
  const targets: Array<[string, Buffer | string]> = [
    [join(FINAL, "background.png"), background.png],
    [join(FINAL, "actors.png"), actors.png],
    [join(FINAL, "hero-walk.png"), actors.walkPng],
    [join(FINAL, "battle-actors.png"), actors.battlePng],
    [join(FINAL, "palette-guide.png"), paletteGuidePng()],
    [HEADER, header],
  ];
  if (check) {
    for (const [path, expected] of targets) {
      if (!existsSync(path)) throw new Error(`generated asset missing: ${path}`);
      const actual = readFileSync(path);
      const bytes = typeof expected === "string" ? Buffer.from(expected) : expected;
      if (!actual.equals(bytes)) throw new Error(`generated asset is stale: ${path}`);
    }
    console.log(`RPG assets OK: 54 BG tiles, ${ACTOR_NAMES.length} static + ${actors.walkPixels.length} walking 32x32 world actors + 2 64x64 battle actors, four fixed 4bpp palettes`);
    return;
  }
  for (const [path, contents] of targets) writeFileSync(path, contents);
  console.log(`Built ${join(FINAL, "background.png")}`);
  console.log(`Built ${join(FINAL, "actors.png")}`);
  console.log(`Built ${join(FINAL, "hero-walk.png")}`);
  console.log(`Built ${join(FINAL, "battle-actors.png")}`);
  console.log(`Built ${HEADER}`);
}

if (import.meta.main) {
  const command = process.argv[2] ?? "check";
  if (command === "generate") await generate(process.argv.includes("--force"));
  else if (command === "build") await build(false);
  else if (command === "check") await build(true);
  else throw new Error(`usage: bun vapor/scripts/rpg-assets.ts <generate|build|check> [--force]`);
}
