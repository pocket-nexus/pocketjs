// Endless Runner's gameplay over the playset kernels, ported from GameBlocks'
// endless-runner demo (https://gb-endless-runner.vercel.app/, MIT,
// xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the runner (motion.lanes: forward at the slot's
//     SPEED, the lane glide, the jump under gravity, the ground), the coins'
//     spin and the runner's bob (joint drivers), the chase camera, the
//     snowfall (a trail emitter on a slot riding ahead of the runner), the
//     wind loop that follows the speed (the runner's hum);
//   here, at event rate — the course: obstacle sets, coin runs, boosts and
//     scenery spawned ahead from the demo's seeded generator (every random
//     draw in the demo's order, so the course is the demo's) and removed
//     behind; the speed ramp and boost; scoring;
//   here, every frame — the demo's box tests against the few obstacles and
//     items within reach, and the slide (the runner swaps to a squashed copy
//     of its model);
//   here, every third frame — the autopilot (ai.ts).
//
// Coordinates: the demo's right/up/forward basis maps to x, y and -z.
//
// Deviations: the view reaches 100 m (the demo's fog ends at 185 m); the
// lane glide is linear at 20 m/s instead of an exponential damp; the
// runner bobs in the air too; shadows are blobs; a crash and a pickup add a
// small burst; the track is recycled in 34 m pieces; the first 160 m are a
// warm-up with coins and no obstacles (the course after it is the demo's,
// every random draw included); items, obstacles and scenery are drawn with
// low-poly stand-ins until they come within 30, 40 and 45 m.

import { BTN } from "@pocketjs/framework/input";
import { ENT, STATE, createPlayset, joint, motion, sfx, type Archetype, type Emitter, type Playset, type Sound } from "@pocketjs/framework/playset";
import { mulberry, type Random } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { COMMAND, RunnerAi, type RunnerView } from "./ai.ts";
import * as V from "./visuals.ts";

const DT = 1 / 60;
const PLAYER_BASE_HEIGHT = 1.7;
const PLAYER_SLIDE_HEIGHT = 0.9;
const PLAYER_WIDTH = 1.05;
const PLAYER_DEPTH = 0.9;
const COIN_SCORE = 75;
const OBSTACLE_TYPES: readonly V.ObstacleType[] = ["block", "barrier", "lowBeam"];
const MAX_OBSTACLES = 64;
const MAX_ITEMS = 128;
const MAX_PROPS = 96;
/** Closer than this, items and scenery switch to their full models. */
const NEAR_ITEMS = 30;
const NEAR_PROPS = 45;
const NEAR_OBSTACLES = 40;
/** The first 160 m carry coins and no obstacles: about twelve seconds to start. */
const WARMUP = 160;

export type Status = "title" | "playing" | "gameover";

/** The other lane: `k` 0 or 1 picks among the two that are not `blocked`. */
const otherLane = (blocked: number, k: number) => (k < blocked ? k : k + 1);

export class EndlessRunner implements RunnerView {
  readonly play: Playset;
  status: Status = "title";
  demo = true;
  player = -1;
  score = 0;
  coins = 0;
  speed = 11;
  effectiveSpeed = 11;
  boostTimer = 0;
  slideTimer = 0;
  targetLane = 1;
  grounded = true;
  forward = 0;
  // the course near the runner, as flat arrays the autopilot also reads
  obstacleCount = 0;
  readonly obstacleLane = new Int8Array(MAX_OBSTACLES);
  readonly obstacleType = new Int8Array(MAX_OBSTACLES);
  readonly obstacleForward = new Float32Array(MAX_OBSTACLES);
  readonly obstacleAlive = new Uint8Array(MAX_OBSTACLES);
  private readonly obstacleSlot = new Int32Array(MAX_OBSTACLES);
  private readonly obstacleNear = new Uint8Array(MAX_OBSTACLES);
  itemCount = 0;
  readonly itemLane = new Int8Array(MAX_ITEMS);
  readonly itemType = new Int8Array(MAX_ITEMS);
  readonly itemForward = new Float32Array(MAX_ITEMS);
  readonly itemActive = new Uint8Array(MAX_ITEMS);
  private readonly itemSlot = new Int32Array(MAX_ITEMS);
  private readonly itemNear = new Uint8Array(MAX_ITEMS);
  private propCount = 0;
  private readonly propForward = new Float32Array(MAX_PROPS);
  private readonly propSlot = new Int32Array(MAX_PROPS);
  private readonly propKind = new Int8Array(MAX_PROPS);
  private readonly propX = new Float32Array(MAX_PROPS);
  private readonly propYaw = new Float32Array(MAX_PROPS);
  private readonly propScale = new Float32Array(MAX_PROPS);
  private readonly propNear = new Uint8Array(MAX_PROPS);

