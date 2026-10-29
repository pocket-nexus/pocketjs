// Tower Defense's gameplay over the playset kernels, ported from GameBlocks'
// tower-defense demo (https://gb-tower-defense.vercel.app/, MIT,
// xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the creeps along the path (motion.path, speed per
//     slot), the towers' targeting (brain.turret on the creep furthest along
//     the path within range, the demo's acquireTarget) and their turrets
//     (motion.turret on a slot above the base), firing (a weapon per tower
//     level, aimed at the lead point), shots homing on their target
//     (motion.linear), every hit (the rule table: damage, the shot's burst
//     and sound), deaths (the creep's burst and sound), health bars riding
//     their creep (motion.attached), blob shadows;
//   here, at event rate — the economy, the wave director, building and
//     upgrading, the mortar's splash, the slow effect, swapping a creep's
//     health bar when it loses an eighth, the base breach;
//   here, per frame — the build cursor on the d-pad, the wave's spawn timer,
//     the autopilot (GameBlocks' PlayerAI, every 0.22 s), expiring slows
//     (every 6th frame) and the effect rings (a script, every 2nd frame).
//
// Deviations: the cursor and the shoulder buttons stand in for the mouse;
// A on a tower upgrades it (the demo selects it, then Upgrade); towers stop
// at level 6; the laser's 0.08 s beam line and the tiles' colour pulse are
// gone (rings and bursts mark builds instead); turrets turn at 12 rad/s
// rather than snapping; the mortar aims at the lead point; there are sounds.

import { EVENT, ENT, brain, createPlayset, layers, motion, sfx, type Archetype, type Playset, type Sound } from "@pocketjs/framework/playset";
import { BTN } from "@pocketjs/framework/input";
import { mulberry } from "../kit/random.ts";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

const L = layers("tower", "creep", "shot", "slow", "shell", "fx");
const MAX_LEVEL = 6;
/** player-ai.js */
const AI_THINK = 0.22;
const AI_MAX_LEVEL = 4;
const BUILD_PLAN: readonly { type: V.TowerType; right: number; forward: number }[] = [
  { type: "cannon", right: 1, forward: 3 },
  { type: "laser", right: 4, forward: 2 },
  { type: "mortar", right: 6, forward: 5 },
  { type: "slow", right: 7, forward: 4 },
  { type: "cannon", right: 3, forward: 5 },
  { type: "laser", right: 9, forward: 4 },
  { type: "mortar", right: 10, forward: 2 },
  { type: "slow", right: 4, forward: 6 },
  { type: "cannon", right: 6, forward: 2 },
  { type: "laser", right: 11, forward: 4 },
];
const CELLS = V.COLS * V.ROWS;
/** main.js CAMERA_VIEW: from (right 0, up 56, forward -60) at the centre, fov 70 */
const CAMERA_DIR = (() => {
  const l = Math.hypot(56, 60);
  return [0, 56 / l, 60 / l] as const;
})();
const FOV = 70;
const ASPECT = 400 / 240;

export function upgradeCost(type: V.TowerType, level: number): number {
  return Math.floor(V.TOWER_TYPES[type].cost * (0.72 + level * 0.38));
}

/** frameCamera + fitBoardToScreenWidth: the distance along the view at
 *  which the board's frame spans the screen less a 5-pixel margin. The view
 *  looks at the origin along -CAMERA_DIR with +X to its right, so a corner
 *  (x, 0, z) is x / ((d - z * dirZ) * tan(fovX / 2)) across the screen. */
function fitDistance(): number {
  const halfR = (V.COLS * V.TILE + 4) * 0.5;
  const halfF = (V.ROWS * V.TILE + 4) * 0.5;
  const tx = Math.tan((FOV * Math.PI) / 360) * ASPECT;
  const dz = CAMERA_DIR[2];
  const width = (d: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of [[-halfR, -halfF], [halfR, -halfF], [halfR, halfF], [-halfR, halfF]]) {
      const sx = x / ((d - z * dz) * tx);
      lo = Math.min(lo, sx);
      hi = Math.max(hi, sx);
    }
    return (hi - lo) * 0.5 * 400;
  };
  const target = 400 - 5 * 2;
  let near = 18;
  let far = Math.hypot(56, 60) * 1.8;
  for (let i = 0; i < 14; i++) {
    const d = (near + far) * 0.5;
    if (width(d) > target) near = d;
    else far = d;
  }
  return far;
}

