// Drone Delivery's city and models, ported from GameBlocks' drone-delivery
// demo (https://gb-drone-delivery.vercel.app/, MIT, xt4d/GameBlocks): the
// CityEnvironment of src/cityEnvironment.js and the Drone and Package models
// of src/game.js.
//
// Coordinates: the demo builds its city in a group whose local frame is
// three.js's canonical one (+X right, +Y up, -Z forward), which is the
// playset's world frame, so city coordinates carry over unchanged. The
// seeded generators (mulberry32 42, 511, 911) are consumed in the demo's
// order, so every building, package spot and street light sits where the
// demo puts it.
//
// Deviations, all for the vertex budget of a 400x240 PICA frame: buildings
// are their visible faces (four walls and a roof, planes instead of boxes)
// with two facade strips on the long faces and one on the sides instead of
// one per 3.2 m, and no
// floor trims or roof rails; one rooftop unit per building; the outer
// district is the demo's middle LOD; the grass is a flat heightfield of
// 30 m cells and roads are 60 m pieces (a quad that reaches far behind the
// camera is not drawn); roads, sidewalks and markings are flat planes,
// sidewalks line the inner city and its ring, and the intersection plates
// (the road's own colour) are left out; lane dashes, crosswalks and street
// lights stand only
// around the six landing intersections (from the cruise height they are
// below a pixel); trees and props use fewer segments; the traffic cars keep
// their body, cabin, hood, lamps and axles and drive on the road surface
// (the demo floats them 0.58 m up); the point lights, shadows and the
// gradient sky texture become the playset's hemisphere light and sky.

import * as THREE from "@pocketjs/framework/playset/three";
import { mulberry } from "../kit/random.ts";

export const CFG = {
  worldSize: 720,
  halfWorld: 360,
  cityGridMax: 300,
  innerCityGridMax: 150,
  cityBlockSize: 25,
  outerBlockSize: 50,
  outerBuildingBlockSize: 25,
  missionInnerRadius: 92,
  fogNear: 100,
  fogFar: 200,
  cameraFar: 260,
};

export const COLORS = {
  sky: 0x7bbfe8,
  skyHorizon: 0xd6f3ff,
  skyLow: 0xf4d7aa,
  fog: 0xa7d4e4,
  asphalt: 0x232a2e,
  roadLine: 0xe8e0bd,
  laneYellow: 0xffc857,
  sidewalk: 0x7c8587,
  grass: 0x3e6b4d,
  grassLight: 0x56865c,
  glassA: 0x4b6873,
  glassB: 0x6c8186,
  facadeTrim: 0xb7c5c8,
  windowLit: 0xffdf8a,
  roof: 0x30393d,
  roofLight: 0x76efff,
  tree: 0x2f8a55,
  treeLight: 0x54a668,
  trunk: 0x73533c,
  metal: 0xb2babd,
  crane: 0xf2b93b,
  hazard: 0xff6a3d,
};

type Mat = THREE.MeshStandardMaterial;
const mat = (color: number, emissive?: number, intensity = 1): Mat =>
  new THREE.MeshStandardMaterial(emissive === undefined ? { color } : { color, emissive, emissiveIntensity: intensity });
const MATS = {
  glassA: mat(COLORS.glassA, 0x08141a, 0.15),
  glassB: mat(COLORS.glassB, 0x0a1619, 0.12),
  windowLit: mat(COLORS.windowLit, 0xffb85f, 0.62),
  facadeTrim: mat(COLORS.facadeTrim),
  roof: mat(COLORS.roof),
  metal: mat(COLORS.metal),
};
export type GlassName = "glassA" | "glassB";
export type AccentName = "windowLit" | "glassA" | "glassB" | "facadeTrim";

/** A plane of w x h facing `normal` (one of the six axis directions), its
 *  centre at (x, y, z). */
