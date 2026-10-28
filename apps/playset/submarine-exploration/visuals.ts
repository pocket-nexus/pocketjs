// Submarine Exploration's models, ported from GameBlocks' submarine-exploration
// (https://gb-submarine-exploration.vercel.app/, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; the import moved to the
// playset facade. Deviations: segment counts are lowered for the PICA (the
// demo's 18-24 radial segments become 6-12); glow sprites became faint
// additive spheres; the double-sided kelp blades are two planes back to back
// (the playset culls back faces); the fish's translucent dorsal fin is
// opaque; the demo's per-placement scenery (280 corals, 136 outcrops, 96
// anemones, a 24 m sea-grass grid) becomes a few seeded variants placed as
// static scenery; the spinning parts sit under Joints so the kernels turn them.
// The demo's basis is z-up; here y is up and forward is -Z, which is also the
// local frame the demo's setObjectFrame gives every model.

import * as THREE from "@pocketjs/framework/playset/three";
import type { Random } from "../kit/random.ts";

export const PALETTE = {
  abyss: 0x082431,
  water: 0x0d5260,
  teal: 0x58f0d2,
  cyan: 0x80e7ff,
  reefGreen: 0x4bd6a2,
  coral: 0xff788e,
  amber: 0xffc15a,
  lavender: 0x9f91ff,
  sand: 0x7f9483,
  stone: 0x81958f,
  shell: 0xf6dfae,
  sky: 0x8fdcff,
  fog: 0x8acfe6,
};

const std = (o: THREE.MaterialParameters) => new THREE.MeshStandardMaterial(o);

/** makeGlowSprite: an additive sphere of the sprite's radius. */
function glow(color: number, scale: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(scale * 0.5, 7, 5),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending }),
  );
}

/** The player's submarine: the demo's sideways capsule hull, nose, tail, bands,
 *  fins, portholes, canopy and the guarded tail propeller (joint "rotor"). */
export function submarine(): THREE.Group {
  const group = new THREE.Group();
  group.scale.setScalar(2);
  const hullMat = std({ color: 0xf0c94d, emissive: 0x352400, emissiveIntensity: 0.025 });
  const trimMat = std({ color: 0xffeaa0 });
  const darkMat = std({ color: 0x584b1b });
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(1.05, 3.8, 4, 12), hullMat);
  hull.rotation.z = Math.PI / 2;
  group.add(hull);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.04, 1.45, 12), trimMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -2.6;
  group.add(nose);

  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.92, 1.0, 12), darkMat);
  tail.rotation.x = Math.PI / 2;
  tail.position.z = 2.5;
  group.add(tail);

  const bandMat = std({ color: 0xffefb8 });
  for (const z of [-1.65, 0.15, 1.72]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.035, 4, 12), bandMat);
    band.position.z = z;
    group.add(band);
  }

  const finMat = std({ color: 0xffefb8 });
  for (const [x, y, rz] of [[0, 1.05, 0], [0, -1.05, Math.PI], [1.05, 0, Math.PI / 2], [-1.05, 0, -Math.PI / 2]]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.82, 1.45), finMat);
    fin.position.set(x, y, 2.25);
    fin.rotation.z = rz;
    group.add(fin);
  }

  const portMat = std({ color: 0x9df4ff, emissive: 0x0a6f7d, emissiveIntensity: 0.16 });
  for (const [x, z] of [[-0.78, -0.55], [-0.78, 0.45], [0.78, -0.55], [0.78, 0.45]]) {
    const port = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 4), portMat);
    port.position.set(x, 0.34, z);
    group.add(port);
  }

  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 6), std({ color: 0xa9fbff, emissive: 0x0b6d79, emissiveIntensity: 0.14 }));
  glass.position.set(0, 0.62, -1.15);
  group.add(glass);

  const propMat = std({ color: 0xe4f8d3 });
  const propeller = new THREE.Group();
  propeller.position.set(0, 0, 3.18);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.34, 8), darkMat);
  hub.rotation.x = Math.PI / 2;
  propeller.add(hub);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.032, 4, 16), propMat);
  propeller.add(guard);
  const rotor = new THREE.Joint("rotor");
  for (let i = 0; i < 4; i += 1) {
    const bladeAngle = (Math.PI / 2) * i + 0.28;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.64, 0.055), propMat);
    blade.position.set(-Math.sin(bladeAngle) * 0.32, Math.cos(bladeAngle) * 0.32, 0);
    blade.rotation.z = bladeAngle;
    rotor.add(blade);
  }
  rotor.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), propMat));
  propeller.add(rotor);
  group.add(propeller);

  // the headlamp's glow sprite (the SpotLight itself has no counterpart)
  const lamp = glow(0x9df4ff, 2.7, 0.14);
  lamp.position.set(0, 0, -2.85);
  group.add(lamp);
  return group;
}