  private random: Random = mulberry(20260617);
  private nextSpawn = 26;
  private nextScenery = 10;
  private readonly ai = new RunnerAi();
  private aiTick = 0;
  private framesInRun = 0;
  private wasX = 0;
  private wasY = 0;
  private wasX0 = 0;
  private squash = -1;
  private overAt = -1;
  private checkpoint = 500;
  private stepClock = 0;
  private readonly runnerArch: Archetype;
  private readonly squashArch: Archetype;
  private readonly snowArch: Archetype;
  private readonly obstacleArch: Archetype[];
  private readonly obstacleFarArch: Archetype[];
  private readonly coinArch: Archetype;
  private readonly boostArch: Archetype;
  private readonly coinFarArch: Archetype;
  private readonly boostFarArch: Archetype;
  /** scenery kinds: six trees (three crowns, two sizes), the arch for each
   *  side, the beacon, mounds with two to four gifts; and their far models */
  private readonly sceneryNear: Archetype[] = [];
  private readonly sceneryFar: Archetype[] = [];
  private readonly segments: { node: number; start: number }[] = [];
  private readonly sounds: Record<string, Sound>;
  private readonly sparkle: Emitter;
  private readonly puff: Emitter;

  constructor() {
    const play = createPlayset({ capacity: 320, particles: 320, seed: 20260617 });
    this.play = play;
    play.gravity(28);
    play.sky(V.SKY, V.SKY, V.SKY);
    play.fog(V.SKY, 34, 100, 1);
    // three.js r161 physical lights over pi: hemisphere 1.95 (plus the rim
    // light folded in), sun 2.2 from behind the left shoulder
    play.light({ sun: [-14, 24, 18], sunColor: 0xfff7df, sunIntensity: 2.2 / Math.PI, sky: 0xffffff, ground: 0x8eb7c7, ambient: (1.95 + 0.5) / Math.PI });

    // the track: five 34 m pieces leapfrogging ahead of the runner
    for (let j = 0; j < V.SEGMENTS; j++) {
      const start = -60 + j * V.SEGMENT;
      const node = play.place(play.model(V.trackSegment(start)), [0, 0, -start], { static: false });
      this.segments.push({ node, start });
    }

    this.sounds = {
      jump: play.sound(sfx.jump()),
      slide: play.sound({ ...sfx.whoosh(), volume: 0.32 }),
      lane: play.sound({ ...sfx.whoosh(), freq: 900, to: 2200, sustain: 0.02, decay: 0.08, volume: 0.16 }),
      coin: play.sound(sfx.coin()),
      boost: play.sound(sfx.powerup()),
      crash: play.sound({ ...sfx.crumble(), volume: 0.6 }),
      hurt: play.sound(sfx.hurt()),
      land: play.sound({ ...sfx.land(), volume: 0.22 }),
      step: play.sound({ ...sfx.step(), volume: 0.12 }),
      checkpoint: play.sound(sfx.checkpoint()),
      lose: play.sound(sfx.lose()),
    };
    const wind = play.sound({ ...sfx.wind(), volume: 0.2 });
    this.sparkle = play.emitter({ count: 8, life: 0.4, speed: 3, spread: Math.PI, size: [0.14, 0.02], color: [0xfff3a6, 0xffd166], alpha: [1, 0], blend: "add", drag: 2 });
    this.puff = play.emitter({ count: 26, life: 0.7, speed: 4.5, spread: Math.PI, size: [0.35, 0.1], color: [0xffffff, 0xd7effa], alpha: [0.95, 0], blend: "alpha", drag: 2.5, gravity: 0.2 });
    const snow = play.emitter({ count: 1, life: 4.4, lifeJitter: 0.6, speed: 1.6, speedJitter: 0.5, spread: 0.25, dir: [0, -1, 0], size: 0.08, color: 0xffffff, alpha: 0.8, blend: "alpha", drag: 0, radius: 17 });

    const bob = joint.bob("body", 0.035);
    this.runnerArch = play.archetype({
      model: play.model(V.runner()),
      motion: motion.lanes({ speed: 11, accel: 0, maxSpeed: 1000, laneWidth: 3.2, lanes: 3, laneRate: 20, jump: 11.5, gravity: 1, slide: 0 }),
      ground: "gravity",
      joints: [bob],
      shadow: 0.75,
      hum: { sound: wind, speed: 30, pitch: 1.5 },
    });
    this.squashArch = play.archetype({ model: play.model(V.runner(0.55)), motion: motion.attached(), joints: [bob], shadow: 0.75 });
    this.snowArch = play.archetype({ motion: motion.attached(), hidden: true, trail: snow, trailRate: 30 });
    this.obstacleArch = OBSTACLE_TYPES.map((t) => play.archetype({ model: play.model(V.obstacle(t)), shadow: t === "lowBeam" ? 1 : 0.85 }));
    this.obstacleFarArch = OBSTACLE_TYPES.map((t) => play.archetype({ model: play.model(V.obstacleFar(t)) }));
    const spinning = [joint.spin("spin", "y", 4.8)];
    this.coinArch = play.archetype({ model: play.model(V.coin()), joints: spinning, shadow: 0.3, death: this.sparkle });
    this.boostArch = play.archetype({ model: play.model(V.boost()), joints: spinning, shadow: 0.4, death: this.sparkle });
    this.coinFarArch = play.archetype({ model: play.model(V.coinFar()) });
    this.boostFarArch = play.archetype({ model: play.model(V.boostFar()), joints: spinning });
    const shapes = mulberry(7);
    const crowns = [V.MAT.treeA, V.MAT.treeB, V.MAT.treeC];
    for (const crown of crowns) {
      const far = play.archetype({ model: play.model(V.treeFar(crown)) });
      for (const large of [false, true]) {
        this.sceneryNear.push(play.archetype({ model: play.model(V.canopyTree(shapes, crown, large)) }));
        this.sceneryFar.push(far);
      }
    }
    const archFar = play.archetype({ model: play.model(V.archFar()) });
    for (const side of [-1, 1]) {
      this.sceneryNear.push(play.archetype({ model: play.model(V.candyArch(side)) }));
      this.sceneryFar.push(archFar);
    }
    this.sceneryNear.push(play.archetype({ model: play.model(V.beacon()) }));
    this.sceneryFar.push(play.archetype({ model: play.model(V.beaconFar()) }));
    const clusterFar = play.archetype({ model: play.model(V.clusterFar()) });
    for (const g of [2, 3, 4]) {
      this.sceneryNear.push(play.archetype({ model: play.model(V.rockCluster(shapes, g)) }));
      this.sceneryFar.push(clusterFar);
    }
    this.reset(true);
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.status = demo ? "title" : "playing";
    this.demo = demo;
    this.score = 0;
    this.coins = 0;
    this.speed = 11;
    this.effectiveSpeed = 11;
    this.boostTimer = 0;
    this.slideTimer = 0;
    this.targetLane = 1;
    this.grounded = true;
    this.forward = 0;
    this.obstacleCount = 0;
    this.itemCount = 0;
    this.propCount = 0;
    this.nextSpawn = 26;
    this.nextScenery = 10;
    this.random = mulberry(20260617);
    this.ai.reset();
    this.framesInRun = 0;
    this.overAt = -1;
    this.checkpoint = 500;
    this.wasX = this.wasY = this.wasX0 = 0;
    this.player = play.spawn(this.runnerArch, 0, 0, 0, 0);
    play.ent[this.player * 16 + ENT.SPEED] = 11;
    this.squash = play.spawn(this.squashArch, 0, 0, 0, 0);
    play.attach(this.squash, this.player, [0, 0, 0]);
    this.setHidden(this.squash, true);
    const snow = play.spawn(this.snowArch, 0, 14, -28, 0);
    play.attach(snow, this.player, [0, 14, -30]);
    for (let j = 0; j < this.segments.length; j++) {
      const s = this.segments[j];
      s.start = -60 + j * V.SEGMENT;
      play.move(s.node, 0, 0, -s.start);
    }
    // the demo's PositionFollowCameraRig: 11 back, 6.4 up, looking 1.2 above
    play.followCamera(this.player, { offset: [0, 6.4, 11], lookAhead: 0, lookUp: 1.2, heading: false, fov: 62, far: 100, smooth: 1 / 0.06, smoothLook: 1 / 0.04 });
  }

