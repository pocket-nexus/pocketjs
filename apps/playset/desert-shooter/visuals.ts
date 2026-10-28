// Desert Shooter's models, ported from GameBlocks' desert-shooter
// (https://gb-desert-shooter.vercel.app/src/main.js, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; the import moved to the
// playset facade. Deviations: the rover's turret is a Joint the gun turns;
// segment counts are lowered for the PICA (wheels 10, capsules 3x8, eyes
// 6x4, scrub cones open-ended); a cliff and a mesa are unit models scaled at
// placement; the pickups' point lights became emissive cores; the wheels do
// not spin (they are round, so the demo's spin shows nothing).

import * as THREE from "@pocketjs/framework/playset/three";

function makeMat(color: number, roughness = 0.9, metalness = 0, extra: THREE.MaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

/** The rover: body, cabin, stripe, wheels, headlights; joint "turret". */
export function rover(): THREE.Group {
  const group = new THREE.Group();
  const bodyMat = makeMat(0xb64832, 0.62, 0.04);
  const armorMat = makeMat(0x2d3540, 0.55, 0.18);
  const trimMat = makeMat(0xe8b65a, 0.5, 0.06);
  const lightMat = makeMat(0xfff0aa, 0.32, 0.04, { emissive: 0xffc55a, emissiveIntensity: 0.75 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.75, 5.2), bodyMat);
  body.position.y = 0.78;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 1.7), armorMat);
  cabin.position.set(0, 1.38, -0.45);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 4.65), trimMat);
  stripe.position.set(0, 1.18, -0.04);
  const turret = new THREE.Joint("turret");
  turret.position.set(0, 1.86, -0.4);
  turret.scale.setScalar(0.8);
  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.46, 10), armorMat);
  turretBase.position.y = 0.18;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 2.65), makeMat(0x17191c, 0.42, 0.35));
  barrel.position.set(0, 0.28, -1.42);
  turret.add(turretBase, barrel);
  group.add(body, cabin, stripe, turret);
  for (const x of [-1.55, 1.55]) {
    for (const z of [-1.75, 1.75]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.48, 10), makeMat(0x111111, 0.8));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.42, z);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.52, 8), trimMat);
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(wheel.position);
      group.add(wheel, hub);
    }
  }
  for (const x of [-0.95, 0.95]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.08), lightMat);
    headlight.position.set(x, 1.02, -2.86);
    group.add(headlight);
  }
  return group;
}

export type EnemyType = "chase" | "charge" | "spit" | "boss";

export const ENEMY_COLOR: Record<EnemyType, number> = { boss: 0x7e2632, spit: 0x356d64, charge: 0x8a5c2c, chase: 0x4d7f32 };

/** A dinosaur of `radius`: the demo's sideways capsule body, head, tail, eyes, legs. */
export function dinosaur(type: EnemyType, radius: number): THREE.Group {
  const group = new THREE.Group();
  const color = ENEMY_COLOR[type];
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.55, radius * 1.75, 3, 8), makeMat(color, 0.82));
  body.rotation.z = Math.PI / 2;
  body.position.y = radius * 0.85;
  const head = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.95, radius * 0.78, radius * 0.9), makeMat(color + 0x101010, 0.8));
  head.position.set(0, radius * 1.28, -radius * 0.98);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.35, radius * 1.7, 6), makeMat(color, 0.84));
  tail.position.set(0, radius * 0.9, radius * 1.45);
  tail.rotation.x = Math.PI / 2;
  const eyeMat = makeMat(0xfff0a0, 0.45, 0.02, { emissive: 0xffa63f, emissiveIntensity: 0.42 });
  for (const x of [-radius * 0.22, radius * 0.22]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.08, 6, 4), eyeMat);
    eye.position.set(x, radius * 1.39, -radius * 1.44);
    group.add(eye);
  }
  const legMat = makeMat(0x2c241b, 0.86);
  for (const x of [-radius * 0.38, radius * 0.38]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.22, radius * 0.9, radius * 0.24), legMat);
    leg.position.set(x, radius * 0.35, 0.15);
    group.add(leg);
  }
  group.add(body, head, tail);
  return group;
}

/** A shot: dark for the rover's gun, green for the dinosaurs' spit. */
export function projectile(source: "player" | "enemy"): THREE.Group {
  const color = source === "player" ? 0x151515 : 0x9cff65;
  const radius = source === "player" ? 0.23 : 0.17;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 6, 4), new THREE.MeshBasicMaterial({ color })));
  return group;
}