/** addCreatureView: the hostile eel-thing with its jaw, fins, eyes and red glow. */
export function creature(): THREE.Group {
  const group = new THREE.Group();
  const mat = std({ color: 0x8e3158, emissive: 0x2a0713, emissiveIntensity: 0.16 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.25, 3.7, 3, 10), mat);
  body.rotation.z = Math.PI / 2;
  group.add(body);
  const jaw = new THREE.Mesh(new THREE.ConeGeometry(1.12, 1.5, 10), mat);
  jaw.rotation.x = -Math.PI / 2;
  jaw.position.z = -2.6;
  group.add(jaw);
  const finMat = std({ color: 0xbd5478 });
  for (const [x, y, rz] of [[0, 1.05, 0], [0, -1.05, Math.PI], [1.1, 0, Math.PI / 2], [-1.1, 0, -Math.PI / 2]]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.25, 3), finMat);
    fin.position.set(x, y, 0.55);
    fin.rotation.z = rz;
    fin.rotation.x = Math.PI / 2;
    group.add(fin);
  }
  const eyeMat = std({ color: 0xff6e79, emissive: 0xff3048, emissiveIntensity: 0.8 });
  for (const x of [-0.38, 0.38]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), eyeMat);
    eye.position.set(x, 0.32, -2.1);
    group.add(eye);
  }
  const danger = glow(0xff405f, 5, 0.12);
  danger.position.z = -0.8;
  group.add(danger);
  return group;
}

export type PickupType = "crystal" | "salvage";

export function pickupColor(type: PickupType): number {
  return type === "crystal" ? 0x68ffdc : 0xffd05e;
}

/** makePickupVisual: the energy crystal or the salvage lump, with its glow. */
export function pickup(type: PickupType): THREE.Group {
  const color = pickupColor(type);
  const spin = new THREE.Joint("spin");
  spin.add(
    new THREE.Mesh(
      type === "crystal" ? new THREE.OctahedronGeometry(1, 0) : new THREE.DodecahedronGeometry(0.9, 0),
      std({ color, emissive: color, emissiveIntensity: 0.32, flatShading: true }),
    ),
  );
  spin.add(glow(color, type === "crystal" ? 5.2 : 4.2, type === "crystal" ? 0.3 : 0.22));
  const group = new THREE.Group();
  group.add(spin);
  if (type === "crystal") group.scale.setScalar(0.9);
  return group;
}

/** The artifact marker: a translucent icosahedron in its glow. */
export function artifact(): THREE.Group {
  const spin = new THREE.Joint("spin");
  spin.add(
    new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.35, 1),
      std({ color: 0x68ddff, emissive: 0x0d8ead, emissiveIntensity: 0.42, transparent: true, opacity: 0.56, flatShading: true }),
    ),
  );
  spin.add(glow(0x6fefff, 7.2, 0.24));
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** The stone pedestal under an artifact (static scenery). */
export function pedestal(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 2.2, 1.0, 9), std({ color: 0x6f847e }));
  return mesh;
}

/** The upgrade station: base, four arms with lamps, and its big teal glow,
 *  turning slowly (joint "spin"). */