  private setHidden(slot: number, hidden: boolean): void {
    const o = slot * 16 + ENT.STATE;
    const s = this.play.ent[o];
    this.play.ent[o] = hidden ? s | STATE.HIDDEN : s & ~STATE.HIDDEN;
  }

  // --- the course: World.spawnSet / spawnScenery with the demo's draws ------

  private addObstacle(lane: number, forward: number, type: number): void {
    // the warm-up stretch: its draws are made, its obstacles are not placed
    if (forward < WARMUP || this.obstacleCount >= MAX_OBSTACLES) return;
    const cfg = V.OBSTACLES[OBSTACLE_TYPES[type]];
    const slot = this.play.spawn(this.obstacleFarArch[type], V.LANES[lane], cfg.height, -forward, 0);
    if (slot < 0) return;
    const i = this.obstacleCount++;
    this.obstacleNear[i] = 0;
    this.obstacleLane[i] = lane;
    this.obstacleType[i] = type;
    this.obstacleForward[i] = forward;
    this.obstacleAlive[i] = 1;
    this.obstacleSlot[i] = slot;
  }

  private addItem(lane: number, forward: number, boost: boolean): void {
    if (this.itemCount >= MAX_ITEMS) return;
    const slot = this.play.spawn(boost ? this.boostFarArch : this.coinFarArch, V.LANES[lane], boost ? 0.72 : 0.75, -forward, 0);
    if (slot < 0) return;
    const i = this.itemCount++;
    this.itemLane[i] = lane;
    this.itemType[i] = boost ? 1 : 0;
    this.itemForward[i] = forward;
    this.itemActive[i] = 1;
    this.itemSlot[i] = slot;
    this.itemNear[i] = 0;
  }