function face(w: number, h: number, material: THREE.Material, normal: "+x" | "-x" | "+y" | "-y" | "+z" | "-z", x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  if (normal === "+x") m.rotation.y = Math.PI / 2;
  else if (normal === "-x") m.rotation.y = -Math.PI / 2;
  else if (normal === "-z") m.rotation.y = Math.PI;
  else if (normal === "+y") m.rotation.x = -Math.PI / 2;
  else if (normal === "-y") m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// --- the city plan (positions and sizes in the demo's order) ------------------------

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  body: GlassName;
  lit: AccentName;
  side: AccentName;
  outer: boolean;
  /** collision box, expanded like the demo's Box3 */
  min: [number, number, number];
  max: [number, number, number];
  unit?: { x: number; y: number; z: number; w: number; h: number; d: number };
  antenna: boolean;
}

export interface CityPlan {
  buildings: Building[];
  packageSpots: [number, number, number][];
  dropSpots: [number, number, number][];
  roadCoords: number[];
  patches: { x: number; z: number; w: number; d: number; yaw: number; light: boolean }[];
  lights: { x: number; z: number; sx: number }[];
  trees: { x: number; z: number; light: boolean }[];
}

export function roadCoordinates(): number[] {
  const coords: number[] = [];
  for (let v = -CFG.cityGridMax; v <= CFG.cityGridMax; v += CFG.outerBlockSize) coords.push(v);
  for (let v = -CFG.innerCityGridMax; v <= CFG.innerCityGridMax; v += CFG.cityBlockSize) if (!coords.includes(v)) coords.push(v);
  return coords.sort((a, b) => a - b);
}

