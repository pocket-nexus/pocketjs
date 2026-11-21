// apps/nexus/toys.ts — the homepage's toys, shared by the Pocket Nexus scenes.
//
// The bag they come out of, their bodies, the arcs out of the pocket, the
// swallow and the spit, the cap on live toys, and the specials that right
// themselves. A scene supplies its geometry (where the pocket and the floor
// are, how high an arc may rise), the nodes a toy wears and how its pocket
// reacts; the core integrates everything between these edges.

import { virtualNow } from "@pocketjs/framework/clock";
import type { Body, Collider, Emitter, ViewSpec, World } from "@pocketjs/framework/physics";
import { DEG, REGULAR, TOYS, clamp, lerp, wrapDeg, type Random, type ToyDef, type ToyType } from "./homepage.ts";

export interface Toy {
  readonly slot: number;
  readonly type: ToyType;
  readonly body: Body;
  /** Radius, px. */
  readonly r: number;
  readonly born: number;
  /** Held at least once: a touched toy dropped in the mouth is swallowed, an untouched one spat out. */
  touched: boolean;
  /** Out of the pocket's walls since it spawned. */
  cleared: boolean;
  /** Fading, swallowed or destroyed. */
  gone: boolean;
  /** The side a special was aimed at; the spit sends it back there. */
  side: number;
  /** Seconds a special has rested tilted. */
  tilted: number;
}

export interface ToyBoxOptions {
  world: World;
  /** Node slots, and the live toys kept before the oldest ordinary one fades out. */
  slots: number;
  live: number;
  /** The views a toy in `slot` wears. */
  views(slot: number): readonly ViewSpec[];
  /** Dress `slot` as `type` at `scale` × the base sprite and show it. */
  show(slot: number, type: ToyType, scale: number): void;
  /** Hide `slot`'s nodes, fading them out over 600 ms or at once. */
  hide(slot: number, fade: boolean): void;
  pocket: Body;
  pocketWall: Collider;
  /** The pocket's centre, mouth line, width and collision pad; the floor line (world px). */
  px: number;
  ptop: number;
  pw: number;
  pad: number;
  floor: number;
  /** Half the room's width at the pocket: how far to the side a toy may land. */
  halfWidth: number;
  /** Base toy radius, the phone scale U and gravity (px/s²). */
  radius: number;
  u: number;
  g: number;
  /** How high a spawn's arc rises above the mouth; `flat` for the intro's specials. */
  apex(r: number, def: ToyDef, flat: boolean): number;
  random: Random;
  later(seconds: number, fn: () => void): void;
  /** Stars off hard floor hits; twinkles rising from a swallow. */
  sparks: Emitter;
  twinkles: Emitter;
  /** The pocket's face: the mouth flash, and happy eyes for `seconds`. */
  flash(): void;
  happy(seconds: number): void;
  isHeld(toy: Toy): boolean;
  /** A toy entered the scene, or left it for good. */
  made?(toy: Toy): void;
  left?(toy: Toy): void;
}

export interface ToyBox {
  readonly toys: readonly (Toy | undefined)[];
  /** The live toy wearing `body`. */
  find(body: Body | undefined): Toy | undefined;
  /** A pop: the next toy out of the bag, arcing to one side of the pocket. */
  pop(): Toy;
  /** An intro special: plops down on the `aim` side and stays near where it lands. */
  plop(type: ToyType, aim: number): Toy;
  /** The homepage's tap on a toy: a jump, a spin and a squash. */
  tap(toy: Toy): void;
  /** Right resting specials and hop the mystery box, every 0.2 s from now on. */
  tend(): void;
  /** The pocket zone's enter handler: a toy that falls into the mouth half a
   *  second after it spawned is swallowed if someone held it, else spat out. */
  enter(body: Body): void;
}

