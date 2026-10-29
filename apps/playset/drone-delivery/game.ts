// Drone Delivery's gameplay over the playset kernels, ported from GameBlocks'
// drone-delivery demo (https://gb-drone-delivery.vercel.app/, MIT,
// xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the drone (hover kernel: heading-relative strafe and
//     forward toward a target velocity, vertical thrust, yaw, the 2.6..86 m
//     band), the four rotor joints, the 36 traffic cars (linear kernel,
//     wrapping at the world's edge), the eight birds (path kernel on their
//     circles), the drone's contacts with cars and birds (rules: damage per
//     contact step, the birds push), the carried package (attached), the chase
//     camera, the rotor hum, the static city in per-cell batches;
//   here, every frame — Drone.update's battery drain, brake damping, height
//     band and world-edge rules, the building collisions (a 25 m grid of the
//     demo's boxes), the crane and power-line hazards, the demo's lean from
//     velocity, MissionManager (timer, pickup, delivery, mission score);
//   here, on a budget — the demo autopilot (player-ai.js) every 3rd frame,
//     the waypoint arrow every 2nd.
//
// Deviations: the demo integrates stick input as acceleration under
// damping; the hover kernel approaches the stick's velocity at the same
// 31 m/s² and damps the same 0.55/s with the stick released, which plays the
// same at full stick. The autopilot keeps the demo's acceleration model: it
// adds its acceleration to the drone's velocity after the step and the kernel
// only damps, yaws and lifts. Its cruise-phase rule (no forward speed while
// low) also holds on the approach to a rooftop, so it climbs before it closes
// in on a building it would otherwise fly into. The safe delivery anchor is
// found once per mission against the buildings near the pad. The DOM
// waypoint arrow is a chevron over the drone; the minimap is left out.

import {
  ENT,
  STATE,
  createPlayset,
  joint,
  layers,
  motion,
  sfx,
  type Archetype,
  type Playset,
  type Sound,
} from "@pocketjs/framework/playset";
import { PLAYSET_NODE } from "../../../contracts/spec/playset.ts";
import { BTN } from "@pocketjs/framework/input";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

const L = layers("drone", "traffic", "bird", "cargo");

const ACCEL = 31;
const MAX_SPEED = 36;
const DAMPING = 0.55;
const BRAKE_DAMPING = 5.8;
const YAW_RATE = 2.45;
const MIN_HEIGHT = 2.6;
const MAX_HEIGHT = 86;
const DRONE_RADIUS = 2.2;
const START: [number, number, number] = [-75, 78, -75];
const START_YAW = -2.36;
const GRID = 25;
const GRID_HALF = 300;
const GRID_N = (GRID_HALF * 2) / GRID;
const ROAD_PIECE = 60;
const SIDEWALK_REACH = 180;

export type Status = "title" | "playing" | "gameover";

/** The demo's controls: 0..1 per direction, brake held. */
interface Controls {
  forward: number;
  backward: number;
  left: number;
  right: number;
  up: number;
  down: number;
  rotateLeft: number;
  rotateRight: number;
  brake: boolean;
}

const emptyControls = (c: Controls): Controls => {
  c.forward = c.backward = c.left = c.right = c.up = c.down = c.rotateLeft = c.rotateRight = 0;
  c.brake = false;
  return c;
};

export interface Hud {
  status: Status;
  demo: boolean;
  mission: number;
  timer: number;
  timerMax: number;
  battery: number;
  damage: number;
  score: number;
  carrying: boolean;
  distance: number;
  speed: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class DroneDelivery {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, mission: 1, timer: 150, timerMax: 150, battery: 100, damage: 0, score: 0, carrying: false, distance: 0, speed: 0 };
  readonly plan = V.cityPlan();
  drone = -1;
  private readonly droneArch: Archetype;
  private readonly crateArch: Archetype;
  private readonly trafficArchs: Archetype[] = [];
  private readonly birdArchs: Archetype[] = [];
  private crate = -1;
  private pad = -1;
  private arrowPick = -1;
  private arrowDrop = -1;
  /** waiting | carried | delivered */
  private pkgState: 0 | 1 | 2 = 0;
  private pickup: [number, number, number] = [0, 0, 0];
  private dropoff: [number, number, number] = [0, 0, 0];
  private anchor: [number, number, number] = [0, 0, 0];
  private missionIndex = 0;
  private active = true;
  private aiTick = 0;
  private readonly controls: Controls = emptyControls({} as Controls);
  private readonly ai: Controls = emptyControls({} as Controls);
  /** the autopilot's horizontal acceleration, world m/s², held between its runs */
  private aiAx = 0;
  private aiAz = 0;
  private note = "";
  private noteTime = 0;
  private bumpCooldown = 0;
  private hurtCooldown = 0;
  private lastHp = 100;
  private lowBattery = 0;
  private lastSecond = 0;
  // the buildings as flat boxes and a 25 m grid over them
  private readonly boxes: Float32Array;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  /** crane and power-line hazards: x, y, z, radius, damage */
  private readonly hazards: Float32Array;
  private readonly hazardCount: number;
  private readonly boom: { id: number };
  private readonly sounds: Record<"pickup" | "deliver" | "mission" | "fail" | "bump" | "hurt" | "alarm" | "tick", Sound>;