export function station(): THREE.Group {
  const spin = new THREE.Joint("spin");
  const stationMat = std({ color: 0x35c5b8, emissive: 0x075f58, emissiveIntensity: 0.18 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.6, 2.2, 12), stationMat);
  base.position.y = -1.2;
  spin.add(base);
  const padMat = std({ color: 0x95f2df, emissive: 0x0d6d62, emissiveIntensity: 0.16 });
  const lampMat = std({ color: 0xaaffef, emissive: 0x44ffd0, emissiveIntensity: 0.7 });
  for (let i = 0; i < 4; i += 1) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 6.5), padMat);
    arm.position.set(Math.cos((i * Math.PI) / 2) * 3.2, -0.05, Math.sin((i * Math.PI) / 2) * 3.2);
    arm.rotation.y = (i * Math.PI) / 2;
    spin.add(arm);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), lampMat);
    lamp.position.set(Math.cos((i * Math.PI) / 2) * 5.2, 0.18, Math.sin((i * Math.PI) / 2) * 5.2);
    spin.add(lamp);
  }
  const halo = glow(PALETTE.teal, 14, 0.2);
  halo.position.y = 1.4;
  spin.add(halo);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** makeFish: a cone body, a three-sided tail and a dorsal fin. */
export function fish(color: number): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.5, 6), std({ color, emissive: color, emissiveIntensity: 0.06 }));
  body.rotation.x = -Math.PI / 2;
  group.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.55, 3), std({ color: 0xd7fbff }));
  tail.position.z = 0.86;
  tail.rotation.x = Math.PI / 2;
  group.add(tail);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 3), std({ color: 0xb6f5ff }));
  dorsal.position.set(0, 0.36, 0.05);
  group.add(dorsal);
  return group;
}

/** addFishSchool: members at fixed offsets; the school as one model moves
 *  along its loop. White-ish, so a slot's tint gives it the school's colour. */
export function school(random: Random, count: number): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < count; i += 1) {
    const f = fish(0xffffff);
    f.scale.setScalar(random.uniform(0.65, 0.95));
    f.position.set(random.uniform(-7, 7), random.uniform(-2.4, 2.4), random.uniform(-5, 5));
    group.add(f);
  }
  return group;
}

const CORAL_COLORS = [PALETTE.coral, PALETTE.reefGreen, PALETTE.amber, PALETTE.lavender, 0xe5f07a];

/** makeCoral: branching stems with round tips on a flattened stone base. */
export function coral(random: Random, variant: number): THREE.Group {
  const group = new THREE.Group();
  const color = CORAL_COLORS[variant % CORAL_COLORS.length];
  const mat = std({ color, emissive: color, emissiveIntensity: 0.05 });
  const branches = Math.floor(random.uniform(3, 6));
  for (let i = 0; i < branches; i += 1) {
    const h = random.uniform(1.4, 4.6);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(random.uniform(0.05, 0.13), random.uniform(0.16, 0.32), h, 5), mat);
    const x = random.uniform(-1.2, 1.2);
    const z = random.uniform(-1.2, 1.2);
    const rx = random.uniform(-0.45, 0.45);
    const rz = random.uniform(-0.45, 0.45);
    stem.position.set(x, h * 0.5, z);
    stem.rotation.set(rx, 0, rz);
    group.add(stem);
    const tip = new THREE.Mesh(new THREE.OctahedronGeometry(random.uniform(0.09, 0.16) * 1.5, 0), mat);
    // the demo puts the tip straight above the stem's centre
    tip.position.set(x, h * 0.98, z);
    group.add(tip);
  }
  const base = new THREE.Mesh(new THREE.DodecahedronGeometry(random.uniform(0.55, 1.1), 0), std({ color: 0x405c58, flatShading: true }));
  base.scale.set(random.uniform(1.1, 1.8), random.uniform(0.35, 0.7), random.uniform(0.9, 1.5));
  group.add(base);
  return group;
}