/** GameBlocks' WaveSpawnDirector with the demo's settings. */
class Waves {
  wave = 1;
  inProgress = false;
  toSpawn = 0;
  spawned = 0;
  /** RandomUtils' DEFAULT_PRNG, seeded 42 */
  private random = mulberry(42);
  reset(): void {
    this.random = mulberry(42);
    this.wave = 1;
    this.inProgress = false;
    this.toSpawn = 0;
    this.spawned = 0;
  }
  start(): void {
    this.toSpawn = Math.max(1, Math.min(55, Math.floor(7 + (this.wave - 1) * 2.2)));
    this.spawned = 0;
    this.inProgress = true;
  }
  /** selectType over the unlocked types' weights */
  pick(): V.EnemyType {
    const w = this.wave;
    const grunt = Math.max(1, 8 - w * 0.35);
    const runner = w >= 3 ? 2.4 + w * 0.18 : 0;
    const brute = w >= 5 ? 0.9 + w * 0.16 : 0;
    const shield = w >= 7 ? 1.1 + w * 0.12 : 0;
    let r = this.random() * (grunt + runner + brute + shield);
    if ((r -= grunt) <= 0) return "grunt";
    if (runner > 0 && (r -= runner) <= 0) return "runner";
    if (brute > 0 && (r -= brute) <= 0) return "brute";
    return shield > 0 ? "shield" : brute > 0 ? "brute" : runner > 0 ? "runner" : "grunt";
  }
}

interface Hud {
  status: "title" | "playing" | "gameover";
  demo: boolean;
  money: number;
  score: number;
  wave: number;
  waveRunning: boolean;
  selected: number;
  cursorR: number;
  cursorF: number;
  message: string;
}