  /** Items and scenery coming within reach take their full models. */
  private nearer(pf: number): void {
    const play = this.play;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.itemNear[i] || !this.itemActive[i] || this.itemForward[i] - pf > NEAR_ITEMS) continue;
      play.kill(this.itemSlot[i]);
      const boost = this.itemType[i] === 1;
      const slot = play.spawn(boost ? this.boostArch : this.coinArch, V.LANES[this.itemLane[i]], boost ? 0.72 : 0.75, -this.itemForward[i], 0);
      this.itemNear[i] = 1;
      if (slot < 0) {
        this.itemActive[i] = 0;
        continue;
      }
      this.itemSlot[i] = slot;
      // the demo starts each ornament's spin at a random phase
      play.joints[slot * 4] = Math.random() * Math.PI * 2;
    }
    if (this.framesInRun % 4 !== 0) return;
    for (let i = 0; i < this.obstacleCount; i++) {
      if (this.obstacleNear[i] || this.obstacleForward[i] - pf > NEAR_OBSTACLES) continue;
      play.kill(this.obstacleSlot[i]);
      const t = this.obstacleType[i];
      this.obstacleSlot[i] = play.spawn(this.obstacleArch[t], V.LANES[this.obstacleLane[i]], V.OBSTACLES[OBSTACLE_TYPES[t]].height, -this.obstacleForward[i], 0);
      this.obstacleNear[i] = 1;
    }
    for (let i = 0; i < this.propCount; i++) {
      if (this.propNear[i] || this.propForward[i] - pf > NEAR_PROPS) continue;
      play.kill(this.propSlot[i]);
      const slot = play.spawn(this.sceneryNear[this.propKind[i]], this.propX[i], 0, -this.propForward[i], this.propYaw[i]);
      this.propNear[i] = 1;
      this.propSlot[i] = slot;
      if (slot >= 0) play.look[slot * 4] = this.propScale[i];
    }
  }

  private spawnSet(forward: number, speed: number): void {
    const r = this.random;
    const blocked = r.int(0, 2);
    const type = Math.floor(r() * 3);
    this.addObstacle(blocked, forward, type);
    if (speed > 15 && r() > 0.48) {
      const second = otherLane(blocked, Math.floor(r() * 2));
      const at = forward + r.uniform(1.6, 3.2);
      this.addObstacle(second, at, Math.floor(r() * 2));
    }
    const lane = otherLane(blocked, Math.floor(r() * 2));
    const boost = r() > 0.84;
    const count = boost ? 1 : r.int(2, 5);
    for (let i = 0; i < count; i++) this.addItem(lane, forward + 3 + i * 2.1, boost);
  }

  private spawnScenery(forward: number): void {
    const r = this.random;
    for (let side = -1; side <= 1; side += 2) {
      if (r() < 0.2) continue;
      const right = side * r.uniform(8.5, 24);
      const variant = r();
      let kind: number;
      let scale = 1;
      if (variant < 0.38) {
        r.uniform(1.35, 1.75); // trunk height
        const crown = Math.floor(r() * 3);
        const tier = r.uniform(0.85, 1.25);
        r.uniform(0.62, 0.95);
        r.uniform(0.38, 0.62);
        for (let k = 0; k < 4; k++) {
          r();
          r.uniform(0, Math.PI * 2);
          r.uniform(0.28, 0.66);
          r.uniform(1.65, 2.35);
        }
        scale = r.uniform(0.82, 1.18);
        kind = crown * 2 + (tier > 1.05 ? 1 : 0);
      } else if (variant < 0.58) {
        kind = side < 0 ? 6 : 7;
      } else if (variant < 0.76) {
        kind = 8;
      } else {
        const gifts = r.int(2, 4);
        for (let k = 0; k < gifts * 5 + 6; k++) r();
        kind = 9 + gifts - 2;
      }
      const at = forward + r.uniform(-2, 2);
      const yaw = side < 0 ? r.uniform(-0.15, 0.35) : r.uniform(-0.35, 0.15);
      if (this.propCount >= MAX_PROPS) continue;
      const slot = this.play.spawn(this.sceneryFar[kind], right, 0, -at, yaw);
      if (slot < 0) continue;
      this.play.look[slot * 4] = scale;
      const i = this.propCount++;
      this.propForward[i] = at;
      this.propSlot[i] = slot;
      this.propKind[i] = kind;
      this.propX[i] = right;
      this.propYaw[i] = yaw;
      this.propScale[i] = scale;
      this.propNear[i] = 0;
    }
  }

  /** World.pruneBehind: everything more than 18 m behind goes. */
  private prune(min: number): void {
    const play = this.play;
    let n = 0;
    for (let i = 0; i < this.obstacleCount; i++) {
      if (this.obstacleForward[i] > min) {
        if (n !== i) {
          this.obstacleLane[n] = this.obstacleLane[i];
          this.obstacleType[n] = this.obstacleType[i];
          this.obstacleForward[n] = this.obstacleForward[i];
          this.obstacleAlive[n] = this.obstacleAlive[i];
          this.obstacleSlot[n] = this.obstacleSlot[i];
          this.obstacleNear[n] = this.obstacleNear[i];
        }
        n++;
      } else if (this.obstacleSlot[i] >= 0) play.kill(this.obstacleSlot[i]);
    }
    this.obstacleCount = n;
    n = 0;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.itemForward[i] > min && this.itemActive[i]) {
        if (n !== i) {
          this.itemLane[n] = this.itemLane[i];
          this.itemType[n] = this.itemType[i];
          this.itemForward[n] = this.itemForward[i];
          this.itemActive[n] = 1;
          this.itemSlot[n] = this.itemSlot[i];
          this.itemNear[n] = this.itemNear[i];
        }
        n++;
      } else if (this.itemActive[i]) play.kill(this.itemSlot[i]);
    }
    this.itemCount = n;
    n = 0;
    for (let i = 0; i < this.propCount; i++) {
      if (this.propForward[i] > min) {
        if (n !== i) {
          this.propForward[n] = this.propForward[i];
          this.propSlot[n] = this.propSlot[i];
          this.propKind[n] = this.propKind[i];
          this.propX[n] = this.propX[i];
          this.propYaw[n] = this.propYaw[i];
          this.propScale[n] = this.propScale[i];
          this.propNear[n] = this.propNear[i];
        }
        n++;
      } else if (this.propSlot[i] >= 0) play.kill(this.propSlot[i]);
    }
    this.propCount = n;
  }

  // --- the frame ----------------------------------------------------------------

  frame(pad: Pad): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player;
    const o = p * 16;
    const running = this.status === "playing" || (this.status === "title" && this.demo && this.overAt < 0);
    this.framesInRun++;
    let lane = 0;
    let jump = 0;
    if (running) {
      let command: number = COMMAND.none;
      if (this.demo) {
        if (this.aiTick++ % 3 === 0) command = this.ai.decide(this, 3 * DT);
      } else {
        const pressed = this.framesInRun > 2 ? pad.pressed : 0;
        const x = pad.x > 0.5 ? 1 : pad.x < -0.5 ? -1 : 0;
        const y = pad.y > 0.5 ? 1 : pad.y < -0.5 ? -1 : 0;
        if (x !== 0 && x !== this.wasX) command = x > 0 ? COMMAND.right : COMMAND.left;
        else if ((y > 0 && this.wasY <= 0) || pressed & BTN.CIRCLE) command = COMMAND.jump;
        else if ((y < 0 && this.wasY >= 0) || pressed & BTN.CROSS) command = COMMAND.slide;
        this.wasX = x;
        this.wasY = y;
      }
      if (command === COMMAND.left || command === COMMAND.right) {
        const next = Math.max(0, Math.min(2, this.targetLane + (command === COMMAND.right ? 1 : -1)));
        if (next !== this.targetLane) {
          this.targetLane = next;
          // one frame of stick: the kernel changes lane on the press edge
          lane = command === COMMAND.right ? 1 : -1;
          play.play(this.sounds.lane, 0.8);
        }
      } else if (command === COMMAND.jump) {
        if (this.grounded && this.slideTimer <= 0) {
          jump = 1;
          play.play(this.sounds.jump);
        }
      } else if (command === COMMAND.slide && this.grounded) {
        if (this.slideTimer <= 0) play.play(this.sounds.slide);
        this.slideTimer = 0.72;
      }
      this.boostTimer = Math.max(0, this.boostTimer - DT);
      this.speed += 0.19 * DT;
      this.effectiveSpeed = this.speed * (this.boostTimer > 0 ? 1.45 : 1);
      ent[o + ENT.SPEED] = this.effectiveSpeed;
    } else {
      ent[o + ENT.SPEED] = 0;
    }
    // the kernel's own edge detection needs the stick to return to centre
    if (lane !== 0 && this.wasX0 !== 0) lane = 0;
    this.wasX0 = lane;
    play.steer(p, lane, 0);
    play.buttons(p, 0, 0, jump, 0);
    const before = this.forward;
    const airborne = !this.grounded;
    const fallSpeed = -ent[o + ENT.VY];
    play.frame(DT);
    this.forward = -ent[o + ENT.Z];
    this.grounded = (ent[o + ENT.STATE] & STATE.GROUNDED) !== 0;
    // the slide: squashed model, low box
    if (this.slideTimer > 0) this.slideTimer = Math.max(0, this.slideTimer - (running ? DT : 0));
    const sliding = this.slideTimer > 0;
    this.setHidden(p, sliding);
    this.setHidden(this.squash, !sliding);
    if (!running) return;
    if (airborne && this.grounded && fallSpeed > 4) play.play(this.sounds.land);
    if (this.grounded && !sliding) {
      this.stepClock += DT * 12;
      if (this.stepClock > Math.PI) {
        this.stepClock -= Math.PI;
        play.play(this.sounds.step, 1, 0.9 + Math.random() * 0.2);
      }
    }
    const delta = this.forward - before;
    this.score += delta * 8;
    if (this.forward >= this.checkpoint) {
      this.checkpoint += 500;
      play.play(this.sounds.checkpoint, 0.7);
    }
    this.world(this.forward);
    this.collide(ent[o], ent[o + 1], sliding);
  }

  /** World.update: spawn ahead, recycle the track, prune behind. */
  private world(pf: number): void {
    while (this.nextSpawn < pf + 145) {
      this.spawnSet(this.nextSpawn, this.effectiveSpeed);
      this.nextSpawn += this.random.uniform(7.5, 13.5);
    }
    while (this.nextScenery < pf + 160) {
      this.spawnScenery(this.nextScenery);
      this.nextScenery += this.random.uniform(7, 13);
    }
    for (let j = 0; j < this.segments.length; j++) {
      const s = this.segments[j];
      if (s.start + V.SEGMENT < pf - 25) {
        s.start += V.SEGMENT * this.segments.length;
        this.play.move(s.node, 0, 0, -s.start);
      }
    }
    if (this.framesInRun % 10 === 0) this.prune(pf - 18);
    this.nearer(pf);
  }

  /** Game.resolveCollisions: the demo's box overlap against what is in reach. */
  private collide(x: number, y: number, sliding: boolean): void {
    const pf = this.forward;
    const top = y + (sliding ? PLAYER_SLIDE_HEIGHT : PLAYER_BASE_HEIGHT);
    const pr0 = x - PLAYER_WIDTH * 0.5, pr1 = x + PLAYER_WIDTH * 0.5;
    const pf0 = pf - PLAYER_DEPTH * 0.5, pf1 = pf + PLAYER_DEPTH * 0.5;
    const lanes = V.LANES;
    for (let i = 0; i < this.obstacleCount; i++) {
      const f = this.obstacleForward[i];
      if (f < pf - 2 || f > pf + 2) continue;
      const cfg = V.OBSTACLES[OBSTACLE_TYPES[this.obstacleType[i]]];
      const lx = lanes[this.obstacleLane[i]];
      const s = cfg.size;
      if (pr0 <= lx + s.right * 0.5 && pr1 >= lx - s.right * 0.5 && y <= cfg.height + s.up && top >= cfg.height && pf0 <= f + s.forward * 0.5 && pf1 >= f - s.forward * 0.5) {
        this.crash();
        return;
      }
    }
    for (let i = 0; i < this.itemCount; i++) {
      if (!this.itemActive[i]) continue;
      const f = this.itemForward[i];
      if (f < pf - 2 || f > pf + 2) continue;
      const lx = lanes[this.itemLane[i]];
      const h = this.itemType[i] ? 0.72 : 0.75;
      if (pr0 <= lx + 0.45 && pr1 >= lx - 0.45 && y <= h + 0.9 && top >= h && pf0 <= f + 0.45 && pf1 >= f - 0.45) {
        this.itemActive[i] = 0;
        this.play.kill(this.itemSlot[i], "effects");
        if (this.itemType[i]) {
          this.boostTimer = 3.5;
          this.score += 250;
          this.play.play(this.sounds.boost);
        } else {
          this.coins += 1;
          this.score += COIN_SCORE;
          this.play.play(this.sounds.coin, 0.8);
        }
      }
    }
  }

  private crash(): void {
    const play = this.play;
    const o = this.player * 16;
    play.ent[o + ENT.SPEED] = 0;
    play.ent[o + ENT.STATE] = play.ent[o + ENT.STATE] | STATE.FROZEN;
    play.burst(this.puff, play.ent[o], play.ent[o + 1] + 1, play.ent[o + 2] - 0.6);
    play.shake(0.6);
    play.play(this.sounds.crash);
    play.play(this.sounds.hurt, 0.8);
    play.play(this.sounds.lose, 0.6);
    this.overAt = play.tick;
    if (!this.demo) this.status = "gameover";
  }

  /** The demo's attract loop: a crashed demo restarts two seconds later. */
  tickDemo(): void {
    if (this.demo && this.overAt >= 0 && this.play.tick - this.overAt > 120) this.reset(true);
  }
}