/** makeRockOutcrop: a cluster of flattened dodecahedrons. */
export function rockOutcrop(random: Random): THREE.Group {
  const group = new THREE.Group();
  const rockMat = std({ color: 0x415d5b, flatShading: true });
  const count = Math.floor(random.uniform(3, 6));
  for (let i = 0; i < count; i += 1) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(random.uniform(0.8, 2.4), 0), rockMat);
    rock.scale.set(random.uniform(0.8, 1.7), random.uniform(0.35, 1.25), random.uniform(0.75, 1.55));
    rock.position.set(random.uniform(-2.7, 2.7), rock.scale.y * 0.8, random.uniform(-2.7, 2.7));
    rock.rotation.set(random.uniform(-0.35, 0.35), random.uniform(0, Math.PI * 2), random.uniform(-0.28, 0.28));
    group.add(rock);
  }
  return group;
}

/** makeAnemone: tentacles around a ring, each with a pale tip. */
export function anemone(random: Random): THREE.Group {
  const group = new THREE.Group();
  const mat = std({ color: 0xff8fa3, emissive: 0x4a101b, emissiveIntensity: 0.08 });
  const tipMat = std({ color: 0xffd9af, emissive: 0xff6f91, emissiveIntensity: 0.12 });
  const n = 8;
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const h = random.uniform(0.8, 1.7);
    const tentacle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, h, 4, 1, true), mat);
    tentacle.position.set(Math.cos(a) * 0.24, h * 0.5, Math.sin(a) * 0.24);
    tentacle.rotation.z = Math.cos(a) * random.uniform(0.15, 0.42);
    tentacle.rotation.x = Math.sin(a) * random.uniform(0.15, 0.42);
    group.add(tentacle);
    const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), tipMat);
    tip.position.set(Math.cos(a) * 0.42, h, Math.sin(a) * 0.42);
    group.add(tip);
  }
  return group;
}

interface Blade { x: number; z: number; w: number; h: number; ry: number; rz: number }

/** SEA_GRASS_TYPES: the demo's three sea-grass kinds, blades only. */
export const SEA_GRASS = [
  {
    bladeColor: 0x45c982,
    emissive: 0x0a2f20,
    blades: [
      { x: -1.08, z: -0.56, w: 0.54, h: 6.2, ry: 0.05, rz: -0.12 },
      { x: -0.58, z: 0.46, w: 0.56, h: 6.8, ry: 1.2, rz: 0.08 },
      { x: 0.02, z: -0.18, w: 0.6, h: 7.2, ry: 2.35, rz: 0.02 },
      { x: 0.58, z: 0.5, w: 0.52, h: 6.1, ry: 3.45, rz: -0.08 },
      { x: 1.02, z: -0.42, w: 0.5, h: 5.8, ry: 4.7, rz: 0.12 },
    ],
  },
  {
    bladeColor: 0x4bd0bf,
    emissive: 0x083a3b,
    blades: [
      { x: -1.22, z: 0.18, w: 0.78, h: 4.8, ry: 0.35, rz: 0.2 },
      { x: -0.62, z: -0.4, w: 0.82, h: 5.4, ry: 1.45, rz: -0.12 },
      { x: 0.0, z: 0.15, w: 0.86, h: 5.8, ry: 2.6, rz: 0.04 },
      { x: 0.62, z: -0.34, w: 0.82, h: 5.4, ry: 3.75, rz: 0.12 },
      { x: 1.22, z: 0.22, w: 0.78, h: 4.8, ry: 4.85, rz: -0.2 },
    ],
  },
  {
    bladeColor: 0xb8d876,
    emissive: 0x263314,
    blades: [
      { x: -0.95, z: -0.65, w: 0.32, h: 3.8, ry: 0.15, rz: -0.24 },
      { x: -0.52, z: 0.35, w: 0.34, h: 4.3, ry: 1.05, rz: 0.18 },
      { x: 0.0, z: -0.05, w: 0.36, h: 4.8, ry: 2.1, rz: 0.0 },
      { x: 0.52, z: 0.35, w: 0.34, h: 4.3, ry: 3.15, rz: -0.18 },
      { x: 0.95, z: -0.65, w: 0.32, h: 3.8, ry: 4.2, rz: 0.24 },
      { x: 0.0, z: 0.75, w: 0.32, h: 4.0, ry: 5.1, rz: 0.08 },
    ],
  },
] as const;