export function cityPlan(): CityPlan {
  const plan: CityPlan = { buildings: [], packageSpots: [], dropSpots: [], roadCoords: roadCoordinates(), patches: [], lights: [], trees: [] };
  // addGroundPatches (mulberry32 511)
  {
    const rng = mulberry(511);
    const { halfWorld, worldSize } = CFG;
    for (let i = 0; i < 82; i++) {
      const w = 7 + rng() * 13;
      const d = 5 + rng() * 11;
      const light = rng() > 0.5;
      const x = -halfWorld + 8 + rng() * (worldSize - 16);
      const z = -halfWorld + 8 + rng() * (worldSize - 16);
      plan.patches.push({ x, z, w, d, yaw: rng() * Math.PI, light });
    }
  }
  // addBuildings (mulberry32 42)
  const rng = mulberry(42);
  const gridMin = -CFG.innerCityGridMax + 14;
  const gridMax = CFG.innerCityGridMax - 14;
  for (let x = gridMin; x <= gridMax; x += CFG.cityBlockSize) {
    for (let z = gridMin; z <= gridMax; z += CFG.cityBlockSize) {
      if (Math.abs(x) < 11 || Math.abs(z) < 11 || rng() < 0.16) continue;
      const w = 10 + rng() * 8;
      const d = 10 + rng() * 8;
      const h = 12 + rng() * 42;
      const body: GlassName = rng() > 0.5 ? "glassA" : "glassB";
      const px = x + rng() * 5 - 2.5;
      const pz = z + rng() * 5 - 2.5;
      // addBuildingFacade
      const lit: AccentName = rng() > 0.58 ? "windowLit" : "glassA";
      const side: AccentName = rng() > 0.5 ? "glassB" : "glassA";
      // addRooftopDetails: the units, the tank and the ring draw from the
      // same generator; the port keeps the first unit
      const y = h + 0.48;
      const details = 1 + Math.floor(rng() * 3);
      let unit: Building["unit"];
      for (let i = 0; i < details; i++) {
        const uw = 1.6 + rng() * 1.2, uh = 0.55 + rng() * 0.35, ud = 1.1 + rng() * 0.9;
        const ux = px + (rng() - 0.5) * Math.max(1, w - 4);
        const uz = pz + (rng() - 0.5) * Math.max(1, d - 4);
        if (i === 0) unit = { x: ux, y: y + 0.35, z: uz, w: uw, h: uh, d: ud };
      }
      rng(); // the tank
      if (w > 12 && d > 12) rng(); // the roof ring
      const missionDistance = Math.hypot(px, pz);
      if (plan.packageSpots.length < 24 && h > 17 && missionDistance <= CFG.missionInnerRadius) plan.packageSpots.push([px, h + 1.15, pz]);
      const antenna = rng() > 0.58;
      // Box3 of the body and the roof slab, expanded by 0.4
      const hw = (w + 0.5) / 2 + 0.4, hd = (d + 0.5) / 2 + 0.4;
      plan.buildings.push({ x: px, z: pz, w, d, h, body, lit, side, outer: false, unit, antenna, min: [px - hw, -0.4, pz - hd], max: [px + hw, h + 0.375 + 0.4, pz + hd] });
    }
  }
  const outerMin = -CFG.cityGridMax + 24;
  const outerMax = CFG.cityGridMax - 24;
  for (let x = outerMin; x <= outerMax; x += CFG.outerBlockSize) {
    for (let z = outerMin; z <= outerMax; z += CFG.outerBlockSize) {
      const distance = Math.hypot(x, z);
      if (distance <= CFG.innerCityGridMax + 12 || distance > CFG.cityGridMax - 18) continue;
      if (Math.abs(x) < 11 || Math.abs(z) < 11 || rng() < 0.1) continue;
      const w = 9 + rng() * 12;
      const d = 9 + rng() * 12;
      const h = 8 + rng() * 27;
      const px = x + rng() * 5 - 2.5;
      const pz = z + rng() * 5 - 2.5;
      const body: GlassName = rng() > 0.5 ? "glassA" : "glassB";
      const accent: AccentName = rng() > 0.52 ? "windowLit" : "facadeTrim";
      const hw = (w + 0.45) / 2 + 0.45, hd = (d + 0.45) / 2 + 0.45;
      plan.buildings.push({ x: px, z: pz, w, d, h, body, lit: accent, side: accent, outer: true, antenna: false, min: [px - hw, -0.45, pz - hd], max: [px + hw, h + 0.32 + 0.45, pz + hd] });
    }
  }
  plan.dropSpots = [
    [-75, 0.24, -25],
    [75, 0.24, -25],
    [-75, 0.24, 50],
    [75, 0.24, 50],
    [0, 0.24, -75],
    [0, 0.24, 75],
  ];
  // addTrees
  for (let i = 0; i < 150; i++) {
    const angle = i * 2.43;
    const radius = 36 + (i % 18) * 15;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (Math.abs(x % CFG.cityBlockSize) < 7 || Math.abs(z % CFG.cityBlockSize) < 7) continue;
    plan.trees.push({ x, z, light: i % 3 === 0 });
  }
  // addStreetLights (mulberry32 911): the generator runs over every corner;
  // the port keeps the lights around the landing intersections
  {
    const lr = mulberry(911);
    let pointLights = 0;
    for (const roadX of plan.roadCoords) {
      for (const roadZ of plan.roadCoords) {
        const x = roadX + 12;
        const z = roadZ + 12;
        if (Math.abs(x) > CFG.cityGridMax || Math.abs(z) > CFG.cityGridMax) continue;
        if (lr() < 0.46 || (Math.abs(x) < 12 && Math.abs(z) < 12)) continue;
        const sx = lr() > 0.5 ? 1 : -1;
        const sz = lr() > 0.5 ? 1 : -1;
        if (Math.hypot(x, z) < 96 && pointLights < 6 && lr() > 0.84) pointLights += 1;
        const px = x + sx * 5.1, pz = z + sz * 5.1;
        if (nearDrop(plan.dropSpots, px, pz, 40)) plan.lights.push({ x: px, z: pz, sx });
      }
    }
  }
  return plan;
}

function nearDrop(drops: [number, number, number][], x: number, z: number, r: number): boolean {
  for (const d of drops) if (Math.abs(d[0] - x) < r && Math.abs(d[2] - z) < r) return true;
  return false;
}

