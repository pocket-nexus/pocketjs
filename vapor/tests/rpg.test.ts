// Pocket Vapor RPG POC: compiler contract + a complete native GBA play tape.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp, type CompiledApp, VaporCompileError } from "../compiler/compile.ts";
import { buildGbaRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";
import { defineRpgMap, rpgBlocked, rpgEventAt } from "../host/rpg.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "rpg", "rpg.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const ROM = join(OUT, "rpg.gba");
const RUNNER = join(HERE, "harness", "mgba_runner");
const ASSET_HEADER = join(HERE, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");
const DEBUG_STATE = 0x02000010;

let source = "";
let app: CompiledApp;
let runReads: Record<string, string | number>;
let holdReads: Record<string, string | number>;
let cameraReads: Record<string, string | number>;
let motionReads: Record<string, string | number>;
let motionReplayReads: Record<string, string | number>;
let cameraMotionReads: Record<string, string | number>;

function press(button: number): string {
  // A cardinal step needs one acceptance tick plus eight 2px motion ticks.
  // The release tail also absorbs libmGBA's one-frame key-sampling boundary.
  return `P ${(1 << button).toString(16)} 2 10`;
}

function stateAddress(name: string): number {
  const slot = app.debugSlots.find((candidate) => candidate.name === name);
  if (!slot) throw new Error(`missing debug slot ${name}`);
  return DEBUG_STATE + slot.offset;
}

function readState(lines: string[], label: string, names: readonly string[]): void {
  for (const name of names) {
    lines.push(`R ${label}_${name} 0x${stateAddress(name).toString(16)} 4`);
  }
}

function value(label: string, name: string): number {
  return runReads[`${label}_${name}`] as number;
}

function generatedWords(name: string): number[] {
  const header = readFileSync(ASSET_HEADER, "utf8");
  const match = header.match(new RegExp(`static const u16 ${name}\\[\\d+\\] = \\{([\\s\\S]*?)\\n\\};`));
  if (!match) throw new Error(`missing generated asset array ${name}`);
  return [...match[1].matchAll(/0x([0-9a-f]{4})/g)].map((word) => Number.parseInt(word[1], 16));
}

function littleEndianHex(words: number[]): string {
  return words.map((word) => `${(word & 0xff).toString(16).padStart(2, "0")}${(word >> 8).toString(16).padStart(2, "0")}`).join("");
}

function littleEndianU16(hex: string, byteOffset: number): number {
  const at = byteOffset * 2;
  return Number.parseInt(`${hex.slice(at + 2, at + 4)}${hex.slice(at, at + 2)}`, 16);
}

function signed32(value: number): number {
  return value > 0x7fffffff ? value - 0x1_0000_0000 : value;
}

function hexAscii(hex: string): string {
  let out = "";
  for (let at = 0; at < hex.length; at += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2), 16));
  }
  return out;
}

interface MotionSample {
  frame: number;
  x: number;
  walk: number;
  oam: string;
  scroll?: number;
  video?: number;
}

function semanticMotion(reads: Record<string, string | number>): MotionSample[] {
  const samples: MotionSample[] = [];
  let lastFrame = -1;
  for (let tick = 0; tick < 20; tick++) {
    const frame = reads[`t${tick}_frame`] as number;
    if (frame === lastFrame) continue;
    lastFrame = frame;
    const sample: MotionSample = {
      frame,
      x: reads[`t${tick}_x`] as number,
      walk: signed32(reads[`t${tick}_walk`] as number),
      oam: reads[`t${tick}_oam`] as string,
    };
    const scroll = reads[`t${tick}_scroll`];
    if (typeof scroll === "number") sample.scroll = scroll;
    const video = reads[`t${tick}_video`];
    if (typeof video === "number") sample.video = video;
    samples.push(sample);
  }
  return samples;
}

async function countPpmColors(path: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const head = new TextDecoder().decode(bytes.slice(0, 64));
  const match = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!match) throw new Error(`not a P6 screenshot: ${path}`);
  const offset = match[0].length;
  const colors = new Set<string>();
  for (let i = offset; i + 2 < bytes.length; i += 3) {
    colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
  }
  return colors.size;
}