export function createToyBox(o: ToyBoxOptions): ToyBox {
  const { random, u, g } = o;
  const toys: (Toy | undefined)[] = Array.from({ length: o.slots }, () => undefined);
  let spawnCount = 0, sideFlip = 1, mysteryHopAt = 0;
  let bag: ToyType[] = [];

  function nextType(): ToyType {
    spawnCount++;
    const alive = (type: ToyType) => toys.some((t) => t && !t.gone && t.type === type);
    if (spawnCount % 6 === 0 && !alive("pjs")) return "pjs";
    if (spawnCount % 8 === 4 && !alive("mystery")) return "mystery";
    if (bag.length === 0) {
      bag = [...REGULAR];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  }
  /** A free slot; else the oldest leaving toy's, else the oldest ordinary toy's. */
  function freeSlot(): number {
    const free = toys.findIndex((t) => !t);
    if (free >= 0) return free;
    const oldest = (ok: (t: Toy) => boolean) =>
      toys.reduce<Toy | undefined>((best, t) => (t && ok(t) && (!best || t.born < best.born) ? t : best), undefined);
    const toy = oldest((t) => t.gone) ?? oldest((t) => !TOYS[t.type].special) ?? toys[0]!;
    discard(toy);
    return toy.slot;
  }
  function discard(toy: Toy) {
    const first = !toy.gone;
    toy.gone = true;
    if (first) o.left?.(toy);
    toy.body.destroy();
    if (toys[toy.slot] !== toy) return;
    toys[toy.slot] = undefined;
    o.hide(toy.slot, false);
  }
  function fadeOut(toy: Toy) {
    toy.gone = true;
    o.left?.(toy);
    o.hide(toy.slot, true);
    o.later(0.6, () => discard(toy));
  }
  /** Past `live`, the oldest ordinary toy that is not held fades out. */
  function enforceCap() {
    const live = toys.filter((t): t is Toy => !!t && !t.gone).sort((a, b) => a.born - b.born);
    let excess = live.length - o.live;
    for (const toy of live) {
      if (excess <= 0) break;
      if (TOYS[toy.type].special || o.isHeld(toy)) continue;
      fadeOut(toy);
      excess--;
    }
  }
  function make(type: ToyType, x: number, y: number, vx: number, vy: number, spin: number): Toy {
    const def: ToyDef = TOYS[type];
    const slot = freeSlot();
    const r = o.radius * def.size * random.range(0.94, 1.06);
    o.show(slot, type, r / o.radius);
    const inertia = def.box ? (0.42 * 3) / (def.box[0] ** 2 + def.box[1] ** 2) : 0.5 / (0.5 * def.col * def.col);
    const body = o.world.body({
      views: o.views(slot),
      shape: def.box ? { box: [def.box[0] * r, def.box[1] * r], corner: def.box[2] * r } : { circle: def.col * r },
      mass: r * r, inertia,
      restitution: def.restitution, friction: 0.35, bounceSpeed: 110 * u, hitSpeed: 420 * u,
      pickable: true, ghost: o.pocketWall, layer: 1, mask: 7,
      position: [x, y], velocity: [vx, vy], spin, angle: random.range(-20, 20),
      maxSpin: 1600,
      // specials turn upright in the air; resting, tend() hops them upright
      anchor: def.special ? { to: [0, 0], axes: ["angle"], spin: { stiffness: 16, damping: 1.4 }, free: true } : undefined,
      jelly: {
        squash: { stiffness: 900, damping: 20, limit: 0.35, across: 0.65, along: 1, axis: "impact" },
        dent: { gain: 1 / (5200 * u), limit: 0.3 },
        minSpeed: 260 * u,
      },
    });
    const toy: Toy = { slot, type, body, r, born: virtualNow(), touched: false, cleared: false, gone: false, side: 0, tilted: 0 };
    if (type === "mystery") mysteryHopAt = virtualNow() + random.range(4, 8);
    body.onClear(() => { toy.cleared = true; });
    body.onHit((hit) => {
      if (hit.speed > 1100 * u && hit.ny < -0.7) o.sparks.burst(hit.x, hit.y, 3, { angle: -90, spread: 90, speed: 0.35 });
    });
    toys[slot] = toy;
    enforceCap();
    o.made?.(toy);
    return toy;
  }
  /** Out of the mouth on an arc that lands beside the pocket. `aim` in [-1, 1]
   *  picks the side and distance; 0 alternates sides, mostly. */
  function spawn(type: ToyType, aim = 0, flat = false, spinScale = 1): Toy {
    const def: ToyDef = TOYS[type];
    const r = o.radius * def.size;
    const x = o.px + random.range(-0.1, 0.1) * o.pw, y = o.ptop + r * 0.25;
    sideFlip = random() < 0.8 ? -sideFlip : sideFlip;
    const side = aim ? Math.sign(aim) : sideFlip;
    const vy = -Math.sqrt(2 * g * o.apex(r, def, flat));
    const half = o.halfWidth - r - 10, minD = Math.min(half, o.pw / 2 + r + 18);
    const dist = aim ? side * lerp(minD, half, Math.abs(aim)) : side * clamp(random.range(0.18, 0.86) * half, minD, half);
    const dy = o.floor - r - y;
    const tf = (-vy + Math.sqrt(vy * vy + 2 * g * dy)) / g;
    let vx = dist / tf;
    const need = (o.pw / 2 + r + 12) / ((2 * -vy) / g);
    if (Math.abs(vx) < need) vx = side * need;
    const spin = side * (def.special ? random.range(0.5, 2) : random.range(2, 9)) * DEG * spinScale;
    return make(type, x, y, vx, vy, spin);
  }
  function spitOut(toy: Toy) {
    const vy = random.range(700, 860) * u;
    const side = toy.side || (Math.abs(toy.body.x - o.px) > 4 ? Math.sign(toy.body.x - o.px) : random.pick([-1, 1]));
    const need = (o.pw / 2 + toy.r + 16) / ((2 * vy) / g);
    toy.body.teleport(toy.body.x, Math.min(toy.body.y, o.ptop - o.pad - toy.r * 0.6));
    toy.body.setVelocity(side * Math.max(need, random.range(180, 320) * u), -vy, side * random.range(4, 9) * DEG);
    toy.body.kick({ squash: 8 });
    o.pocket.kick({ squash: 7 });
    o.happy(0.35);
    o.flash();
  }
  // into the mouth over 0.38 s: x eases in, y falls as t², the toy turns 6 rad/s and shrinks to half
  function swallow(toy: Toy) {
    toy.gone = true;
    o.left?.(toy);
    const x = toy.body.x, y = toy.body.y;
    const to: [number, number] = [o.px + (x - o.px) * 0.3, o.ptop + toy.r * 1.4];
    toy.body.launch({ from: [x, y], to, duration: 0.38, turn: 6 * 0.38 * DEG, arrive: (2 * (to[1] - y)) / 0.38, endScale: 0.5 });
    toy.body.onLand(() => discard(toy));
    o.pocket.kick({ squash: 5 });
    o.happy(0.8);
    for (let i = 0; i < 5; i++) o.twinkles.burst(o.px + random.range(-0.2, 0.2) * o.pw, o.ptop - 6, 1, { angle: -90, spread: 50, speed: random.range(3, 5) });
  }
  function tendLoop() {
    const step = 0.2;
    o.later(step, () => {
      for (const toy of toys) {
        if (!toy || toy.gone || o.isHeld(toy) || !TOYS[toy.type].special) continue;
        const b = toy.body;
        const off = wrapDeg(b.angle);
        if (b.speed < 45 * u && Math.abs(b.spin) < 1.5 * DEG && Math.abs(off) > 0.45 * DEG) {
          toy.tilted += step;
          if (toy.tilted > 0.8) {
            // a hop whose flight turns it upright
            const vy = 560 * u;
            b.setVelocity(b.vx, -vy, -off / ((2 * vy) / g));
            b.kick({ squash: 3 });
            toy.tilted = 0;
          }
        } else toy.tilted = 0;
        if (toy.type === "mystery" && virtualNow() > mysteryHopAt) {
          mysteryHopAt = virtualNow() + random.range(4, 8);
          const grounded = b.grounded;
          if (grounded >= 0 && grounded < 0.1 && Math.abs(b.vy) < 40) b.setVelocity(b.vx, -random.range(280, 420) * u, b.spin + random.range(-3, 3) * DEG);
        }
      }
      tendLoop();
    });
  }

  return {
    toys,
    find: (body) => (body ? toys.find((t) => t?.body === body && !t.gone) : undefined),
    pop: () => spawn(nextType()),
    plop(type, aim) {
      o.pocket.kick({ squash: -11 });
      o.flash();
      o.happy(0.5);
      spawnCount++;
      const toy = spawn(type, aim, true, 0.4);
      toy.side = Math.sign(aim);
      toy.body.settle(0.22, 0.15);
      return toy;
    },
    tap(toy) {
      const b = toy.body;
      if (toy.type === "mystery") {
        b.setVelocity(b.vx, Math.min(b.vy, -330 * u), b.spin + random.range(-120, 120));
        b.kick({ spin: random.pick([-1, 1]) * 400 });
      } else if (toy.type === "pjs") {
        // the homepage opens PocketJS on this tap; a scene without a browser keeps the hop
        b.setVelocity(b.vx, Math.min(b.vy, -320 * u), b.spin);
        b.kick({ squash: 8 });
      } else {
        b.setVelocity(b.vx, Math.min(b.vy, -620 * u), b.spin + random.range(-570, 570));
        b.kick({ squash: 8 });
      }
    },
    tend: tendLoop,
    enter(body) {
      const toy = toys.find((t) => t?.body === body);
      if (!toy || !toy.cleared || toy.gone || virtualNow() - toy.born <= 0.5) return;
      if (toy.touched) swallow(toy);
      else spitOut(toy);
    },
  };
}