// --- unit models, scaled per building by the node matrix ---------------------------

/** A unit building (1 x 1 x 1, base at y = 0): four walls, the roof slab's top
 *  and facade strips, the demo's columns at the demo's fractions. */
export function unitBuilding(body: GlassName, lit: AccentName, side: AccentName): THREE.Group {
  const g = new THREE.Group();
  const b = MATS[body];
  g.add(face(1, 1, b, "+z", 0, 0.5, 0.5), face(1, 1, b, "-z", 0, 0.5, -0.5), face(1, 1, b, "+x", 0.5, 0.5, 0), face(1, 1, b, "-x", -0.5, 0.5, 0));
  g.add(face(1.036, 1.036, MATS.roof, "+y", 0, 1.008, 0));
  const band = 0.72;
  const strip = 0.056;
  const off = 0.5035;
  // front and back: the demo's outer columns, the first lit (i % 3 === 0);
  // sides: the middle column, lit (i % 2 === 0 ? sideMat : litMat)
  for (let i = 0; i < 2; i++) {
    const m = i === 0 ? MATS[lit] : MATS[side];
    const o = i === 0 ? -0.38 : 0.38;
    g.add(face(strip, band, m, "-z", o, 0.5, -off), face(strip, band, m, "+z", o, 0.5, off));
  }
  g.add(face(strip * 0.92, band * 0.78, MATS[lit], "-x", -off, 0.5, 0), face(strip * 0.92, band * 0.78, MATS[lit], "+x", off, 0.5, 0));
  return g;
}

/** The outer district's middle LOD: body and roof, with the near LOD's
 *  accent strips on the long faces. */
export function unitOuterBuilding(body: GlassName, accent: AccentName): THREE.Group {
  const g = new THREE.Group();
  const b = MATS[body];
  g.add(face(1, 1, b, "+z", 0, 0.5, 0.5), face(1, 1, b, "-z", 0, 0.5, -0.5), face(1, 1, b, "+x", 0.5, 0.5, 0), face(1, 1, b, "-x", -0.5, 0.5, 0));
  g.add(face(1.03, 1.03, MATS.roof, "+y", 0, 1.009, 0));
  for (const s of [-1, 1]) g.add(face(0.06, 0.58, MATS[accent], "-z", s * 0.22, 0.5, -0.504), face(0.06, 0.58, MATS[accent], "+z", s * 0.22, 0.5, 0.504));
  return g;
}

/** A unit box without a bottom (rooftop units). */
export function unitBox(material: Mat = MATS.metal): THREE.Group {
  const g = new THREE.Group();
  g.add(face(1, 1, material, "+z", 0, 0, 0.5), face(1, 1, material, "-z", 0, 0, -0.5), face(1, 1, material, "+x", 0.5, 0, 0), face(1, 1, material, "-x", -0.5, 0, 0), face(1, 1, material, "+y", 0, 0.5, 0));
  return g;
}

/** A flat unit square on the ground (roads, sidewalks, plates, patches). */
export function unitFlat(color: number, emissive = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(face(1, 1, emissive ? mat(color, color, emissive) : mat(color), "+y", 0, 0, 0));
  return g;
}

/** A row-major 3x4 matrix: translate, yaw about Y, then scale. */
export function placement(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, out = new Float32Array(12)): Float32Array {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = c * sx; out[1] = 0; out[2] = s * sz; out[3] = x;
  out[4] = 0; out[5] = sy; out[6] = 0; out[7] = y;
  out[8] = -s * sx; out[9] = 0; out[10] = c * sz; out[11] = z;
  return out;
}

export function antenna(): THREE.Group {
  const g = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 7, 4, 1, true), MATS.metal);
  mast.position.y = 3.5;
  // the dish: two discs back to back (the demo's 1.2 m cylinder on its side)
  for (const side of [1, -1]) {
    const dish = new THREE.Mesh(new THREE.CircleGeometry(1.2, 6), MATS.metal);
    dish.rotation.y = side * Math.PI * 0.5;
    dish.position.set(0.7 + side * 0.06, 4.3, 0);
    g.add(dish);
  }
  g.add(mast);
  return g;
}