  constructor() {
    const play = createPlayset({ capacity: 96, particles: 300, seed: 42, lod: [10, 6, 12] });
    this.play = play;
    play.sky(V.COLORS.sky, V.COLORS.skyHorizon, V.COLORS.skyLow);
    play.fog(V.COLORS.fog, V.CFG.fogNear, V.CFG.fogFar, 1);
    // HemisphereLight(0xe5f7ff, 0x2c4034) and the sun at (-58, 92, 46)
    play.light({ sun: [-58, 92, -46], sunColor: 0xffedc5, sunIntensity: 1.55, sky: 0xe5f7ff, ground: 0x2c4034, ambient: 0.95 });
    play.gravity(0);
    const half = V.CFG.halfWorld;
    play.bounds(-half, half, -half, half, -20, 200);
    // the grass plane as a flat heightfield of 30 m cells: a ground quad that
    // reaches far behind the camera is not drawn, so no quad is large
    play.terrain({ size: V.CFG.worldSize, resolution: 25, height: () => 0, bands: [[-1, V.COLORS.grass]] });

    this.buildCity();
    // the grid of building boxes for the drone's collisions and the autopilot
    const bs = this.plan.buildings;
    this.boxes = new Float32Array(bs.length * 6);
    const lists: number[][] = Array.from({ length: GRID_N * GRID_N }, () => []);
    bs.forEach((b, i) => {
      this.boxes.set([b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]], i * 6);
      const r = DRONE_RADIUS + 1.2;
      const x0 = Math.max(0, Math.floor((b.min[0] - r + GRID_HALF) / GRID)), x1 = Math.min(GRID_N - 1, Math.floor((b.max[0] + r + GRID_HALF) / GRID));
      const z0 = Math.max(0, Math.floor((b.min[2] - r + GRID_HALF) / GRID)), z1 = Math.min(GRID_N - 1, Math.floor((b.max[2] + r + GRID_HALF) / GRID));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) lists[cz * GRID_N + cx].push(i);
    });
    this.cellStart = new Int32Array(lists.length + 1);
    const items: number[] = [];
    lists.forEach((l, i) => {
      this.cellStart[i] = items.length;
      items.push(...l);
    });
    this.cellStart[lists.length] = items.length;
    this.cellItems = new Int32Array(items);
    // addCranes and addPowerLines obstacles
    const hz: number[] = [];
    for (const [x, h, z] of [[-52, 33, -30], [58, 42, 50]]) {
      hz.push(x, h + 4, z, 5.5, 12);
      hz.push(x + 10, h, z, 4.4, 10);
    }
    for (const z of [-62, 62]) for (const y of [15, 17]) hz.push(0, y, z, 3.1, 9);
    this.hazards = new Float32Array(hz);
    this.hazardCount = hz.length / 5;

    this.boom = play.emitter({ count: 50, life: 0.9, speed: 9, spread: Math.PI, size: [0.7, 0.15], color: [0xffd27a, 0xff5a22], alpha: [1, 0], blend: "add", drag: 1.4 });
    const sparks = play.emitter({ count: 10, life: 0.4, speed: 5, spread: Math.PI, size: [0.3, 0.05], color: [0xfff0b0, 0xff9040], alpha: [1, 0], blend: "add", drag: 2 });
    const glint = play.emitter({ count: 22, life: 0.7, speed: 4, spread: Math.PI, size: [0.4, 0.08], color: [0xffd36a, 0xffa526], alpha: [1, 0], blend: "add", drag: 1.5 });
    this.glint = glint;
    this.sparks = sparks;
    this.sounds = {
      pickup: play.sound(sfx.pickup()),
      deliver: play.sound(sfx.powerup()),
      mission: play.sound(sfx.win()),
      fail: play.sound(sfx.lose()),
      bump: play.sound(sfx.thud()),
      hurt: play.sound({ ...sfx.hurt(), volume: 0.35 }),
      alarm: play.sound(sfx.alarm()),
      tick: play.sound({ ...sfx.select(), freq: 880, volume: 0.25 }),
    };
    const rotor = play.sound({ ...sfx.rotor(), freq: 38 });

    this.droneArch = play.archetype({
      model: play.model(V.drone()),
      motion: motion.hover({ accel: ACCEL, maxSpeed: MAX_SPEED, damping: DAMPING, vertical: ACCEL, maxVertical: MAX_SPEED, turnRate: YAW_RATE, tilt: 0, gravity: 0, minY: MIN_HEIGHT, maxY: MAX_HEIGHT, frame: "heading" }),
      layer: L.drone, hits: L.traffic | L.bird, team: 1, radius: DRONE_RADIUS, hp: 100, keepOnDeath: true, flash: 0.12, shadow: 2.6,
      death: this.boom, sounds: { death: play.sound(sfx.bigExplosion()) },
      joints: [joint.spin("r0", "y", 26), joint.spin("r1", "y", -26), joint.spin("r2", "y", -26), joint.spin("r3", "y", 26)],
      hum: { sound: rotor, speed: MAX_SPEED, pitch: 1.6 },
    });
    this.crateArch = play.archetype({ model: play.model(V.packageCrate()), motion: motion.attached(), layer: L.cargo, shadow: 1.4 });
    // the traffic: five paint colours, every fifth car with a roof sign
    for (let c = 0; c < V.TRAFFIC_COLORS.length; c++) {
      for (const sign of [false, true]) {
        this.trafficArchs.push(
          play.archetype({ model: play.model(V.trafficCar(V.TRAFFIC_COLORS[c], sign)), motion: motion.linear({ speed: 10 }), layer: L.traffic, radius: 1.0, height: 1.2, bounds: "wrap", shadow: 1.8 }),
        );
      }
    }
    const birdModel = play.model(V.bird());
    for (let i = 0; i < 8; i++) {
      const cx = -70 + i * 20, cy = 24 + (i % 4) * 8, cz = 72 - (i % 3) * 44;
      const radius = 9 + (i % 4) * 3;
      const phase = i * 1.7;
      const points: [number, number, number][] = [];
      for (let k = 0; k <= 16; k++) {
        const a = phase + (k / 16) * Math.PI * 2;
        points.push([cx + Math.cos(a) * radius, cy, cz - Math.sin(a) * radius]);
      }
      const path = play.path(points);
      this.birdArchs.push(
        play.archetype({ model: birdModel, motion: motion.path({ path, speed: radius * 0.9, loop: true, turnRate: 0 }), layer: L.bird, radius: 2.4, joints: [joint.bob("bob", 0.35)], shadow: 0 }),
      );
    }
    // contacts: the demo's per-second damage, per step
    play.rule(L.drone, L.traffic, { damage: "a", value: 12 / 60 });
    play.rule(L.drone, L.bird, { damage: "a", value: 7 / 60, push: true });

    // the pad and the waypoint arrows are scenery that moves
    this.pad = play.place(play.model(V.landingPad()), [0, -40, 0], { static: false, hidden: true });
    this.arrowPick = play.place(play.model(V.waypointArrow(0xffc65a)), [0, -40, 0], { static: false, hidden: true });
    this.arrowDrop = play.place(play.model(V.waypointArrow(0x61ffc1)), [0, -40, 0], { static: false, hidden: true });
    this.reset(true);
  }
  private readonly glint: { id: number };
  private readonly sparks: { id: number };

  /** The city of CityEnvironment.build as static batches. */
  private buildCity(): void {
    const play = this.play;
    const plan = this.plan;
    const m = new Float32Array(12);
    const put = (model: { id: number }, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) =>
      play.native.nodeMatrix(-1, model.id, V.placement(x, y, z, yaw, sx, sy, sz, m), PLAYSET_NODE.STATIC);
    const W = V.CFG.worldSize;
    // ground patches
    const grass = play.model(V.unitFlat(V.COLORS.grass));
    const grassLight = play.model(V.unitFlat(V.COLORS.grassLight));
    for (const p of plan.patches) put(p.light ? grassLight : grass, p.x, 0.04, p.z, p.yaw, p.w, 1, p.d);
    // roads and sidewalks
    const asphalt = play.model(V.unitFlat(V.COLORS.asphalt));
    const sidewalk = play.model(V.unitFlat(V.COLORS.sidewalk));
    for (const c of plan.roadCoords) {
      // in 60 m pieces (see the ground above); sidewalks line the inner city
      // and its ring, where the drone flies low
      for (let t = -W / 2 + ROAD_PIECE / 2; t < W / 2; t += ROAD_PIECE) {
        put(asphalt, c, 0.08, t, 0, 5, 1, ROAD_PIECE);
        put(asphalt, t, 0.08, c, 0, ROAD_PIECE, 1, 5);
        if (Math.abs(c) > SIDEWALK_REACH || Math.abs(t) > SIDEWALK_REACH) continue;
        for (const s of [-1, 1]) {
          put(sidewalk, c + s * 3.42, 0.16, t, 0, 1.7, 1, ROAD_PIECE);
          put(sidewalk, t, 0.16, c + s * 3.42, 0, ROAD_PIECE, 1, 1.7);
        }
      }
    }
    // lane dashes and crosswalks around the landing intersections
    const dash = play.model(V.unitFlat(V.COLORS.laneYellow));
    const walk = play.model(V.crosswalk());
    for (const [dx, , dz] of plan.dropSpots) {
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        put(dash, dx + k * 13, 0.15, dz, 0, 4.4, 1, 0.16);
        put(dash, dx, 0.15, dz + k * 13, 0, 0.16, 1, 4.4);
      }
      put(walk, dx, 0.17, dz - 4.15, 0, 1, 1, 1);
      put(walk, dx, 0.17, dz + 4.15, 0, 1, 1, 1);
      put(walk, dx - 4.15, 0.17, dz, Math.PI / 2, 1, 1, 1);
      put(walk, dx + 4.15, 0.17, dz, Math.PI / 2, 1, 1, 1);
    }
    // buildings
    const variants = new Map<string, { id: number }>();
    const variant = (b: V.Building) => {
      const key = `${b.outer ? "o" : "i"}${b.body}${b.lit}${b.side}`;
      let v = variants.get(key);
      if (!v) {
        v = play.model(b.outer ? V.unitOuterBuilding(b.body, b.lit) : V.unitBuilding(b.body, b.lit, b.side));
        variants.set(key, v);
      }
      return v;
    };
    const unit = play.model(V.unitBox());
    const antenna = play.model(V.antenna());
    for (const b of plan.buildings) {
      put(variant(b), b.x, 0, b.z, 0, b.w, b.h, b.d);
      if (b.unit) put(unit, b.unit.x, b.unit.y, b.unit.z, 0, b.unit.w, b.unit.h, b.unit.d);
      if (b.antenna) play.place(antenna, [b.x, b.h + 0.45, b.z]);
    }
    // trees, street lights, cranes, power lines
    const treeA = play.model(V.tree(false));
    const treeB = play.model(V.tree(true));
    for (const t of plan.trees) play.place(t.light ? treeB : treeA, [t.x, 0, t.z]);
    const light = play.model(V.streetLight());
    for (const l of plan.lights) play.place(light, [l.x, 0, l.z], { yaw: l.sx > 0 ? 0 : Math.PI });
    play.place(play.model(V.crane(33)), [-52, 0, -30]);
    play.place(play.model(V.crane(42)), [58, 0, 50]);
    const power = play.model(V.powerLine());
    play.place(power, [0, 0, -62]);
    play.place(power, [0, 0, 62]);
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.crate = -1;
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.hud.score = 0;
    this.hud.damage = 0;
    this.drone = play.spawn(this.droneArch, START[0], START[1], START[2], START_YAW);
    this.lastHp = 100;
    this.hud.battery = 100;
    this.lowBattery = 0;
    this.note = "";
    this.noteTime = 0;
    // traffic: 36 cars on the road coordinates, alternating directions
    const coords = this.plan.roadCoords;
    const gridMax = V.CFG.cityGridMax;
    for (let i = 0; i < 36; i++) {
      const horizontal = i % 2 === 0;
      const lane = coords[i % coords.length];
      const dir = i % 4 < 2 ? 1 : -1;
      const x = horizontal ? -gridMax + ((i * 13) % (gridMax * 2)) : lane;
      const z = horizontal ? lane : -gridMax + ((i * 17) % (gridMax * 2));
      // the demo's forward is -Z: its "dir > 0" vertical cars head to -Z
      const yaw = horizontal ? (dir > 0 ? -Math.PI / 2 : Math.PI / 2) : dir > 0 ? 0 : Math.PI;
      const s = play.spawn(this.trafficArchs[(i % 5) * 2 + (i % 5 === 1 ? 1 : 0)], x, 0.1, z, yaw);
      if (s >= 0) play.user[s * 8] = 9 + (i % 5) * 1.7;
    }
    for (const b of this.birdArchs) play.spawn(b, 0, 0, 0, 0);
    this.startMission(0);
    play.followCamera(this.drone, { offset: [0, 5.2, 12], lookAhead: 5, lookUp: 1.4, heading: true, fov: 68, near: 0.3, far: 205, smooth: 6.5, smoothLook: 10 });
  }

  private startMission(index: number): void {
    const play = this.play;
    if (this.crate >= 0 && play.alive(this.crate)) play.kill(this.crate);
    this.missionIndex = index;
    this.hud.mission = index + 1;
    this.hud.timer = Math.max(95, 150 - index * 16);
    this.hud.timerMax = this.hud.timer;
    this.lastSecond = Math.ceil(this.hud.timer);
    this.active = true;
    const difficulty = index + 1;
    const spots = this.plan.packageSpots;
    const drops = this.plan.dropSpots;
    const p = spots[difficulty % spots.length];
    const d = drops[difficulty % drops.length];
    this.pickup = [p[0], p[1], p[2]];
    this.dropoff = [d[0], d[1], d[2]];
    this.anchor = this.findSafeDeliveryAnchor(this.dropoff);
    this.pkgState = 0;
    this.crate = play.spawn(this.crateArch, p[0], p[1], p[2], 0);
    play.move(this.pad, d[0], d[1], d[2], 0, 0, 0, 1, true);
    // traffic speeds up with the difficulty
    for (const arch of this.trafficArchs) {
      const count = play.ofArchetype(arch);
      for (let k = 0; k < count; k++) {
        const s = play.list[k];
        play.ent[s * 16 + ENT.SPEED] = play.user[s * 8] * (1 + difficulty * 0.06);
      }
    }
  }

  private say(text: string, seconds = 2.2): void {
    this.note = text;
    this.noteTime = seconds;
  }

  /** One frame: the controls, the native step, the demo's rules after it. */
  frame(pad: Pad): void {
    const play = this.play;
    const dt = 1 / 60;
    const hud = this.hud;
    const live = hud.status === "playing" || (hud.status === "title" && hud.demo);
    const slot = this.drone;
    const ent = play.ent;
    const o = slot * 16;
    let c = this.controls;
    if (live && this.active) {
      if (hud.demo) {
        if (this.aiTick++ % 3 === 0) this.autopilot();
        c = this.ai;
      } else this.manual(pad, c);
      const liftUse = Math.abs(c.up - c.down);
      const moveUse = c.forward + c.backward + c.left + c.right + liftUse + (c.brake ? 0.4 : 0);
      hud.battery = clamp(hud.battery - dt * (0.55 + moveUse * 0.62), 0, 100);
      const powered = hud.battery > 0 && hud.damage < 100;
      if (!powered) {
        play.steer(slot, 0, 0, 0, -1);
      } else if (hud.demo) {
        // the autopilot accelerates the drone itself (below); the kernel damps
        play.steer(slot, 0, 0, c.rotateRight - c.rotateLeft, c.up - c.down);
      } else {
        play.steer(slot, c.right - c.left, c.forward - c.backward, c.rotateRight - c.rotateLeft, c.up - c.down);
      }
      this.braking = !powered || c.brake;
    } else {
      play.steer(slot, 0, 0, 0, 0);
      this.braking = true;
    }
    play.frame(dt);
    if (live && this.active && hud.demo && hud.battery > 0 && hud.damage < 100) {
      // GeneralVehicleMotionController: v += a dt, at most MAX_SPEED
      let vx = ent[o + 3] + this.aiAx * dt;
      let vz = ent[o + 5] + this.aiAz * dt;
      const vy = ent[o + 4];
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(s2);
        vx *= k;
        vz *= k;
        ent[o + 4] = vy * k;
      }
      ent[o + 3] = vx;
      ent[o + 5] = vz;
    }
    if (live && this.active) {
      if (play.alive(slot)) this.afterStep(ent, o, dt);
      else {
        // a contact rule took the last hit point
        this.hud.damage = 100;
        this.missionStep(ent[o], ent[o + 1], ent[o + 2], dt);
      }
    } else if (this.braking) this.damp(ent, o, BRAKE_DAMPING, dt);
    if (this.noteTime > 0) this.noteTime -= dt;
    if (this.aiTick % 2 === 0) this.moveArrow(ent, o);
  }
  private braking = false;

  private damp(ent: Float32Array, o: number, k: number, dt: number): void {
    // the demo's brake damps velocity at 5.8/s; the kernel already took 0.55
    const f = Math.exp(-(k - DAMPING) * dt);
    ent[o + 3] *= f;
    ent[o + 4] *= f;
    ent[o + 5] *= f;
  }

  /** Drone.update's rules after the motion, the hazards and MissionManager. */
  private afterStep(ent: Float32Array, o: number, dt: number): void {
    const play = this.play;
    const hud = this.hud;
    if (this.braking) this.damp(ent, o, BRAKE_DAMPING, dt);
    let x = ent[o], y = ent[o + 1], z = ent[o + 2];
    // the height band holds vertical speed at its edges
    if (y <= MIN_HEIGHT + 1e-3 && ent[o + 4] < 0) ent[o + 4] = 0;
    if (y >= MAX_HEIGHT - 1e-3 && ent[o + 4] > 0) ent[o + 4] = 0;
    let damage = 0;
    const edge = V.CFG.halfWorld - 4;
    if (x < -edge || x > edge) {
      x = clamp(x, -edge, edge);
      ent[o] = x;
      ent[o + 3] -= ent[o + 3] * 1.15;
      damage += 4;
    }
    if (z < -edge || z > edge) {
      z = clamp(z, -edge, edge);
      ent[o + 2] = z;
      ent[o + 5] -= ent[o + 5] * 1.15;
      damage += 4;
    }
    // buildings: a sphere against the demo's expanded boxes
    const cx = Math.floor((x + GRID_HALF) / GRID), cz = Math.floor((z + GRID_HALF) / GRID);
    if (cx >= 0 && cz >= 0 && cx < GRID_N && cz < GRID_N) {
      const boxes = this.boxes, items = this.cellItems;
      const cell = cz * GRID_N + cx;
      const end = this.cellStart[cell + 1];
      const r2 = DRONE_RADIUS * DRONE_RADIUS;
      for (let k = this.cellStart[cell]; k < end; k++) {
        const b = items[k] * 6;
        const qx = x < boxes[b] ? boxes[b] : x > boxes[b + 3] ? boxes[b + 3] : x;
        const qy = y < boxes[b + 1] ? boxes[b + 1] : y > boxes[b + 4] ? boxes[b + 4] : y;
        const qz = z < boxes[b + 2] ? boxes[b + 2] : z > boxes[b + 5] ? boxes[b + 5] : z;
        const ex = x - qx, ey = y - qy, ez = z - qz;
        if (ex * ex + ey * ey + ez * ez >= r2) continue;
        let px = x - (boxes[b] + boxes[b + 3]) * 0.5;
        let pz = z - (boxes[b + 2] + boxes[b + 5]) * 0.5;
        let pl = Math.sqrt(px * px + pz * pz);
        if (pl < 0.1) {
          px = 0;
          pz = -1;
          pl = 1;
        }
        x += (px / pl) * 1.8;
        z += (pz / pl) * 1.8;
        ent[o] = x;
        ent[o + 2] = z;
        ent[o + 3] *= -0.18;
        ent[o + 4] *= -0.18;
        ent[o + 5] *= -0.18;
        damage += 10;
        if (this.bumpCooldown <= 0) {
          this.bumpCooldown = 0.3;
          play.play(this.sounds.bump, 1, 1, [x, y, z]);
          play.burst(this.sparks, x, y, z);
        }
      }
    }
    // cranes and power lines hurt while the drone is inside their reach
    const hz = this.hazards;
    for (let k = 0; k < this.hazardCount; k++) {
      const h = k * 5;
      const dx = x - hz[h], dy = y - hz[h + 1], dz = z - hz[h + 2];
      const reach = hz[h + 3] + DRONE_RADIUS;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= reach * reach) continue;
      damage += hz[h + 4] * dt;
      const d = Math.sqrt(d2) || 1;
      ent[o + 3] += (dx / d) * dt * 10;
      ent[o + 4] += (dy / d) * dt * 10;
      ent[o + 5] += (dz / d) * dt * 10;
    }
    if (damage > 0) ent[o + ENT.HP] -= damage;
    // the demo's lean: roll from sideways speed, pitch from forward speed
    const yaw = ent[o + ENT.YAW];
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const vx = ent[o + 3], vz = ent[o + 5];
    const lateral = vx * cy - vz * sy;
    const fwd = -vx * sy - vz * cy;
    ent[o + ENT.ROLL] = clamp(-lateral * 0.014, -0.22, 0.22);
    ent[o + ENT.PITCH] = clamp(-fwd * 0.009, -0.16, 0.16);
    const hp = ent[o + ENT.HP];
    hud.damage = clamp(100 - hp, 0, 100);
    if (hp < this.lastHp - 0.05 && this.hurtCooldown <= 0) {
      this.hurtCooldown = 0.45;
      play.play(this.sounds.hurt, 0.8);
    }
    this.lastHp = hp;
    this.bumpCooldown -= dt;
    this.hurtCooldown -= dt;
    const vy = ent[o + 4];
    hud.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    // low battery warnings at 20 % and 10 %
    if ((hud.battery < 20 && this.lowBattery === 0) || (hud.battery < 10 && this.lowBattery === 1)) {
      this.lowBattery++;
      play.play(this.sounds.alarm, 0.8);
      this.say("BATTERY LOW");
    }
    this.missionStep(x, y, z, dt);
  }

  /** MissionManager.update. */
  private missionStep(x: number, y: number, z: number, dt: number): void {
    const play = this.play;
    const hud = this.hud;
    hud.timer -= dt;
    const second = Math.ceil(hud.timer);
    if (second !== this.lastSecond) {
      this.lastSecond = second;
      if (second <= 10 && second > 0) play.play(this.sounds.tick, 0.7);
    }
    if (hud.timer <= 0 || hud.battery <= 0 || hud.damage >= 100) {
      this.active = false;
      if (hud.damage >= 100) play.kill(this.drone, "event");
      play.play(this.sounds.fail, 1);
      this.say(hud.damage >= 100 ? "DRONE DESTROYED" : hud.battery <= 0 ? "BATTERY DEPLETED" : "OUT OF TIME", 4);
      if (!hud.demo) hud.status = "gameover";
      else this.demoOver = play.tick;
      return;
    }
    if (this.pkgState === 2) {
      hud.score += Math.round(hud.timer * 8) + 400 * (this.missionIndex + 1);
      play.play(this.sounds.mission, 0.9);
      this.say("MISSION COMPLETE");
      this.startMission(this.missionIndex + 1);
      return;
    }
    if (this.pkgState === 0) {
      const p = this.pickup;
      const dx = x - p[0], dy = y - p[1], dz = z - p[2];
      hud.distance = Math.sqrt(dx * dx + dz * dz);
      if (dx * dx + dy * dy + dz * dz < 4.4 * 4.4) {
        this.pkgState = 1;
        hud.score += 100;
        play.attach(this.crate, this.drone, [0, -2.35, 0], 0, false);
        play.move(this.pad, this.dropoff[0], this.dropoff[1], this.dropoff[2]);
        play.play(this.sounds.pickup, 1);
        play.burst(this.glint, p[0], p[1], p[2]);
        this.say("PACKAGE SECURED");
      }
    } else if (this.pkgState === 1) {
      const d = this.dropoff;
      const dx = x - d[0], dy = y - d[1], dz = z - d[2];
      hud.distance = Math.sqrt(dx * dx + dz * dz);
      if (dx * dx + dy * dy + dz * dz < 5.2 * 5.2 && hud.speed < 18) {
        this.pkgState = 2;
        hud.score += 280;
        play.kill(this.crate);
        play.move(this.pad, 0, -40, 0, 0, 0, 0, 1, true);
        play.play(this.sounds.deliver, 1);
        play.burst(this.glint, d[0], d[1] + 1, d[2]);
        this.say("DELIVERY COMPLETE");
      }
    }
    hud.carrying = this.pkgState === 1;
  }
  /** the tick the demo's run ended on, -1 while it runs */
  demoOver = -1;

  private moveArrow(ent: Float32Array, o: number): void {
    const play = this.play;
    const show = this.active && this.pkgState !== 2 && (ent[o + ENT.STATE] & STATE.DEAD) === 0;
    const t = this.pkgState === 1 ? this.dropoff : this.pickup;
    const x = ent[o], y = ent[o + 1], z = ent[o + 2];
    const near = Math.abs(t[0] - x) < 6 && Math.abs(t[2] - z) < 6;
    const arrow = this.pkgState === 1 ? this.arrowDrop : this.arrowPick;
    if (arrow !== this.arrowShown) {
      if (this.arrowShown >= 0) play.move(this.arrowShown, 0, -40, 0, 0, 0, 0, 1, true);
      this.arrowShown = arrow;
    }
    play.move(arrow, x, y + 2.6, z, Math.atan2(-(t[0] - x), -(t[2] - z)), 0, 0, 1.4, !show || near);
  }
  private arrowShown = -1;

  /** The pad as the demo's keys. */
  private manual(pad: Pad, c: Controls): void {
    emptyControls(c);
    c.forward = Math.max(0, pad.y);
    c.backward = Math.max(0, -pad.y);
    c.right = Math.max(0, pad.x);
    c.left = Math.max(0, -pad.x);
    c.up = pad.held & BTN.CIRCLE ? 1 : 0;
    c.down = pad.held & BTN.CROSS ? 1 : 0;
    c.rotateLeft = pad.held & BTN.LTRIGGER ? 1 : Math.max(0, -pad.rx);
    c.rotateRight = pad.held & BTN.RTRIGGER ? 1 : Math.max(0, pad.rx);
    c.brake = (pad.held & BTN.TRIANGLE) !== 0;
  }

  // --- the demo's PlayerAi --------------------------------------------------------

  /** PlayerAi.findSafeDeliveryAnchor, once per mission, against the
   *  buildings in the pad's grid cells. */
  private findSafeDeliveryAnchor(t: [number, number, number]): [number, number, number] {
    const height = 3.2;
    const clearance = DRONE_RADIUS + 1.1;
    const edge = V.CFG.halfWorld - 4;
    const near: number[] = [];
    const cx = Math.floor((t[0] + GRID_HALF) / GRID), cz = Math.floor((t[2] + GRID_HALF) / GRID);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) continue;
        const cell = gz * GRID_N + gx;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) if (!near.includes(this.cellItems[k])) near.push(this.cellItems[k]);
      }
    }
    const clearanceAt = (px: number, pz: number) => {
      let best = Infinity;
      for (const i of near) {
        const b = i * 6;
        const bx = this.boxes;
        if (height < bx[b + 1] - clearance || height > bx[b + 4] + clearance) continue;
        const minR = bx[b] - clearance, maxR = bx[b + 3] + clearance, minF = bx[b + 2] - clearance, maxF = bx[b + 5] + clearance;
        const outR = px < minR ? minR - px : px > maxR ? px - maxR : 0;
        const outF = pz < minF ? minF - pz : pz > maxF ? pz - maxF : 0;
        const margin = outR || outF ? Math.hypot(outR, outF) : -Math.min(px - minR, maxR - px, pz - minF, maxF - pz);
        best = Math.min(best, margin);
      }
      return best;
    };
    let best: [number, number, number] = [t[0], t[1], t[2]];
    let bestScore = -Infinity;
    const consider = (px: number, pz: number) => {
      const horizontal = Math.hypot(px - t[0], pz - t[2]);
      if (Math.hypot(horizontal, Math.abs(height - t[1])) > 5.05) return;
      const score = clearanceAt(px, pz) - horizontal * 0.08;
      if (score > bestScore) {
        best = [px, t[1], pz];
        bestScore = score;
      }
    };
    consider(t[0], t[2]);
    for (const radius of [1.4, 2.6, 3.8, 4.2]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        consider(clamp(t[0] + Math.cos(a) * radius, -edge, edge), clamp(t[2] - Math.sin(a) * radius, -edge, edge));
      }
    }
    return best;
  }

  /** PlayerAi.read: plan a waypoint by phase, fly toward it, turn to face it. */
  private autopilot(): void {
    const c = emptyControls(this.ai);
    const ent = this.play.ent;
    const o = this.drone * 16;
    if (!this.active || this.pkgState === 2) {
      c.brake = true;
      this.aiAx = this.aiAz = 0;
      return;
    }
    const carried = this.pkgState === 1;
    const target = carried ? this.dropoff : this.pickup;
    const travel = carried ? this.anchor : this.pickup;
    const x = ent[o], y = ent[o + 1], z = ent[o + 2];
    const vx = ent[o + 3], vy = ent[o + 4], vz = ent[o + 5];
    const yaw = ent[o + ENT.YAW];
    let dx = travel[0] - x, dz = travel[2] - z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const targetHeight = target[1];
    // planWaypoint
    let desiredHeight: number, maxSpeed: number, cruise = false;
    if (carried) {
      if (distance > 22) {
        desiredHeight = 62;
        maxSpeed = 27;
        cruise = true;
      } else if (distance > 8) {
        desiredHeight = clamp(18 + ((distance - 8) / 14) * 30, 18, 48);
        maxSpeed = 13;
      } else {
        desiredHeight = 3.2;
        maxSpeed = 5.5;
      }
    } else {
      const cruiseHeight = clamp(Math.max(70, targetHeight + 16), 42, 82);
      if (distance > 20) {
        desiredHeight = cruiseHeight;
        maxSpeed = 25;
        cruise = true;
      } else if (distance > 3) {
        desiredHeight = clamp(targetHeight + 10, 8, 82);
        maxSpeed = 10;
      } else {
        desiredHeight = clamp(targetHeight + 3.9, 3.2, 82);
        maxSpeed = 4.5;
      }
    }
    // desiredVelocity
    let wx = 0, wz = 0;
    if (distance > 0.01) {
      let planar = Math.min(maxSpeed, Math.max(1.4, distance * 0.9));
      if (cruise && y < 54) planar *= clamp((y - 34) / 20, 0, 1);
      // the same rule on the approach to a rooftop: climb above it first
      else if (!carried && y < targetHeight + 6) planar *= clamp((y - targetHeight - 2) / 4, 0, 1);
      wx = (dx / distance) * planar;
      wz = (dz / distance) * planar;
    }
    const wy = clamp((desiredHeight - y) * 1.2, -12, 10);
    // applyAccelerationControls: the acceleration toward the desired velocity
    // as 0..1 signals on the drone's axes (31 m/s² each)
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const ax = (wx - vx) * 1.45, ay = (wy - vy) * 1.45, az = (wz - vz) * 1.45;
    const right = clamp((ax * cy - az * sy) / ACCEL, -1, 1);
    const forward = clamp((-ax * sy - az * cy) / ACCEL, -1, 1);
    const up = clamp(ay / ACCEL, -1, 1);
    c.right = Math.max(0, right);
    c.left = Math.max(0, -right);
    c.forward = Math.max(0, forward);
    c.backward = Math.max(0, -forward);
    c.up = Math.max(0, up);
    c.down = Math.max(0, -up);
    // planMovement: a shift longer than 1 is scaled to 1
    const len = Math.sqrt(right * right + forward * forward + up * up);
    const k = (len > 1 ? 1 / len : 1) * ACCEL;
    this.aiAx = (right * cy - forward * sy) * k;
    this.aiAz = (-right * sy - forward * cy) * k;
    // applyYawControls
    if (distance > 0.1) {
      dx /= distance;
      dz /= distance;
      const yawError = normalizeAngle(Math.atan2(-dx, -dz) - yaw);
      const signal = clamp(Math.abs(yawError) * 1.35, 0, 1);
      c.rotateLeft = yawError > 0 ? signal : 0;
      c.rotateRight = yawError < 0 ? signal : 0;
    }
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const nearing = distance < (carried ? 9 : 6);
    const climbingOut = cruise && y < 40;
    c.brake = !c.up && (speed > maxSpeed * 1.2 || (nearing && speed > 7) || (climbingOut && speed > 3));
  }

  get noteText(): string {
    return this.noteTime > 0 ? this.note : "";
  }
}