export type PickupType = "repair" | "ammo" | "upgrade";

export function pickupColor(type: PickupType): number {
  return type === "repair" ? 0x40e080 : type === "ammo" ? 0xe6c044 : 0x67c7ff;
}

/** A pickup floating 1.15 m up; joint "spin" turns it. */
export function pickup(type: PickupType): THREE.Group {
  const color = pickupColor(type);
  const spin = new THREE.Joint("spin");
  spin.position.y = 1.15;
  const core = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 1.05), makeMat(color, 0.48, 0.12, { emissive: color, emissiveIntensity: 0.45 }));
  core.rotation.set(0.28, 0.42, 0.08);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.045, 4, 16), makeMat(0xf8f0c8, 0.35, 0.05, { emissive: color, emissiveIntensity: 0.6 }));
  ring.rotation.x = Math.PI / 2;
  spin.add(core, ring);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** A mesa at scale 1 (the demo multiplies every size and height by its scale). */
export function mesa(): THREE.Group {
  const group = new THREE.Group();
  const baseMat = makeMat(0x9d6540, 0.96);
  const capMat = makeMat(0x714833, 0.98);
  for (const tier of [
    { y: 1.5, w: 15, h: 3, d: 7 },
    { y: 4.2, w: 11, h: 2.4, d: 5.5 },
    { y: 6.15, w: 7.5, h: 1.5, d: 4.2 },
  ]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(tier.w, tier.h, tier.d), tier.y > 5 ? capMat : baseMat);
    mesh.position.y = tier.y;
    group.add(mesh);
  }
  return group;
}

export function cactus(): THREE.Group {
  const group = new THREE.Group();
  const mat = makeMat(0x2f7b4a, 0.72);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.48, 4.8, 7), mat);
  trunk.position.y = 2.4;
  const armA = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 2.1, 6), mat);
  armA.position.set(0.75, 2.9, 0);
  armA.rotation.z = Math.PI / 2;
  const armB = armA.clone();
  armB.position.set(-0.72, 2.0, 0);
  group.add(trunk, armA, armB);
  return group;
}

export function rocks(): THREE.Group {
  const group = new THREE.Group();
  const mat = makeMat(0x786756, 0.95, 0, { flatShading: true });
  for (let i = 0; i < 3; i += 1) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.75 + i * 0.35, 0), mat);
    rock.position.set(i * 0.8 - 0.8, 0.35, Math.sin(i) * 0.5);
    rock.scale.set(1.4, 0.7, 1.1);
    group.add(rock);
  }
  return group;
}

/** A cliff of radius 1; placed at scale = the prop's radius. */
export function cliff(): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 1), makeMat(0x9a6740, 0.98));
  base.position.y = 0.6;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 1.1), makeMat(0x6f4b34, 0.98));
  cap.position.y = 1.22;
  group.add(base, cap);
  return group;
}

export function scrub(): THREE.Group {
  const group = new THREE.Group();
  const mat = makeMat(0x6e8b3d, 0.86);
  for (let i = 0; i < 5; i += 1) {
    const stem = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 4, 1, true), mat);
    stem.position.set(Math.cos(i) * 0.45, 0.45, Math.sin(i) * 0.45);
    stem.rotation.set(0.2, i, -0.2);
    group.add(stem);
  }
  return group;
}

export function bones(): THREE.Group {
  const group = new THREE.Group();
  const boneMat = makeMat(0xd7c6a1, 0.78, 0, { flatShading: true });
  const skull = new THREE.Mesh(new THREE.DodecahedronGeometry(0.48, 0), boneMat);
  skull.position.y = 0.38;
  skull.scale.set(1.2, 0.75, 0.85);
  group.add(skull);
  for (let i = 0; i < 3; i += 1) {
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 5), makeMat(0xd7c6a1, 0.78));
    bone.position.set(i * 0.38 - 0.38, 0.22, Math.sin(i) * 0.35);
    bone.rotation.x = Math.PI / 2;
    group.add(bone);
  }
  return group;
}

/** The sun disc low over the dunes (the demo's makeSunDisk). */
export function sunDisk(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.CircleGeometry(16, 16), new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.68 })));
  return group;
}
