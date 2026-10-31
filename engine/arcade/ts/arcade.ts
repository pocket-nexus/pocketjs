// @pocketjs/framework/arcade: the TypeScript half of Pocket Arcade. This file
// runs inside the game's QuickJS runtime, stripped of types by the device.

declare const __arcade: any;
const host = __arcade;
const STRIDE: number = host.stride;
const MAX: number = host.maxEntities;
const table = new Float32Array(MAX * STRIDE);
(globalThis as any).__arcade_entities = table;

export const SHAPE = { box: 0, plane: 1, sphere: 2, cylinder: 3, cone: 4, torus: 5 } as const;
export type Shape = keyof typeof SHAPE | number;

export interface EntityOptions {
  shape?: Shape;
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  /** Uniform scale, or per-axis below. */
  scale?: number;
  sx?: number; sy?: number; sz?: number;
  color?: number;
  /** 0 is fully lit by the scene's lights, 1 ignores them. */
  emissive?: number;
  alpha?: number;
  shadow?: boolean;
  visible?: boolean;
}

let top = 0;
const free: number[] = [];
const live: (Entity | null)[] = [];

export class Entity {
  readonly o: number;
  constructor(readonly index: number) { this.o = index * STRIDE; }
  get x() { return table[this.o]!; } set x(v: number) { table[this.o] = v; }
  get y() { return table[this.o + 1]!; } set y(v: number) { table[this.o + 1] = v; }
  get z() { return table[this.o + 2]!; } set z(v: number) { table[this.o + 2] = v; }
  get rx() { return table[this.o + 3]!; } set rx(v: number) { table[this.o + 3] = v; }
  get ry() { return table[this.o + 4]!; } set ry(v: number) { table[this.o + 4] = v; }
  get rz() { return table[this.o + 5]!; } set rz(v: number) { table[this.o + 5] = v; }
  get sx() { return table[this.o + 6]!; } set sx(v: number) { table[this.o + 6] = v; }
  get sy() { return table[this.o + 7]!; } set sy(v: number) { table[this.o + 7] = v; }
  get sz() { return table[this.o + 8]!; } set sz(v: number) { table[this.o + 8] = v; }
  set scale(v: number) { this.sx = v; this.sy = v; this.sz = v; }
  get emissive() { return table[this.o + 12]!; } set emissive(v: number) { table[this.o + 12] = v; }
  get alpha() { return table[this.o + 15]!; } set alpha(v: number) { table[this.o + 15] = v; }
  set shape(v: Shape) { table[this.o + 13] = typeof v === "number" ? v : SHAPE[v]; }
  get color(): number {
    const o = this.o;
    return (Math.round(table[o + 9]! * 255) << 16) | (Math.round(table[o + 10]! * 255) << 8) | Math.round(table[o + 11]! * 255);
  }
  set color(v: number) {
    const o = this.o;
    table[o + 9] = ((v >> 16) & 255) / 255;
    table[o + 10] = ((v >> 8) & 255) / 255;
    table[o + 11] = (v & 255) / 255;
  }
  get visible() { return ((table[this.o + 14]! | 0) & 1) !== 0; }
  set visible(v: boolean) { const f = table[this.o + 14]! | 0; table[this.o + 14] = v ? f | 1 : f & ~1; }
  get shadow() { return ((table[this.o + 14]! | 0) & 2) !== 0; }
  set shadow(v: boolean) { const f = table[this.o + 14]! | 0; table[this.o + 14] = v ? f | 2 : f & ~2; }
  /** Set the position in one call. */
  at(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  /** Sphere overlap: each entity's radius is half its largest scale. */
  touches(other: Entity, margin = 0): boolean {
    const dx = this.x - other.x, dy = this.y - other.y, dz = this.z - other.z;
    const r = Math.max(this.sx, this.sy, this.sz) / 2 + Math.max(other.sx, other.sy, other.sz) / 2 + margin;
    return dx * dx + dy * dy + dz * dz < r * r;
  }
  /** Axis-aligned box overlap using position and scale. */
  overlaps(other: Entity): boolean {
    return Math.abs(this.x - other.x) * 2 < this.sx + other.sx &&
      Math.abs(this.y - other.y) * 2 < this.sy + other.sy &&
      Math.abs(this.z - other.z) * 2 < this.sz + other.sz;
  }
  remove(): void { destroy(this); }
}

/** Create an entity. At most 4096 are alive at once. */
export function spawn(options: EntityOptions = {}): Entity {
  const index = free.length ? free.pop()! : top++;
  if (index >= MAX) throw new Error(`more than ${MAX} entities`);
  const e = new Entity(index);
  live[index] = e;
  const s = options.scale ?? 1;
  e.at(options.x ?? 0, options.y ?? 0, options.z ?? 0);
  e.rx = options.rx ?? 0; e.ry = options.ry ?? 0; e.rz = options.rz ?? 0;
  e.sx = options.sx ?? s; e.sy = options.sy ?? s; e.sz = options.sz ?? s;
  e.color = options.color ?? 0xffffff;
  e.emissive = options.emissive ?? 0;
  e.alpha = options.alpha ?? 1;
  e.shape = options.shape ?? "box";
  table[e.o + 14] = (options.visible === false ? 0 : 1) | (options.shadow ? 2 : 0);
  return e;
}

export function destroy(e: Entity): void {
  if (live[e.index] !== e) return;
  live[e.index] = null;
  table[e.o + 14] = 0;
  free.push(e.index);
}

/** Every live entity. */
export function entities(): Entity[] {
  return live.filter((e): e is Entity => e !== null);
}

/** A mesh of your own. vertices are x,y,z,nx,ny,nz per vertex; indices are triangles. */
export function defineMesh(vertices: number[], indices: number[]): number {
  return host.mesh(vertices, indices);
}

export const camera = {
  /** Look from (x,y,z) at (tx,ty,tz); fov is vertical degrees. */
  look(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 50) {
    host.camera(x, y, z, tx, ty, tz, fov);
  },
  /** Chase a target from an offset, smoothing with `ease` each second (higher is stiffer). */
  follow(target: { x: number; y: number; z: number }, offset: [number, number, number], ease = 6, fov = 50) {
    const k = 1 - Math.exp(-ease / 60);
    followEye[0] += (target.x + offset[0] - followEye[0]) * k;
    followEye[1] += (target.y + offset[1] - followEye[1]) * k;
    followEye[2] += (target.z + offset[2] - followEye[2]) * k;
    host.camera(followEye[0], followEye[1], followEye[2], target.x, target.y, target.z, fov);
  },
};
const followEye = [0, 8, 12];

export const scene = {
  sky(color: number) { host.sky(color); host.fog(color, 60, 180); },
  fog(color: number, near: number, far: number) { host.fog(color, near, far); },
  /** x,y,z is the direction sunlight travels. */
  sun(x: number, y: number, z: number, color = 0xffffff, strength = 0.8) { host.sun(x, y, z, color, strength); },
  ambient(top: number, bottom: number) { host.ambient(top, bottom); },
  /** The height blob shadows fall on. */
  ground(y: number) { host.ground(y); },
};

/** Screen is 1280x720 regardless of the output size. */
export const hud = {
  rect(x: number, y: number, w: number, h: number, color = 0xffffff, alpha = 1) { host.rect(x, y, w, h, color, alpha); },
  text(text: string | number, x: number, y: number, options: { size?: number; color?: number; alpha?: number; align?: "left" | "center" | "right" } = {}) {
    const align = options.align === "center" ? 1 : options.align === "right" ? 2 : 0;
    host.text(String(text), x, y, options.size ?? 32, options.color ?? 0xffffff, options.alpha ?? 1, align);
  },
};

export const fx = {
  burst(x: number, y: number, z: number, options: { color?: number; count?: number; speed?: number; life?: number; size?: number } = {}) {
    host.burst(x, y, z, options.color ?? 0xffffff, [options.count ?? 16, options.speed ?? 5, options.life ?? 0.6, options.size ?? 0.18]);
  },
};

const WAVES = { square: 0, triangle: 1, saw: 2, noise: 3, sine: 4 } as const;
export const sfx = {
  tone(frequency: number, seconds = 0.12, options: { volume?: number; wave?: keyof typeof WAVES; slide?: number } = {}) {
    host.tone(frequency, seconds, options.volume ?? 0.35, WAVES[options.wave ?? "square"], options.slide ?? 0);
  },
  coin() { host.tone(988, 0.07, 0.3, 0, 0); host.tone(1319, 0.2, 0.3, 0, 0); },
  jump() { host.tone(300, 0.18, 0.3, 0, 500); },
  hit() { host.tone(180, 0.2, 0.45, 3, -120); },
  lose() { host.tone(440, 0.5, 0.35, 2, -330); },
};

/** Physical buttons by position: a is the right face button, b the bottom one. */
const BUTTONS = { up: 1, down: 2, left: 4, right: 8, a: 16, b: 32, x: 64, y: 128, l: 256, r: 512, start: 1024, select: 2048 } as const;
export type Button = keyof typeof BUTTONS;
let buttons = 0, previous = 0;
export const input = {
  /** Left stick in [-1, 1], combined with the d-pad; +y is down on the stick. */
  x: 0, y: 0,
  /** Right stick in [-1, 1]. */
  rx: 0, ry: 0,
  /** Triggers in [0, 1]. */
  lt: 0, rt: 0,
  held(button: Button): boolean { return (buttons & BUTTONS[button]) !== 0; },
  /** True on the one tick the button goes down. */
  pressed(button: Button): boolean { return (buttons & BUTTONS[button]) !== 0 && (previous & BUTTONS[button]) === 0; },
  released(button: Button): boolean { return (buttons & BUTTONS[button]) === 0 && (previous & BUTTONS[button]) !== 0; },
};

export const save = {
  load<T>(fallback: T): T {
    const text = host.loadSave();
    if (typeof text !== "string") return fallback;
    try { return JSON.parse(text) as T; } catch { return fallback; }
  },
  store(value: unknown): void { host.writeSave(JSON.stringify(value)); },
};

// Seeded so a run replays exactly; never use Math.random in a game.
let seed = 0x1234abcd;
export const rand = {
  seed(value: number) { seed = value | 1; },
  /** [0, 1) */
  float(): number {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  },
  range(min: number, max: number): number { return min + (max - min) * rand.float(); },
  int(min: number, maxInclusive: number): number { return Math.floor(rand.range(min, maxInclusive + 1)); },
  pick<T>(items: readonly T[]): T { return items[rand.int(0, items.length - 1)]!; },
};

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface Game {
  /** Runs once after load. Spawn the world here. */
  setup?(): void;
  /** Runs at a fixed 60 Hz; `dt` is always 1/60. */
  update(dt: number): void;
  /** Runs after update each frame: hud calls belong here. */
  draw?(): void;
}

export function game(definition: Game): Game { return definition; }

export function __start(definition: Game | undefined): void {
  if (!definition || typeof definition.update !== "function") throw new Error("main.ts must `export default game({ update(dt) { ... } })`");
  definition.setup?.();
  (globalThis as any).__arcade_tick = (bits: number, ax: number, ay: number, rx: number, ry: number, lt: number, rt: number): number => {
    previous = buttons;
    buttons = bits;
    const horizontal = (bits & 8 ? 1 : 0) - (bits & 4 ? 1 : 0);
    const vertical = (bits & 2 ? 1 : 0) - (bits & 1 ? 1 : 0);
    input.x = horizontal || ax;
    input.y = vertical || ay;
    input.rx = rx; input.ry = ry; input.lt = lt; input.rt = rt;
    definition.update(1 / 60);
    definition.draw?.();
    return top;
  };
}