export class TowerDefense {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, money: 140, score: 0, wave: 1, waveRunning: false, selected: 0, cursorR: 6, cursorF: 4, message: "" };
  private readonly waves = new Waves();
  private readonly path: number;
  private readonly pathMask = new Uint8Array(CELLS);
  private readonly start: { x: number; z: number; yaw: number };
  /** per cell: the tower's turret slot (-1 none), its base slot, type index and level */
  private readonly cellSlot = new Int16Array(CELLS);
  private readonly cellBase = new Int16Array(CELLS);
  private readonly cellType = new Int8Array(CELLS);
  private readonly cellLevel = new Int8Array(CELLS);
  private towers = 0;
  private readonly baseArch: Archetype;
  private readonly towerArch: Archetype[][] = [];
  private readonly shotArch: Archetype[][] = [];
  private readonly creepArch: Record<V.EnemyType, Archetype>;
  private readonly creepIds = new Int16Array(8).fill(-1);
  private readonly barArch: Archetype[] = [];
  private readonly barOffset: Record<V.EnemyType, [number, number, number]>;
  /** per slot: its creep's health bar slot and the eighths it shows */
  private readonly barSlot: Int16Array;
  private readonly barK: Int8Array;
  private readonly creepType: Int8Array;
  private readonly ringShort: Archetype;
  private readonly ringLong: Archetype;
  private readonly cursorNodes: number[];
  private readonly rangeNodes: number[];
  private readonly sounds: Record<"place" | "upgrade" | "deny" | "move" | "wave" | "clear" | "breach" | "lose" | "freeze", Sound>;
  private readonly breachFx: { id: number };
  private readonly rules: { shot: number; slow: number; shell: number };
  private active = 0;
  private spawnTimer = 0;
  private time = 0;
  private aiTimer = 0;
  private holdFrames = 0;
  private repeat = 0;
  private lastMove = 0;
  private settle = 0;
  private readonly slowSlot = new Int16Array(96);
  private readonly slowUntil = new Float32Array(96);
  private slowCount = 0;
  private frameNo = 0;

  constructor() {
    const play = createPlayset({ capacity: 400, particles: 700, seed: 20260801 });
    this.play = play;
    const cap = play.capacity;
    this.barSlot = new Int16Array(cap).fill(-1);
    this.barK = new Int8Array(cap);
    this.creepType = new Int8Array(cap).fill(-1);
    // the sky texture's gradient and the scene fog
    play.sky(0x55b8ff, 0x9fe0ff, 0xeffcff);
    play.fog(0xd9f5ff, 62, 128, 1);
    // HemisphereLight 0xffffff / 0x9bc779 2.45, the sun 0xfff5d8 3.1 from
    // (-16, 42, -24) in the demo's basis
    play.light({ sun: [-16, 42, 24], sunColor: 0xfff5d8, sunIntensity: 0.55, sky: 0xffffff, ground: 0x9bc779, ambient: 0.6 });
    play.gravity(9);
    // the blob shadows' ground: the tile tops (a centimetre square that draws nothing)
    play.ground({ y: 0.11, size: 0.01, color: V.COLORS.grass, cell: 0.01 });

    const cells = V.expandPath(V.PATH_CELLS);
    for (const c of cells) this.pathMask[c.forward * V.COLS + c.right] = 1;
    play.place(play.model(V.board(cells)), [0, 0, 0], { static: true });
    this.path = play.path(cells.map((c) => [V.cellX(c.right), V.PATH_UP, V.cellZ(c.forward)] as const));
    const first = cells[0];
    const second = cells[1];
    this.start = { x: V.cellX(first.right), z: V.cellZ(first.forward), yaw: Math.atan2(-(V.cellX(second.right) - V.cellX(first.right)), -(V.cellZ(second.forward) - V.cellZ(first.forward))) };

    const burst = (color: number, count: number, speed: number, size = 0.22) =>
      play.emitter({ count, life: 0.55, lifeJitter: 0.25, speed, spread: 1.1, dir: [0, 1, 0], gravity: 0.6, size: [size, size * 0.4], color: [color, color], alpha: [0.95, 0], blend: "alpha", drag: 0.6 });
    const deathBurst = burst(0x9cff88, 12, 4.6, 0.24);
    this.breachFx = burst(0xff675f, 30, 6, 0.3);
    const hit = play.sound({ ...sfx.hit(), volume: 0.16 });
    const pop = play.sound({ ...sfx.smallExplosion(), volume: 0.32 });
    const fire: Record<V.TowerType, Sound> = {
      cannon: play.sound({ ...sfx.cannon(), volume: 0.26 }),
      laser: play.sound({ ...sfx.laser(), volume: 0.13 }),
      mortar: play.sound({ ...sfx.cannon(), freq: 520, to: 40, volume: 0.36 }),
      slow: play.sound({ ...sfx.blaster(), freq: 900, to: 300, volume: 0.15 }),
    };
    this.sounds = {
      place: play.sound(sfx.place()),
      upgrade: play.sound(sfx.powerup()),
      deny: play.sound({ ...sfx.select(), wave: "square", freq: 170, to: 120, decay: 0.12, volume: 0.25 }),
      move: play.sound({ ...sfx.select(), volume: 0.1 }),
      wave: play.sound(sfx.wave()),
      clear: play.sound(sfx.checkpoint()),
      breach: play.sound(sfx.bigExplosion()),
      lose: play.sound(sfx.lose()),
      freeze: play.sound({ ...sfx.powerup(), freq: 1200, to: 500, sustain: 0.04, decay: 0.12, volume: 0.12 }),
    };

    // creeps on the path; HP, speed and rewards per slot (the wave scales them)
    this.creepArch = {} as Record<V.EnemyType, Archetype>;
    this.barOffset = {} as Record<V.EnemyType, [number, number, number]>;
    V.ENEMY_ORDER.forEach((t, i) => {
      const def = V.ENEMY_TYPES[t];
      this.creepArch[t] = play.archetype({
        model: play.model(V.enemy(t)), motion: motion.path({ path: this.path, speed: def.speed, turnRate: 10 }),
        layer: L.creep, team: 2, radius: 0.45 * def.scale, height: 1.8, hp: def.hp, flash: 0.12, shadow: 0.85 * def.scale,
        targetable: true, death: deathBurst, sounds: { death: pop },
      });
      this.creepIds[i] = this.creepArch[t].id;
      this.barOffset[t] = [0, V.barHeight(t), 0];
    });
    const facing = Math.atan2(CAMERA_DIR[1], CAMERA_DIR[2]);
    for (let k = 1; k <= 8; k++) this.barArch.push(play.archetype({ model: play.model(V.healthBar(k, facing)), motion: motion.attached() }));

    // towers: a base, and a turret per type and level with its shots
    this.baseArch = play.archetype({ model: play.model(V.towerBase()), motion: motion.none(), layer: L.tower, shadow: 1.5 });
    const layerOf: Record<V.TowerType, number> = { cannon: L.shot, laser: L.shot, mortar: L.shell, slow: L.slow };
    V.TOWER_ORDER.forEach((t) => {
      const def = V.TOWER_TYPES[t];
      const model = play.model(V.turret(t));
      const shotModel = play.model(V.projectile(t));
      const impact = burst(def.projectileColor, t === "mortar" ? 16 : 9, t === "mortar" ? 5 : 3.2, t === "mortar" ? 0.3 : 0.18);
      const towers: Archetype[] = [];
      const shots: Archetype[] = [];
      for (let level = 1; level <= MAX_LEVEL; level++) {
        const shot = play.archetype({
          model: shotModel, motion: motion.linear({ speed: def.projectileSpeed, homing: t === "mortar" ? 0 : t === "laser" ? 18 : 10 }),
          layer: layerOf[t], hits: L.creep, team: 1, radius: t === "laser" ? 0.4 : 0.6, lifetime: 1.6, projectile: true,
          damage: Math.floor(def.damage * (1 + (level - 1) * 0.34)), death: impact, sounds: { death: hit },
        });
        shots.push(shot);
        towers.push(play.archetype({
          model, motion: motion.turret({ yawRate: 12, pitchRate: 0, minPitch: 0, maxPitch: 0 }), layer: L.tower, team: 1,
          brain: brain.turret({ target: { leading: L.creep, sight: def.range, every: 0.1 }, fireRange: def.range + 0.6, fireCone: 0 }),
          weapons: [{ projectile: shot, cooldown: def.cooldown / (1 + (level - 1) * 0.16), speed: def.projectileSpeed, muzzle: [0, V.TURRET_FIRE_HEIGHT, 0], aim: "lead", sound: fire[t] }],
        }));
      }
      this.towerArch.push(towers);
      this.shotArch.push(shots);
    });
    this.rules = {
      shot: play.rule(L.shot, L.creep, { damage: "b", kill: "a", event: true }),
      slow: play.rule(L.slow, L.creep, { damage: "b", kill: "a", event: true }),
      shell: play.rule(L.shell, L.creep, { kill: "a", event: true }),
    };

    // effect rings: scaled and faded by a script
    const ringModel = play.model(V.effectRing());
    this.ringShort = play.archetype({ model: ringModel, motion: motion.none(), lifetime: 0.45 });
    this.ringLong = play.archetype({ model: ringModel, motion: motion.none(), lifetime: 0.7 });
    const ringScript = (life: number) => (s: number) => {
      const play = this.play;
      const o = s * 16;
      const u = s * 8;
      const k = play.ent[o + ENT.AGE] / life;
      const fade = k >= 1 ? 0 : 1 - k;
      const user = play.user;
      const look = play.look;
      look[s * 4] = user[u] * (1 + k * 2.2);
      look[s * 4 + 1] = user[u + 1] * fade;
      look[s * 4 + 2] = user[u + 2] * fade;
      look[s * 4 + 3] = user[u + 3] * fade;
    };
    play.script(this.ringShort, ringScript(0.45), 2, 0);
    play.script(this.ringLong, ringScript(0.7), 2, 1);

    // the build cursor (free, blocked, a tower) and the range preview per type
    this.cursorNodes = [0x79d98b, 0xff6e60, 0xf1c65a].map((c) => play.place(play.model(V.cursor(c)), [0, 0.2, 0], { static: false, hidden: true }));
    this.rangeNodes = V.TOWER_ORDER.map((t) => play.place(play.model(V.rangeRing(t)), [0, 0.14, 0], { static: false, hidden: true }));
    const d = fitDistance();
    play.fixedCamera([0, CAMERA_DIR[1] * d, CAMERA_DIR[2] * d], [0, 0, 0], FOV, 180, d * 0.4);

    play.on(EVENT.HIT, (shot, creep, rule, x, _y, z, damage) => this.onHit(rule, creep, x, z, damage));
    play.on(EVENT.DEATH, (slot, _killer, arch, x, y, z) => this.onDeath(slot, arch, x, y, z));
    play.on(EVENT.ARRIVE, (slot, _b, _gate, x, y, z) => this.onBreach(slot, x, y, z));
    this.reset(true);
  }

  private isCreep(arch: number): boolean {
    const ids = this.creepIds;
    return arch === ids[0] || arch === ids[1] || arch === ids[2] || arch === ids[3];
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.money = 140;
    hud.score = 0;
    hud.wave = 1;
    hud.waveRunning = false;
    hud.selected = 0;
    hud.cursorR = 6;
    hud.cursorF = 4;
    hud.message = demo ? "" : "Build, then X: wave";
    this.waves.reset();
    this.cellSlot.fill(-1);
    this.cellBase.fill(-1);
    this.cellLevel.fill(0);
    this.towers = 0;
    this.barSlot.fill(-1);
    this.barK.fill(0);
    this.creepType.fill(-1);
    this.active = 0;
    this.spawnTimer = 0;
    this.time = 0;
    this.aiTimer = 0;
    this.slowCount = 0;
    this.settle = 12;
    this.lastMove = 0;
    this.showCursor();
  }

  // --- building -------------------------------------------------------------

  private say(text: string): void {
    this.hud.message = text;
  }

  private pulse(arch: Archetype, x: number, z: number, color: number, radius: number): void {
    const play = this.play;
    const s = play.spawn(arch, x, 0.2, z);
    if (s < 0) return;
    const c = color;
    const u = s * 8;
    play.user[u] = radius;
    play.user[u + 1] = ((c >> 16) & 255) / 255;
    play.user[u + 2] = ((c >> 8) & 255) / 255;
    play.user[u + 3] = (c & 255) / 255;
    play.look[s * 4] = radius;
    play.look[s * 4 + 1] = play.user[u + 1];
    play.look[s * 4 + 2] = play.user[u + 2];
    play.look[s * 4 + 3] = play.user[u + 3];
  }

  /** placeTower: false with a message when the tile or the purse says no. */
  placeTower(right: number, forward: number, typeIndex: number): boolean {
    const play = this.play;
    const hud = this.hud;
    const cell = forward * V.COLS + right;
    const type = V.TOWER_ORDER[typeIndex];
    const def = V.TOWER_TYPES[type];
    if (this.pathMask[cell]) {
      this.say("The path stays open");
      play.play(this.sounds.deny);
      return false;
    }
    if (this.cellSlot[cell] >= 0) {
      this.say("Tile taken");
      return false;
    }
    if (hud.money < def.cost) {
      this.say(`Need $${def.cost}`);
      play.play(this.sounds.deny);
      return false;
    }
    hud.money -= def.cost;
    hud.selected = typeIndex;
    const x = V.cellX(right);
    const z = V.cellZ(forward);
    this.cellBase[cell] = play.spawn(this.baseArch, x, V.TOWER_UP, z);
    const slot = play.spawn(this.towerArch[typeIndex][0], x, V.TOWER_UP, z);
    this.cellSlot[cell] = slot;
    this.cellType[cell] = typeIndex;
    this.cellLevel[cell] = 1;
    this.towers++;
    this.pulse(this.ringLong, x, z, 0x79d98b, 2.2);
    play.play(this.sounds.place, 0.9, 1, [x, 0, z]);
    this.say(`${def.label} placed`);
    return true;
  }

  upgradeTower(right: number, forward: number): boolean {
    const play = this.play;
    const hud = this.hud;
    const cell = forward * V.COLS + right;
    const old = this.cellSlot[cell];
    if (old < 0) return false;
    const typeIndex = this.cellType[cell];
    const type = V.TOWER_ORDER[typeIndex];
    const level = this.cellLevel[cell];
    const def = V.TOWER_TYPES[type];
    if (level >= MAX_LEVEL) {
      this.say(`${def.label} is at the top`);
      play.play(this.sounds.deny);
      return false;
    }
    const cost = upgradeCost(type, level);
    if (hud.money < cost) {
      this.say(`Need $${cost}`);
      play.play(this.sounds.deny);
      return false;
    }
    hud.money -= cost;
    const x = V.cellX(right);
    const z = V.cellZ(forward);
    // the next level's turret keeps the old one's heading
    const yaw = play.yaw(old);
    play.kill(old);
    const slot = play.spawn(this.towerArch[typeIndex][level], x, V.TOWER_UP, z, yaw);
    // tower.group.scale.setScalar(1 + (level - 1) * 0.08)
    if (slot >= 0) play.look[slot * 4] = 1 + level * 0.08;
    const base = this.cellBase[cell];
    if (base >= 0) play.look[base * 4] = 1 + level * 0.08;
    this.cellSlot[cell] = slot;
    this.cellLevel[cell] = level + 1;
    this.pulse(this.ringLong, x, z, def.color, 2.2);
    play.play(this.sounds.upgrade, 0.8, 1, [x, 0, z]);
    this.say(`${def.label} now L${level + 1}`);
    return true;
  }

  startWave(): void {
    if (this.hud.status === "gameover" || this.waves.inProgress) return;
    this.waves.start();
    this.hud.waveRunning = true;
    this.spawnTimer = 0.2;
    this.play.play(this.sounds.wave, 0.8);
    this.say(`Wave ${this.waves.wave} incoming`);
  }

  // --- the run ----------------------------------------------------------------

  private spawnCreep(): void {
    const play = this.play;
    const type = this.waves.pick();
    const def = V.ENEMY_TYPES[type];
    const w = this.waves.wave;
    const s = play.spawn(this.creepArch[type], this.start.x, V.PATH_UP, this.start.z, this.start.yaw);
    if (s < 0) return;
    const o = s * 16;
    const hp = Math.floor(def.hp * (1 + (w - 1) * 0.13));
    const speed = def.speed * (1 + Math.min(0.35, (w - 1) * 0.025));
    play.ent[o + ENT.HP] = hp;
    play.ent[o + ENT.HP_MAX] = hp;
    play.ent[o + ENT.SPEED] = speed;
    const u = s * 8;
    play.user[u] = speed;
    play.user[u + 1] = def.reward + Math.floor(w * 1.25);
    play.user[u + 2] = def.score;
    this.creepType[s] = V.ENEMY_ORDER.indexOf(type);
    this.barSlot[s] = -1;
    this.barK[s] = 8;
    this.active++;
  }

  /** HealthBarView.step: a bar of the creep's eighths, shown once it is hurt. */
  private updateBar(creep: number): void {
    const play = this.play;
    const o = creep * 16;
    const hp = play.ent[o + ENT.HP];
    const max = play.ent[o + ENT.HP_MAX];
    if (hp <= 0 || hp >= max) return;
    let k = Math.ceil((hp / max) * 8);
    if (k < 1) k = 1;
    if (k === this.barK[creep] && this.barSlot[creep] >= 0) return;
    const old = this.barSlot[creep];
    if (old >= 0) play.kill(old);
    const bar = play.spawn(this.barArch[k - 1], play.ent[o], play.ent[o + 1], play.ent[o + 2]);
    if (bar >= 0) play.attach(bar, creep, this.barOffset[V.ENEMY_ORDER[this.creepType[creep]]], 0, false);
    this.barSlot[creep] = bar;
    this.barK[creep] = k;
  }

  private onHit(rule: number, creep: number, x: number, z: number, damage: number): void {
    const play = this.play;
    if (rule === this.rules.shell) {
      // applyProjectileHit: the mortar's splash around the creep it hit
      const level = Math.round((damage / V.TOWER_TYPES.mortar.damage - 1) / 0.34) + 1;
      const splash = V.TOWER_TYPES.mortar.splash * (1 + (level - 1) * 0.08);
      const cx = play.ent[creep * 16];
      const cz = play.ent[creep * 16 + 2];
      const n = play.near(L.creep, cx, cz, splash);
      const list = play.list;
      const ent = play.ent;
      // `list` is reused by the calls below: copy the slots first
      const hits = this.splashScratch;
      const count = n < hits.length ? n : hits.length;
      for (let i = 0; i < count; i++) hits[i] = list[i];
      for (let i = 0; i < count; i++) {
        const s = hits[i];
        const o = s * 16;
        const dx = ent[o] - cx;
        const dz = ent[o + 2] - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        let k = 1 - (d / splash) * 0.55;
        if (k < 0.35) k = 0.35;
        else if (k > 1) k = 1;
        const hp = ent[o + ENT.HP] - Math.round(damage * k);
        ent[o + ENT.HP] = hp;
        if (hp <= 0) play.kill(s, "event");
        else this.updateBar(s);
      }
      this.pulse(this.ringShort, cx, cz, V.TOWER_TYPES.mortar.projectileColor, splash * 0.5);
      return;
    }
    if (rule === this.rules.slow) {
      const def = V.TOWER_TYPES.slow.slow!;
      play.ent[creep * 16 + ENT.SPEED] = play.user[creep * 8] * def.factor;
      this.slowed(creep, this.time + def.duration);
      this.pulse(this.ringShort, play.ent[creep * 16], play.ent[creep * 16 + 2], 0x9f8df6, 1.4);
      play.playAt(this.sounds.freeze, creep);
    }
    this.updateBar(creep);
    void x;
    void z;
  }
  private readonly splashScratch = new Float32Array(64);

  private slowed(creep: number, until: number): void {
    for (let i = 0; i < this.slowCount; i++) {
      if (this.slowSlot[i] === creep) {
        if (this.slowUntil[i] < until) this.slowUntil[i] = until;
        return;
      }
    }
    if (this.slowCount >= this.slowSlot.length) return;
    this.slowSlot[this.slowCount] = creep;
    this.slowUntil[this.slowCount] = until;
    this.slowCount++;
  }

  private expireSlows(): void {
    const play = this.play;
    const t = this.time;
    let i = 0;
    while (i < this.slowCount) {
      if (this.slowUntil[i] > t) {
        i++;
        continue;
      }
      const s = this.slowSlot[i];
      if (play.alive(s) && this.isCreep(play.archetypeOf(s))) play.ent[s * 16 + ENT.SPEED] = play.user[s * 8];
      this.slowCount--;
      this.slowSlot[i] = this.slowSlot[this.slowCount];
      this.slowUntil[i] = this.slowUntil[this.slowCount];
    }
  }

  private onDeath(slot: number, arch: number, _x: number, _y: number, _z: number): void {
    if (!this.isCreep(arch)) return;
    const play = this.play;
    const hud = this.hud;
    this.active--;
    hud.money += play.user[slot * 8 + 1];
    hud.score += play.user[slot * 8 + 2];
    const bar = this.barSlot[slot];
    if (bar >= 0) play.kill(bar);
    this.barSlot[slot] = -1;
    this.creepType[slot] = -1;
  }

  private onBreach(slot: number, x: number, y: number, z: number): void {
    const play = this.play;
    const hud = this.hud;
    if (hud.status === "gameover") return;
    hud.status = "gameover";
    this.say("Base breached");
    play.burst(this.breachFx, x, y + 0.8, z);
    play.play(this.sounds.breach, 0.9, 1, [x, y, z]);
    play.play(this.sounds.lose, 0.8);
    play.shake(0.7);
    play.kill(slot);
    const bar = this.barSlot[slot];
    if (bar >= 0) play.kill(bar);
    this.hideCursor();
  }

  // --- input ------------------------------------------------------------------

  private hideCursor(): void {
    const play = this.play;
    for (const n of this.cursorNodes) play.move(n, 0, 0, 0, 0, 0, 0, 1, true);
    for (const n of this.rangeNodes) play.move(n, 0, 0, 0, 0, 0, 0, 1, true);
  }

  /** The cursor frame in the tile's state and the range of what A would
   *  build or upgrade there. */
  private showCursor(): void {
    const play = this.play;
    const hud = this.hud;
    if (hud.demo || hud.status !== "playing") {
      this.hideCursor();
      return;
    }
    const cell = hud.cursorF * V.COLS + hud.cursorR;
    const tower = this.cellSlot[cell] >= 0;
    const state = tower ? 2 : this.pathMask[cell] ? 1 : 0;
    const x = V.cellX(hud.cursorR);
    const z = V.cellZ(hud.cursorF);
    for (let i = 0; i < 3; i++) play.move(this.cursorNodes[i], x, 0.2, z, 0, 0, 0, 1, i !== state);
    const range = tower ? this.cellType[cell] : this.pathMask[cell] ? -1 : hud.selected;
    for (let i = 0; i < 4; i++) play.move(this.rangeNodes[i], x, 0.14, z, 0, 0, 0, 1, i !== range);
  }

  private input(pad: Pad): void {
    const hud = this.hud;
    if (this.settle > 0) {
      // the press that started the run is not a build
      this.settle--;
      return;
    }
    const x = pad.x;
    const y = pad.y;
    const dr = x > 0.5 ? 1 : x < -0.5 ? -1 : 0;
    const df = y > 0.5 ? 1 : y < -0.5 ? -1 : 0;
    const move = dr * 3 + df;
    if (move !== 0) {
      // a step on the press, then a repeat while held
      let step = false;
      if (move !== this.lastMove) {
        step = true;
        this.repeat = 16;
      } else if (--this.repeat <= 0) {
        step = true;
        this.repeat = 6;
      }
      if (step) {
        const r = Math.max(0, Math.min(V.COLS - 1, hud.cursorR + dr));
        // up on the screen is forward on the board
        const f = Math.max(0, Math.min(V.ROWS - 1, hud.cursorF + df));
        if (r !== hud.cursorR || f !== hud.cursorF) {
          hud.cursorR = r;
          hud.cursorF = f;
          this.play.play(this.sounds.move);
          this.showCursor();
        }
      }
    }
    this.lastMove = move;
    const pressed = pad.pressed;
    if (pressed & (BTN.LTRIGGER | BTN.RTRIGGER | BTN.CROSS)) {
      const step = pressed & BTN.LTRIGGER ? 3 : 1;
      hud.selected = (hud.selected + step) % 4;
      const def = V.TOWER_TYPES[V.TOWER_ORDER[hud.selected]];
      this.say(`${def.label} selected`);
      this.play.play(this.sounds.move, 1, 1.5);
      this.showCursor();
    }
    if (pressed & BTN.CIRCLE) {
      const cell = hud.cursorF * V.COLS + hud.cursorR;
      if (this.cellSlot[cell] >= 0) this.upgradeTower(hud.cursorR, hud.cursorF);
      else this.placeTower(hud.cursorR, hud.cursorF, hud.selected);
      this.showCursor();
    }
    if (pressed & BTN.TRIANGLE) this.startWave();
  }

  /** player-ai.js: build the next affordable tower of the plan, else start
   *  a wave, else upgrade the lowest affordable tower below level 4. */
  private autopilot(): void {
    const hud = this.hud;
    for (let i = 0; i < BUILD_PLAN.length; i++) {
      const p = BUILD_PLAN[i];
      if (this.cellSlot[p.forward * V.COLS + p.right] >= 0) continue;
      if (hud.money < V.TOWER_TYPES[p.type].cost) continue;
      this.placeTower(p.right, p.forward, V.TOWER_ORDER.indexOf(p.type));
      return;
    }
    if (!this.waves.inProgress && this.towers > 0) {
      this.startWave();
      return;
    }
    let best = -1;
    let bestLevel = 99;
    let bestCost = 1e9;
    for (let cell = 0; cell < CELLS; cell++) {
      if (this.cellSlot[cell] < 0) continue;
      const level = this.cellLevel[cell];
      if (level >= AI_MAX_LEVEL) continue;
      const cost = upgradeCost(V.TOWER_ORDER[this.cellType[cell]], level);
      if (hud.money < cost) continue;
      if (level < bestLevel || (level === bestLevel && cost < bestCost)) {
        best = cell;
        bestLevel = level;
        bestCost = cost;
      }
    }
    if (best >= 0) this.upgradeTower(best % V.COLS, Math.floor(best / V.COLS));
  }

  frame(pad: Pad): void {
    const play = this.play;
    const hud = this.hud;
    const dt = 1 / 60;
    const live = hud.status === "playing" || (hud.status === "title" && hud.demo);
    if (live) {
      this.time += dt;
      if (hud.demo) {
        this.aiTimer -= dt;
        if (this.aiTimer <= 0) {
          this.aiTimer = AI_THINK;
          this.autopilot();
        }
      } else {
        this.input(pad);
      }
      const waves = this.waves;
      if (waves.inProgress) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          if (waves.spawned < waves.toSpawn) {
            waves.spawned++;
            this.spawnCreep();
          }
          this.spawnTimer = Math.max(0.28, 0.82 - waves.wave * 0.025);
        }
        if (waves.spawned >= waves.toSpawn && this.active <= 0) {
          waves.inProgress = false;
          waves.wave++;
          hud.wave = waves.wave;
          hud.waveRunning = false;
          play.play(this.sounds.clear, 0.8);
          this.say(hud.demo ? "" : `Wave ${waves.wave - 1} cleared`);
        }
      }
      if (this.frameNo % 6 === 0 && this.slowCount > 0) this.expireSlows();
    }
    this.frameNo++;
    play.frame(dt);
  }

  /** What the cursor's tile holds, for the touch screen. */
  tileText(): string {
    const hud = this.hud;
    const cell = hud.cursorF * V.COLS + hud.cursorR;
    if (this.cellSlot[cell] >= 0) {
      const type = V.TOWER_ORDER[this.cellType[cell]];
      const level = this.cellLevel[cell];
      return level >= MAX_LEVEL ? `${V.TOWER_TYPES[type].label} L${level} top` : `${V.TOWER_TYPES[type].label} L${level} up $${upgradeCost(type, level)}`;
    }
    return this.pathMask[cell] ? "Path" : "Free";
  }
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new TowerDefense();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  const hud = game.hud;
  return {
    title: "Tower Defense",
    tagline: "Stop every wave before an enemy breaches the base.\nBuild on green tiles; upgrade what works.",
    accent: "#4e9f5a",
    controls: [
      ["D-Pad / Circle Pad", "Move the cursor"],
      ["A", "Build / upgrade"],
      ["L / R / B", "Tower type"],
      ["X", "Start the wave"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Money", value: () => `$${hud.money}` },
      { label: "Score", value: () => hud.score },
      { label: "Wave", value: () => (hud.waveRunning ? `${hud.wave} running` : `${hud.wave} ready`) },
      { label: "Build", value: () => {
        const def = V.TOWER_TYPES[V.TOWER_ORDER[hud.selected]];
        return `${def.label} $${def.cost}`;
      } },
      { label: "Tile", value: () => game.tileText() },
      { label: "Note", value: () => hud.message },
    ],
    play: game.play,
    status(): GameStatus {
      if (hud.status === "title") return "title";
      if (hud.status === "gameover") return hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop starts over two seconds after a demo run ends
      if (hud.demo && hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => `$${hud.money}    SCORE ${hud.score}    WAVE ${hud.wave}`,
    result: () => `Score ${hud.score} · reached wave ${hud.wave}`,
  };
}