beforeAll(async () => {
  source = await Bun.file(ENTRY).text();
  app = compileVaporApp(ENTRY, source, "VAPOR QUEST", "gba");
  await buildGbaRom(app, ROM);
  if (!existsSync(RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();

  const state = [
    "mode",
    "playerX",
    "playerY",
    "facing",
    "quest",
    "dialog",
    "choice",
    "heroHp",
    "enemyHp",
    "battleCursor",
    "walkPx",
  ] as const;
  const worldShot = join(OUT, "rpg-world.ppm");
  const dialogShot = join(OUT, "rpg-dialog.ppm");
  const battleShot = join(OUT, "rpg-battle.ppm");
  const lines: string[] = ["A 8"];

  readState(lines, "boot", state);
  lines.push(`S ${worldShot}`);
  lines.push("D world_bg1 0x06004800 2048");
  lines.push("D world_oam 0x07000000 24");
  lines.push("R world_dispcnt 0x04000000 2");
  lines.push("D asset_bg_tiles 0x06008000 1728");
  lines.push("D asset_obj_tiles 0x06010000 15360");
  lines.push("D asset_bg_palette 0x050001e0 32");
  lines.push("D asset_obj_palettes 0x05000200 96");

  // Walk into the north wall, then restore the spawn row.
  lines.push(press(Button.Up), press(Button.Up));
  readState(lines, "wall", ["playerX", "playerY", "facing"]);
  lines.push(press(Button.Down));

  // Stand west of the elder. Right is blocked by N but still turns the hero;
  // A then talks to the facing cell.
  lines.push(press(Button.Right), press(Button.Down), press(Button.Right), press(Button.A));
  readState(lines, "offer", ["mode", "playerX", "playerY", "facing", "quest", "dialog", "choice"]);
  lines.push(`S ${dialogShot}`);
  lines.push("R dialog_dispcnt 0x04000000 2");

  // Exercise NO with a long hold: repeats are world-only, so the two-choice
  // dialog must not toggle back and forth. Close, talk again, then accept YES.
  lines.push(`P ${(1 << Button.Down).toString(16)} 20 4`);
  readState(lines, "offerHeld", ["choice"]);
  lines.push(press(Button.A));
  readState(lines, "declined", ["mode", "quest", "dialog", "choice"]);
  lines.push(press(Button.A), press(Button.A), press(Button.A));
  readState(lines, "accepted", ["mode", "quest", "dialog", "choice"]);
  lines.push(press(Button.A));

  // Return to y=2 and approach S at (8,2). The final step is sampled in
  // flight: integer occupancy and its battle event must stay at x=7/world
  // until the full 16px transition arrives.
  lines.push(press(Button.Up));
  for (let i = 0; i < 4; i++) lines.push(press(Button.Right));
  readState(lines, "slimeBefore", ["mode", "playerX", "playerY", "walkPx"]);
  lines.push(`P ${(1 << Button.Right).toString(16)} 5 0`);
  readState(lines, "slimeMid", ["mode", "playerX", "playerY", "walkPx"]);
  lines.push("A 10");
  readState(lines, "battle", ["mode", "playerX", "playerY", "quest", "heroHp", "enemyHp", "battleCursor"]);
  lines.push(`S ${battleShot}`);
  lines.push("D battle_bg1 0x06004800 2048");
  lines.push("D battle_oam 0x07000000 24");
  lines.push("R battle_dispcnt 0x04000000 2");

  // HEAL once after another long hold; battle selection also ignores repeats.
  // Then ATTACK three times. Victory is a reactive dialog state.
  lines.push(`P ${(1 << Button.Down).toString(16)} 25 4`, press(Button.A));
  readState(lines, "healed", ["mode", "heroHp", "enemyHp", "battleCursor"]);
  lines.push(press(Button.Up), press(Button.A), press(Button.A), press(Button.A));
  readState(lines, "won", ["mode", "quest", "dialog", "heroHp", "enemyHp"]);
  lines.push(press(Button.A));

  // Return to the elder, turn into the solid NPC, report, and close.
  for (let i = 0; i < 5; i++) lines.push(press(Button.Left));
  lines.push(press(Button.Down), press(Button.Right), press(Button.A));
  readState(lines, "completeDialog", ["mode", "playerX", "playerY", "facing", "quest", "dialog"]);
  lines.push(press(Button.A));
  readState(lines, "complete", ["mode", "quest", "dialog"]);
  lines.push("R trips 0x0200000c 1");

  const scenario = join(OUT, "rpg-play-tape.txt");
  await Bun.write(scenario, `${lines.join("\n")}\n`);
  const output = await $`${RUNNER} ${ROM} ${scenario}`.text();
  const parsed = JSON.parse(output) as { ok: boolean; reads: Record<string, string | number> };
  expect(parsed.ok).toBe(true);
  runReads = parsed.reads;

  // Held movement is sampled every semantic frame. Release in mid-step must
  // finish that accepted cell and then settle at idle rather than freezing
  // on a sub-cell offset.
  const holdScenario = join(OUT, "rpg-hold-tape.txt");
  await Bun.write(
    holdScenario,
    [
      "A 8",
      `P ${(1 << Button.Right).toString(16)} 22 0`,
      `R held_x 0x${stateAddress("playerX").toString(16)} 4`,
      `R held_y 0x${stateAddress("playerY").toString(16)} 4`,
      `R held_facing 0x${stateAddress("facing").toString(16)} 4`,
      `R held_walk 0x${stateAddress("walkPx").toString(16)} 4`,
      "A 16",
      `R released_x 0x${stateAddress("playerX").toString(16)} 4`,
      `R released_walk 0x${stateAddress("walkPx").toString(16)} 4`,
      "R hold_trips 0x0200000c 1",
      "",
    ].join("\n"),
  );
  const holdOutput = await $`${RUNNER} ${ROM} ${holdScenario}`.text();
  const holdParsed = JSON.parse(holdOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(holdParsed.ok).toBe(true);
  holdReads = holdParsed.reads;

  // Drop below the solid Slime, then walk far enough east to put the hero on
  // the camera focus column. The logical map state remains global while BG1
  // and OAM become a 15x10 window.
  const cameraScenario = join(OUT, "rpg-camera-tape.txt");
  const cameraLines = ["A 8", press(Button.Down), press(Button.Down)];
  for (let i = 0; i < 12; i++) cameraLines.push(press(Button.Right));
  cameraLines.push(
    `R player_x 0x${stateAddress("playerX").toString(16)} 4`,
    "D bg1 0x06004800 2048",
    "D oam 0x07000000 16",
    "R trips 0x0200000c 1",
    "",
  );
  await Bun.write(cameraScenario, cameraLines.join("\n"));
  const cameraOutput = await $`${RUNNER} ${ROM} ${cameraScenario}`.text();
  const cameraParsed = JSON.parse(cameraOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(cameraParsed.ok).toBe(true);
  cameraReads = cameraParsed.reads;

  // Sample one continuous hold after every libmGBA video frame. DBG_FRAME
  // lets assertions discard only the initial host key-sampling duplicate;
  // every semantic tick then has matching reactive state and committed OAM.
  const motionScenario = join(OUT, "rpg-motion-tape.txt");
  const motionShot = join(OUT, "rpg-motion.ppm");
  const motionLines = ["A 8"];
  for (let tick = 0; tick < 20; tick++) {
    motionLines.push(
      `P ${(1 << Button.Right).toString(16)} 1 0`,
      `R t${tick}_frame 0x02000004 4`,
      `R t${tick}_x 0x${stateAddress("playerX").toString(16)} 4`,
      `R t${tick}_walk 0x${stateAddress("walkPx").toString(16)} 4`,
      `D t${tick}_oam 0x07000000 16`,
      `H t${tick}_video`,
    );
    if (tick === 6) motionLines.push(`D t${tick}_hud 0x02000100 30`);
    if (tick === 6) motionLines.push(`S ${motionShot}`);
  }
  motionLines.push("R motion_trips 0x0200000c 1", "");
  await Bun.write(motionScenario, motionLines.join("\n"));
  const motionOutput = await $`${RUNNER} ${ROM} ${motionScenario}`.text();
  const motionParsed = JSON.parse(motionOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(motionParsed.ok).toBe(true);
  motionReads = motionParsed.reads;
  const motionReplayOutput = await $`${RUNNER} ${ROM} ${motionScenario}`.text();
  const motionReplayParsed = JSON.parse(motionReplayOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(motionReplayParsed.ok).toBe(true);
  motionReplayReads = motionReplayParsed.reads;

  // Put the hero on the camera focus at (8,4), then sample a full step. The
  // camera scroll should advance by the same 2px timeline while hero OAM stays
  // pinned at the focus pixel.
  const cameraMotionScenario = join(OUT, "rpg-camera-motion-tape.txt");
  const cameraMotionLines = ["A 8", press(Button.Down), press(Button.Down)];
  for (let i = 0; i < 6; i++) cameraMotionLines.push(press(Button.Right));
  for (let tick = 0; tick < 20; tick++) {
    cameraMotionLines.push(
      `P ${(1 << Button.Right).toString(16)} 1 0`,
      `R t${tick}_frame 0x02000004 4`,
      `R t${tick}_x 0x${stateAddress("playerX").toString(16)} 4`,
      `R t${tick}_walk 0x${stateAddress("walkPx").toString(16)} 4`,
      `R t${tick}_scroll 0x020005c0 2`,
      `D t${tick}_oam 0x07000000 16`,
      `H t${tick}_video`,
    );
  }
  cameraMotionLines.push("R camera_motion_trips 0x0200000c 1", "");
  await Bun.write(cameraMotionScenario, cameraMotionLines.join("\n"));
  const cameraMotionOutput = await $`${RUNNER} ${ROM} ${cameraMotionScenario}`.text();
  const cameraMotionParsed = JSON.parse(cameraMotionOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(cameraMotionParsed.ok).toBe(true);
  cameraMotionReads = cameraMotionParsed.reads;
}, 120000);

describe("Pocket Vapor RPG host", () => {
  test("JS host queries share the map's collision and event semantics", () => {
    const map = defineRpgMap({
      rows: ["###", "#N#", "###"],
      solid: "#N",
      events: { N: 7 },
      dialogs: [],
    });
    expect(rpgBlocked(map, 1, 1)).toBe(true);
    expect(rpgBlocked(map, -1, 1)).toBe(true);
    expect(rpgEventAt(map, 1, 1)).toBe(7);
    expect(rpgEventAt(map, 1, 0)).toBe(0);
    expect(() =>
      defineRpgMap({ rows: ["..."], solid: "#", events: { N: 1 }, dialogs: [] }),
    ).toThrow("does not appear");
  });

  test("compiler emits ROM assets, pure queries, and one reactive native effect", () => {
    const again = compileVaporApp(ENTRY, source, "VAPOR QUEST", "gba");
    expect(again.c).toBe(app.c);
    expect(app.rpgEnabled).toBe(true);
    expect(app.c).toContain("const u8 vp_rpg_enabled = 1");
    expect(app.c).toContain("vp_rpg_blocked(&RPG_RPG_MAP");
    expect(app.c).toContain("vp_rpg_event_at(&RPG_RPG_MAP");
    expect(app.c).toContain("vp_rpg_render(&RPG_RPG_MAP");
    const rpgEffect = [...app.c.matchAll(/static void eff_\d+\(void\) \{([\s\S]*?)\n\}/g)]
      .find((match) => match[1].includes("vp_rpg_render"));
    expect(rpgEffect).toBeDefined();
    expect(rpgEffect![1]).not.toContain("vp_row_clear");
    expect(app.c).toContain("SLIME BLOCKS EAST ROAD.");
    expect(app.graph).toContain("mode (num)");
    expect(app.graph).toContain("questActive:");
    expect(app.graph).toContain("walkPx (num)");
    expect(app.graph).toContain("frame hook: fixed (gba)");
    expect(app.c).toContain("void app_on_frame(u32 buttons)");
    expect(app.plan).toContain("RPG host RAM: 3136 B");
    expect(app.plan).toContain("6 static and 16 walking 32x32 world frames");
    expect(app.plan).toContain("17216 B ROM");
  });

  test("pixel RPG host is explicitly GBA-only", () => {
    expect(() => compileVaporApp(ENTRY, source, "VAPOR QUEST", "gb")).toThrow(VaporCompileError);
    expect(() => compileVaporApp(ENTRY, source, "VAPOR QUEST", "gb")).toThrow(/GBA/i);
  });

  test("compiler rejects malformed map assets and an incomplete screen contract", () => {
    const ragged = source.replace(
      '"##############################",',
      '"#############################",',
    );
    expect(() => compileVaporApp(ENTRY, ragged, "VAPOR QUEST", "gba")).toThrow(/equal width/);

    const missingEventTile = source.replace("N: Event.Elder,", "Z: Event.Elder,");
    expect(() => compileVaporApp(ENTRY, missingEventTile, "VAPOR QUEST", "gba")).toThrow(
      /does not occur/,
    );

    const missingProp = source.replace("        battleCursor={battleCursor.value}\n", "");
    expect(() => compileVaporApp(ENTRY, missingProp, "VAPOR QUEST", "gba")).toThrow(
      /missing required prop "battleCursor"/,
    );

    const siblingRow = source.replace(
      "      <RpgScreen",
      '      <row y={19}>{"not native UI"}</row>\n      <RpgScreen',
    );
    expect(() => compileVaporApp(ENTRY, siblingRow, "VAPOR QUEST", "gba")).toThrow(
      /must be the only root render unit/,
    );
  });
});

describe("native GBA RPG play tape", () => {
  test("reactive walking advances 2px per semantic frame and cycles native walk tiles", async () => {
    const step = semanticMotion(motionReads).filter((sample) => sample.walk >= 0).slice(0, 9);
    expect(step.map((sample) => sample.walk)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 0]);
    expect(step.map((sample) => sample.x)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 3]);
    expect(step.map((sample) => littleEndianU16(sample.oam, 10) & 0x01ff)).toEqual([
      24, 26, 28, 30, 32, 34, 36, 38, 40,
    ]);
    expect(step.map((sample) => littleEndianU16(sample.oam, 12) & 0x03ff)).toEqual([
      288, 288, 304, 304, 320, 320, 336, 336, 288,
    ]);
    expect(motionReads.motion_trips).toBe(0);
    expect(motionReplayReads).toEqual(motionReads);
    expect(hexAscii(motionReads.t6_hud as string).trim()).toBe("QUEST: TALK TO THE ELDER");
    expect(await countPpmColors(join(OUT, "rpg-motion.ppm"))).toBeGreaterThanOrEqual(8);
  });

  test("holding chains steps and release completes only the accepted step", () => {
    expect([holdReads.held_x, holdReads.held_y, holdReads.held_facing]).toEqual([4, 2, 3]);
    expect(signed32(holdReads.held_walk as number)).toBeGreaterThanOrEqual(0);
    expect(signed32(holdReads.held_walk as number)).toBeLessThan(16);
    expect(holdReads.released_x).toBe(5);
    expect(signed32(holdReads.released_walk as number)).toBe(-1);
    expect(holdReads.hold_trips).toBe(0);
  });

  test("the fractional camera follows the same timeline without moving hero focus", () => {
    const step = semanticMotion(cameraMotionReads).filter((sample) => sample.walk >= 0).slice(0, 9);
    expect(step.map((sample) => sample.walk)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 0]);
    expect(step.map((sample) => sample.scroll)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 0]);
    expect(step.map((sample) => littleEndianU16(sample.oam, 2) & 0x01ff)).toEqual(
      Array(9).fill(104),
    );
    const physicalFrames = semanticMotion(cameraMotionReads).filter((sample) => sample.walk >= 0);
    for (let at = 1; at < physicalFrames.length; at++) {
      expect(physicalFrames[at].video).not.toBe(physicalFrames[at - 1].video);
    }
    expect(cameraMotionReads.camera_motion_trips).toBe(0);
  });

  test("the 15x10 camera follows the player and culls off-window NPCs", () => {
    expect(cameraReads.player_x).toBe(14);
    const oam = cameraReads.oam as string;
    expect(littleEndianU16(oam, 2) & 0x01ff).toBe(104);
    expect(littleEndianU16(oam, 8) & 0x0200).toBe(0x0200);
    expect(cameraReads.bg1).not.toBe(runReads.world_bg1);
    expect(cameraReads.trips).toBe(0);
  });

  test("collision turns without moving and A opens the elder offer", () => {
    expect([value("boot", "mode"), value("boot", "playerX"), value("boot", "playerY")]).toEqual([0, 2, 2]);
    expect([value("wall", "playerX"), value("wall", "playerY"), value("wall", "facing")]).toEqual([2, 1, 1]);
    expect([
      value("offer", "mode"),
      value("offer", "playerX"),
      value("offer", "playerY"),
      value("offer", "facing"),
      value("offer", "quest"),
      value("offer", "dialog"),
    ]).toEqual([1, 3, 3, 3, 0, 1]);
  });

  test("destination occupancy and the Slime event commit only on arrival", () => {
    expect([
      value("slimeBefore", "mode"),
      value("slimeBefore", "playerX"),
      value("slimeBefore", "playerY"),
      signed32(value("slimeBefore", "walkPx")),
    ]).toEqual([0, 7, 2, -1]);
    expect([
      value("slimeMid", "mode"),
      value("slimeMid", "playerX"),
      value("slimeMid", "playerY"),
    ]).toEqual([0, 7, 2]);
    expect(signed32(value("slimeMid", "walkPx"))).toBeGreaterThanOrEqual(0);
    expect(signed32(value("slimeMid", "walkPx"))).toBeLessThan(16);
    expect([value("battle", "mode"), value("battle", "playerX"), value("battle", "playerY")]).toEqual([
      2, 8, 2,
    ]);
  });

  test("choice, quest gate, heal, battle, and report form one complete loop", () => {
    expect(value("offerHeld", "choice")).toBe(1);
    expect([value("declined", "quest"), value("declined", "dialog")]).toEqual([0, 3]);
    expect([value("accepted", "mode"), value("accepted", "quest"), value("accepted", "dialog")]).toEqual([1, 1, 2]);
    expect([
      value("battle", "mode"),
      value("battle", "playerX"),
      value("battle", "playerY"),
      value("battle", "quest"),
      value("battle", "heroHp"),
      value("battle", "enemyHp"),
    ]).toEqual([2, 8, 2, 1, 30, 18]);
    expect([value("healed", "heroHp"), value("healed", "enemyHp"), value("healed", "battleCursor")]).toEqual([26, 18, 1]);
    expect([
      value("won", "mode"),
      value("won", "quest"),
      value("won", "dialog"),
      value("won", "heroHp"),
      value("won", "enemyHp"),
    ]).toEqual([1, 2, 4, 18, 0]);
    expect([
      value("completeDialog", "mode"),
      value("completeDialog", "playerX"),
      value("completeDialog", "playerY"),
      value("completeDialog", "facing"),
      value("completeDialog", "quest"),
      value("completeDialog", "dialog"),
    ]).toEqual([1, 3, 3, 3, 3, 5]);
    expect([value("complete", "mode"), value("complete", "quest"), value("complete", "dialog")]).toEqual([0, 3, 0]);
    expect(runReads.trips).toBe(0);
  });

  test("world, dialog, and battle produce distinct multi-color hardware frames", async () => {
    const paths = ["rpg-world.ppm", "rpg-dialog.ppm", "rpg-battle.ppm"].map((name) => join(OUT, name));
    const frames = await Promise.all(paths.map((path) => Bun.file(path).arrayBuffer()));
    expect(new Set(frames.map((bytes) => Bun.hash(new Uint8Array(bytes)).toString())).size).toBe(3);
    for (const path of paths) expect(await countPpmColors(path)).toBeGreaterThanOrEqual(8);
    expect(runReads.world_bg1).not.toBe(runReads.battle_bg1);
    expect(runReads.world_oam).not.toBe(runReads.battle_oam);
  });

  test("world metatiles and enlarged OBJ sizes reach native GBA OAM", () => {
    const world = runReads.world_oam as string;
    const battle = runReads.battle_oam as string;
    const worldAttr1 = [littleEndianU16(world, 2), littleEndianU16(world, 10)];
    const battleAttr1 = [littleEndianU16(battle, 2), littleEndianU16(battle, 10)];
    expect(worldAttr1.map((attr) => attr & 0xc000)).toEqual([0x8000, 0x8000]);
    expect(battleAttr1.map((attr) => attr & 0xc000)).toEqual([0xc000, 0xc000]);
    // At boot the lower elder is OAM slot zero and the hero is slot one.
    // Their two-cell X distance is now 32 screen pixels, proving the 16px grid.
    expect([(worldAttr1[0] & 0x01ff), (worldAttr1[1] & 0x01ff)]).toEqual([56, 24]);
  });

  test("hardware windows keep the scrolling world behind fixed HUD and dialog UI", () => {
    expect(runReads.world_dispcnt).toBe(0x3340);
    expect(runReads.dialog_dispcnt).toBe(0x3340);
    expect(runReads.battle_dispcnt).toBe(0x1340);
  });

  test("generated 4bpp art and palettes arrive in the exact GBA VRAM banks", () => {
    expect(runReads.asset_bg_tiles).toBe(littleEndianHex(generatedWords("vp_rpg_bg_tiles")));
    expect(runReads.asset_obj_tiles).toBe(littleEndianHex(generatedWords("vp_rpg_obj_tiles")));
    expect(runReads.asset_bg_palette).toBe(littleEndianHex(generatedWords("vp_rpg_bg_palette")));
    expect(runReads.asset_obj_palettes).toBe(littleEndianHex(generatedWords("vp_rpg_obj_palettes")));
  });
});