/** One sea-grass clump: each blade a plane standing on the floor, with a
 *  second plane turned around so it reads from both sides. */
export function seaGrass(type: number): THREE.Group {
  const t = SEA_GRASS[type];
  const mat = std({ color: t.bladeColor, emissive: t.emissive, emissiveIntensity: 0.08 });
  const group = new THREE.Group();
  for (const b of t.blades as readonly Blade[]) {
    const blade = new THREE.Group();
    blade.position.set(b.x, b.h * 0.5 + 0.08, b.z);
    blade.rotation.set(0, b.ry, b.rz, "YXZ");
    const front = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), mat);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), mat);
    back.rotation.y = Math.PI;
    blade.add(front, back);
    group.add(blade);
  }
  return group;
}

/** Four clumps of mixed kinds on a `spacing` square, the demo's jittered
 *  grid in one model: one static node per four clumps keeps the field to a
 *  quarter of the batch cells (and their draws). */
export function seaGrassMeadow(random: Random, spacing: number): THREE.Group {
  const group = new THREE.Group();
  for (const [ox, oz] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ]) {
    const clump = seaGrass(Math.floor(random() * 3));
    clump.position.set((ox + random.uniform(-0.32, 0.32)) * spacing, 0, (oz + random.uniform(-0.32, 0.32)) * spacing);
    clump.rotation.y = random.uniform(0, Math.PI * 2);
    clump.scale.setScalar(random.uniform(0.85, 1.15));
    group.add(clump);
  }
  return group;
}

/** addLightShaft: a soft additive column from the surface, as two crossed
 *  planes cut into a 3x3 grid whose opacities stand in for the shader's
 *  fades (bright core, dim edges, fading in at the top and out below),
 *  turning slowly. */
export function lightShaft(radius: number, opacity: number, height = 112): THREE.Group {
  const spin = new THREE.Joint("spin");
  const rows = [
    [0.2, 0.45],
    [0.45, 1],
    [0.35, 0.4],
  ] as const;
  const width = radius * 1.8;
  const cols = [
    [-0.36, 0.28, 0.35],
    [0, 0.44, 1],
    [0.36, 0.28, 0.35],
  ] as const;
  const mats = new Map<number, THREE.MeshBasicMaterial>();
  const mat = (k: number) => {
    let m = mats.get(k);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: 0x9df4ff, transparent: true, opacity: opacity * k, blending: THREE.AdditiveBlending });
      mats.set(k, m);
    }
    return m;
  };
  for (const ry of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const plane = new THREE.Group();
    plane.rotation.y = ry;
    let top = 0;
    for (const [frac, kr] of rows) {
      const h = height * frac;
      for (const [cx, cw, kc] of cols) {
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(width * cw, h), mat(Math.round(kr * kc * 100) / 100));
        strip.position.set(cx * width, -(top + h * 0.5), 0);
        plane.add(strip);
      }
      top += h;
    }
    spin.add(plane);
  }
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** addActionPulse: the scan ring, a unit torus on the ground plane. */
export function pulseRing(): THREE.Group {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.025, 4, 16),
    new THREE.MeshBasicMaterial({ color: 0xbaffff, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending }),
  );
  ring.rotation.x = Math.PI / 2;
  const group = new THREE.Group();
  group.add(ring);
  return group;
}

/** The heading marker that stands in for the demo's radar: a small glowing
 *  chevron above the hull pointing at the current objective. */
export function headingMarker(): THREE.Group {
  const mat = std({ color: 0x62ffce, emissive: 0x62ffce, emissiveIntensity: 1 });
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 3), mat);
  arrow.rotation.x = -Math.PI / 2;
  arrow.scale.set(1, 1, 0.35);
  const group = new THREE.Group();
  group.add(arrow);
  return group;
}