export function tree(light: boolean): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3, 3, 1, true), mat(COLORS.trunk));
  trunk.position.y = 1.5;
  const crownMat = mat(light ? COLORS.treeLight : COLORS.tree);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(2.2, 4.7, 5, 1, true), crownMat);
  crown.position.y = 5.1;
  const top = new THREE.Mesh(new THREE.ConeGeometry(1.55, 3.2, 5, 1, true), crownMat);
  top.position.y = 7.0;
  g.add(trunk, crown, top);
  return g;
}

/** A street light whose arm reaches toward -X (sx = 1) from the pole. */
export function streetLight(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 5.8, 3, 1, true), MATS.metal);
  pole.position.y = 2.9;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 3, 1, true), MATS.metal);
  arm.rotation.z = Math.PI * 0.5;
  arm.position.set(-0.55, 5.65, 0);
  const bulb = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), mat(0xffe29a, 0xffbc5e, 1.4));
  bulb.position.set(-1.1, 5.42, 0);
  g.add(pole, arm, bulb);
  return g;
}

/** Five crosswalk stripes across a road, along X. */
export function crosswalk(): THREE.Group {
  const g = new THREE.Group();
  const m = mat(COLORS.roadLine);
  for (let i = -2; i <= 2; i++) g.add(face(0.34, 2.2, m, "+y", i * 1.45, 0, 0));
  return g;
}

export function crane(height: number): THREE.Group {
  const g = new THREE.Group();
  const craneMat = mat(COLORS.crane);
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.rotation.z = rz;
    g.add(mesh);
  };
  box(1.4, height, 1.4, craneMat, 0, height * 0.5, 0);
  box(34, 1, 1, craneMat, 0, height + 4, 0);
  box(5, 2.2, 1.7, mat(0x384248), -15.5, height + 4.2, 0);
  box(1.2, 0.65, 1.2, MATS.metal, 10, height + 3.35, 0);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 8, 4, 1, true), mat(0x1c2529));
  cable.position.set(10, height, 0);
  g.add(cable);
  box(0.6, 0.8, 0.6, mat(COLORS.hazard, 0xff3c18, 0.75), 10, height, 0);
  for (let y = 6; y < height - 2; y += 7) {
    box(2.1, 0.12, 0.12, MATS.metal, 0, y, 0, Math.PI * 0.25);
    box(2.1, 0.12, 0.12, MATS.metal, 0, y, 0, -Math.PI * 0.25);
  }
  const warning = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), mat(COLORS.hazard, 0xff3c18, 0.75));
  warning.position.set(0, height + 5.15, 0);
  g.add(warning);
  return g;
}

/** addPowerLines at one z: five poles with crossbars and beacons, two lines
 *  and their markers, relative to (0, 0, z). */
export function powerLine(): THREE.Group {
  const g = new THREE.Group();
  const hazard = mat(COLORS.hazard, 0xff3c18, 0.75);
  for (let x = -80; x <= 80; x += 40) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 18, 5, 1, true), MATS.metal);
    pole.position.set(x, 9, 0);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.22, 0.22), MATS.metal);
    cross.position.set(x, 17.8, 0);
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), hazard);
    beacon.position.set(x, 18.25, 0);
    g.add(pole, cross, beacon);
  }
  for (const y of [15, 17]) {
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 160, 4, 1, true), MATS.metal);
    line.rotation.z = Math.PI * 0.5;
    line.position.set(0, y, 0);
    g.add(line);
    for (let x = -60; x <= 60; x += 60) {
      const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.46, 0), hazard);
      marker.position.set(x, y, 0);
      g.add(marker);
    }
  }
  return g;
}