const grouped = (n: number) => {
  const s = String(Math.floor(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
};

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new EndlessRunner();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  return {
    title: "Endless Runner",
    tagline: "Survive as long as possible: collect coins and boosts,\nand dodge every obstacle on the snowy road.",
    accent: "#d92c3a",
    controls: [
      ["Circle Pad / D-Pad", "Change lane"],
      ["Up / A", "Jump"],
      ["Down / B", "Slide"],
      ["START", "Pause"],
      ["Y", "Developer stats"],
    ],
    readouts: [
      { label: "Score", value: () => grouped(game.score) },
      { label: "Coins", value: () => game.coins },
      { label: "Speed", value: () => `${(game.effectiveSpeed / 10).toFixed(1)}x`, bar: () => Math.min(1, (game.effectiveSpeed - 11) / 30), color: "#58a6ff" },
      { label: "Boost", value: () => (game.boostTimer > 0 ? `${game.boostTimer.toFixed(1)} s` : "-"), bar: () => game.boostTimer / 3.5, color: "#ffd166" },
      { label: "Distance", value: () => `${Math.floor(game.forward)} m` },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.status === "title") return "title";
      if (game.status === "gameover") return "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.reset(demo);
      if (!demo) game.status = "playing";
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      game.tickDemo();
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => `SCORE ${grouped(game.score)}    COINS ${game.coins}    SPEED ${(game.effectiveSpeed / 10).toFixed(1)}x`,
    result: () => `Score ${grouped(game.score)} · ${game.coins} coins · ${Math.floor(game.forward)} m`,
  };
}