const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const m = Math.floor(t / 60);
  const r = t % 60;
  return `${m < 10 ? "0" : ""}${m}:${r < 10 ? "0" : ""}${r}`;
};

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new DroneDelivery();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  return {
    title: "Drone Delivery",
    tagline: "Fly rooftop packages to the landing pads.\nBeat the clock before the battery runs out.",
    accent: "#1f9e80",
    controls: [
      ["Circle Pad / D-Pad", "Fly forward and sideways"],
      ["A / B", "Climb / descend"],
      ["L / R", "Turn"],
      ["X", "Brake"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Battery", value: () => `${Math.ceil(game.hud.battery)}%`, bar: () => game.hud.battery / 100, color: "#8bff7a" },
      { label: "Hull", value: () => `${Math.ceil(100 - game.hud.damage)}%`, bar: () => 1 - game.hud.damage / 100, color: "#ff6f8f" },
      { label: "Time", value: () => mmss(game.hud.timer), bar: () => game.hud.timer / game.hud.timerMax, color: "#ffc65a" },
      { label: "Package", value: () => `${game.hud.carrying ? "Deliver" : "Pick up"} · ${Math.round(game.hud.distance)} m` },
      { label: "Score", value: () => game.hud.score },
      { label: "Mission", value: () => game.hud.mission },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.demoOver = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop flies a new run three seconds after the demo's ends
      if (game.hud.demo && game.demoOver >= 0 && game.play.tick - game.demoOver > 180) {
        game.demoOver = -1;
        game.reset(true);
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => {
      const h = game.hud;
      const note = game.noteText;
      return `MISSION ${h.mission}   ${mmss(h.timer)}   BATTERY ${Math.ceil(h.battery)}%   ${note || `${h.carrying ? "DELIVER" : "PICK UP"} ${Math.round(h.distance)} m`}`;
    },
    result: () => `Score ${game.hud.score} · reached mission ${game.hud.mission}`,
  };
}