// --- the drone, the package, the pad, traffic, birds -------------------------------

/** The demo's Drone.createModel with its four rotor groups under joints
 *  "r0".."r3", forward -Z. */
export function drone(): THREE.Group {
  const group = new THREE.Group();
  const bodyMat = mat(0xe9f1f1);
  const darkMat = mat(0x151d22);
  const carbonMat = mat(0x202a30);
  const skidMat = mat(0xa7b3b7);
  const glowMat = mat(0x66e8ff, 0x15a9d2, 1.15);
  const amberGlow = mat(0xffc44f, 0xff9d22, 1.1);
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.68, 1.72), bodyMat);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 1.05), carbonMat);
  belly.position.y = -0.44;
  const topPanel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 1.86), glowMat);
  topPanel.position.y = 0.4;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.58, 1.12, 8), glowMat);
  nose.rotation.x = -Math.PI * 0.5;
  nose.position.z = -1.12;
  const cameraBall = new THREE.Mesh(new THREE.SphereGeometry(0.34, 6, 4), mat(0x10171b));
  cameraBall.scale.set(1, 0.72, 1);
  cameraBall.position.set(0, -0.54, -0.58);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.08, 4), mat(0x6ee7ff, 0x27a4d8, 0.72));
  lens.rotation.x = Math.PI * 0.5;
  lens.position.set(0, -0.55, -0.9);
  group.add(body, belly, topPanel, nose, cameraBall, lens);
  const armGeo = new THREE.BoxGeometry(5.2, 0.16, 0.16);
  const arm1 = new THREE.Mesh(armGeo, carbonMat);
  const arm2 = new THREE.Mesh(armGeo, carbonMat);
  arm1.rotation.y = Math.PI * 0.23;
  arm2.rotation.y = -Math.PI * 0.23;
  group.add(arm1, arm2);
  let r = 0;
  for (const x of [-2.15, 2.15]) {
    for (const z of [-1.45, 1.45]) {
      const guard = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.035, 3, 6), darkMat);
      guard.rotation.x = Math.PI * 0.5;
      guard.position.set(x, 0.04, z);
      const motorMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.31, 0.34, 5), darkMat);
      motorMesh.position.set(x, 0.02, z);
      const rotor = new THREE.Joint(`r${r++}`);
      rotor.position.set(x, 0.18, z);
      const bladeA = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.035, 0.15), glowMat);
      const bladeB = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.035, 0.15), glowMat);
      bladeB.rotation.y = Math.PI * 0.5;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 4), amberGlow);
      rotor.add(bladeA, bladeB, cap);
      group.add(guard, motorMesh, rotor);
    }
  }
  const leftNav = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), mat(0xff4b4b, 0xd91b1b, 1));
  leftNav.position.set(-1.48, 0.18, -0.78);
  const rightNav = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), mat(0x70ff9a, 0x17c75a, 1));
  rightNav.position.set(1.48, 0.18, -0.78);
  group.add(leftNav, rightNav);
  const skidRailGeo = new THREE.BoxGeometry(0.12, 0.1, 2.15);
  for (const x of [-0.86, 0.86]) {
    const rail = new THREE.Mesh(skidRailGeo, skidMat);
    rail.position.set(x, -0.82, 0.1);
    // the two struts of a skid as one plate
    const struts = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 1.78), skidMat);
    struts.position.set(x, -0.48, 0.1);
    group.add(rail, struts);
  }
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.25, 0.1), darkMat);
  hook.position.y = -1.08;
  const hookRing = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 3, 6), amberGlow);
  hookRing.rotation.x = Math.PI * 0.5;
  hookRing.position.y = -1.72;
  group.add(hook, hookRing);
  return group;
}

export function packageCrate(): THREE.Group {
  const group = new THREE.Group();
  const darkBand = mat(0x2b353c);
  const glow = mat(0xffd36a, 0xffa526, 1.05);
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 1.6), mat(0xef9b32));
  const lid = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.16, 1.72), mat(0xffba54));
  lid.position.y = 0.68;
  const bandA = new THREE.Mesh(new THREE.BoxGeometry(2.08, 1.28, 0.18), darkBand);
  const bandB = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.3, 1.68), darkBand);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.56, 4, 1, true), darkBand);
  stem.position.y = 1.06;
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), glow);
  beacon.position.y = 1.38;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.48, 0.045, 3, 16), glow);
  ring.rotation.x = Math.PI * 0.5;
  ring.position.y = -0.66;
  group.add(box, lid, bandA, bandB, stem, beacon, ring);
  return group;
}

export function landingPad(): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.25, 4.25, 0.18, 12), mat(0x149a6d));
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 0.2, 10), mat(0x18363c, 0x0f7661, 0.68));
  const marker = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.08, 3, 16), mat(0x6affc7, 0x29d99b, 1.2));
  marker.rotation.x = Math.PI * 0.5;
  marker.position.y = 0.1;
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.25, 8), mat(0x8fffe0, 0x42e0b6, 1.35));
  dot.position.y = 0.08;
  group.add(ring, inner, marker, dot);
  const arrowMat = mat(0x8fffe0, 0x28d7aa, 1.1);
  for (let i = 0; i < 4; i++) {
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 3), arrowMat);
    const angle = i * Math.PI * 0.5;
    arrow.position.set(Math.cos(angle) * 3, 0.2, Math.sin(angle) * 3);
    arrow.rotation.set(Math.PI * 0.5, 0, -angle + Math.PI * 0.5);
    group.add(arrow);
  }
  return group;
}

/** The waypoint arrow of the demo's HUD, as a flat chevron pointing -Z. */
export function waypointArrow(color: number): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.2, 3), m);
  head.rotation.x = -Math.PI / 2;
  head.position.z = -0.9;
  head.scale.set(1, 1, 0.35);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 1.1), m);
  shaft.position.z = 0.2;
  g.add(head, shaft);
  return g;
}

export const TRAFFIC_COLORS = [0xe84a3a, 0xf3c84b, 0x4a7bd8, 0xeeeeee, 0x45b16b];

/** createCarVisual, turned to face -Z, with axles for wheel pairs. */
export function trafficCar(color: number, sign: boolean): THREE.Group {
  const car = new THREE.Group();
  const paint = mat(color);
  const dark = mat(0x171d20);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.62, 3.45), paint);
  body.position.y = 0.42;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.56, 1.36), mat(0x9fd6e8));
  cabin.position.set(0, 0.93, -0.16);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.12, 1.0), paint);
  hood.position.set(0, 0.76, 1.05);
  car.add(body, cabin, hood);
  for (const z of [-1.1, 1.1]) {
    const axle = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.44, 0.44), dark);
    axle.position.set(0, 0.22, z);
    car.add(axle);
  }
  car.add(face(1.3, 0.12, mat(0xfff2c9, 0xffda8a, 1.15), "+z", 0, 0.57, 1.73));
  car.add(face(1.3, 0.12, mat(0xff3b34, 0xcf1818, 0.92), "-z", 0, 0.57, -1.73));
  if (sign) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.18, 0.34), mat(0xffd86a, 0xffb433, 0.8));
    s.position.set(0, 1.32, -0.18);
    car.add(s);
  }
  const g = new THREE.Group();
  car.rotation.y = Math.PI;
  g.add(car);
  return g;
}

/** addBirds' bird, beak toward -Z, its body under a joint for the bob. */
export function bird(): THREE.Group {
  const m = mat(0x22282b);
  const j = new THREE.Joint("bob");
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.4, 5), m);
  body.rotation.x = -Math.PI * 0.5;
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 0.22), m);
  const wingR = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 0.22), m);
  wingL.position.x = -0.58;
  wingR.position.x = 0.58;
  j.add(body, wingL, wingR);
  const g = new THREE.Group();
  g.add(j);
  return g;
}
