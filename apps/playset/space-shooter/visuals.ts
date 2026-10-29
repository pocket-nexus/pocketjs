// Space Shooter's models, ported from GameBlocks' space-shooter demo
// (https://gb-space-shooter.vercel.app/src/game.js, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; only the import moved to the
// playset facade. Deviations: the asteroid's edge lines and the star layers'
// Points became flat triangles (the PICA draws no lines or point sprites
// here), and spinning parts sit under Joints so the kernels turn them.

import * as THREE from "@pocketjs/framework/playset/three";

export const OBJECT_VISUAL_SCALE = 2;

export const PALETTE = {
  spaceDeep: 0x040714,
  spaceFog: 0x10172f,
  playerHull: 0x79ddff,
  playerTrim: 0xe8f4ff,
  playerCore: 0xff6846,
  enemyRed: 0xff5d78,
  enemyRose: 0xff83bd,
  enemyGold: 0xffb15e,
  cyan: 0x66f6ff,
  violet: 0x9577ff,
  magenta: 0xff63b7,
  asteroid: 0x7f8da4,
  asteroidEdge: 0xc9d7e8,
};

export function playerShip(): THREE.Group {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: PALETTE.playerHull, emissive: 0x12364a, emissiveIntensity: 0.28 });
  const hull = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 4), hullMat);
  hull.rotation.x = -Math.PI / 2;
  const wingMat = new THREE.MeshStandardMaterial({ color: PALETTE.playerTrim });
  const leftWing = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.13, 0.5), wingMat);
  leftWing.position.set(-0.78, -0.05, 0.35);
  const rightWing = leftWing.clone();
  rightWing.position.x = 0.78;
  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 18, 10),
    new THREE.MeshStandardMaterial({ color: PALETTE.cyan, emissive: PALETTE.cyan, emissiveIntensity: 0.42, transparent: true, opacity: 0.78 }),
  );
  cockpit.scale.set(0.78, 0.42, 1);
  cockpit.position.set(0, 0.18, -0.18);
  const spine = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.08, 1.35),
    new THREE.MeshStandardMaterial({ color: 0x1b4f68, emissive: 0x0b2734, emissiveIntensity: 0.32 }),
  );
  spine.position.set(0, 0.16, 0.08);
  const engine = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.28, 0.42, 12),
    new THREE.MeshStandardMaterial({ color: PALETTE.playerCore, emissive: PALETTE.playerCore, emissiveIntensity: 1.6 }),
  );
  engine.rotation.x = Math.PI / 2;
  engine.position.z = 1.05;
  const noseLight = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: PALETTE.cyan }));
  noseLight.position.set(0, 0.02, -1.12);
  group.add(hull, leftWing, rightWing, cockpit, spine, engine, noseLight);
  group.scale.setScalar(OBJECT_VISUAL_SCALE);
  return group;
}

/** The shield bubble, a separate model riding on the ship while it lasts. */
export function shieldBubble(): THREE.Group {
  const group = new THREE.Group();
  const bubble = new THREE.Mesh(
    new THREE.SphereGeometry(1.45, 28, 16),
    new THREE.MeshBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending }),
  );
  group.add(bubble);
  group.scale.setScalar(OBJECT_VISUAL_SCALE);
  return group;
}

export type EnemyType = "grunt" | "dart" | "heavy";

export function enemyShip(type: EnemyType): THREE.Group {
  const group = new THREE.Group();
  const color = type === "heavy" ? PALETTE.enemyGold : type === "dart" ? PALETTE.enemyRose : PALETTE.enemyRed;
  const bodyMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: type === "heavy" ? 0.22 : 0.34 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(type === "heavy" ? 0.9 : 0.62, type === "heavy" ? 2.2 : 1.65, 5), bodyMat);
  // the demo's lookAt points +Z at the player; the playset forward is -Z
  body.rotation.x = -Math.PI / 2;
  const finMat = new THREE.MeshStandardMaterial({ color: 0x2d1424, emissive: 0x3a0c1d, emissiveIntensity: 0.45 });
  const leftFin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, type === "heavy" ? 1.05 : 0.72), finMat);
  leftFin.position.set(-0.6, -0.02, -0.15);
  leftFin.rotation.z = 0.16;
  const rightFin = leftFin.clone();
  rightFin.position.x = 0.6;
  rightFin.rotation.z = -0.16;
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(type === "heavy" ? 0.48 : 0.34, 16, 10),
    new THREE.MeshStandardMaterial({ color: 0x2b0e17, emissive: color, emissiveIntensity: 0.9 }),
  );
  core.position.z = 0.28;
  group.add(body, leftFin, rightFin, core);
  group.scale.setScalar(OBJECT_VISUAL_SCALE);
  return group;
}

/** ProjectileVisual: a glow capsule over an emissive core, along -Z. */
export function bolt(color: number, radius: number, length: number): THREE.Group {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius * 2.5, length * 1.12, 1, 4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending }),
  );
  glow.rotation.x = Math.PI / 2;
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, length, 1, 4),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );
  body.rotation.x = Math.PI / 2;
  group.add(glow, body);
  group.scale.setScalar(OBJECT_VISUAL_SCALE);
  return group;
}

/** A unit asteroid; instances scale it by their radius. */
export function asteroid(): THREE.Group {
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: PALETTE.asteroid, emissive: 0x0a0f17, emissiveIntensity: 0.18, flatShading: true }),
  );
  rock.userData.jitter = 0.16;
  const spin = new THREE.Joint("rock");
  spin.add(rock);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

export type PickupType = "rapid" | "shield" | "health";

export function pickupColor(type: PickupType): number {
  return type === "rapid" ? 0x8bff7a : type === "shield" ? 0x58a6ff : 0xff5f8f;
}

export function pickup(type: PickupType): THREE.Group {
  const color = pickupColor(type);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.65, 0), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 }));
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.92, 0.035, 8, 44),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.48, blending: THREE.AdditiveBlending }),
  );
  ring.rotation.x = Math.PI / 2;
  const spin = new THREE.Joint("spin");
  spin.add(core, ring);
  const group = new THREE.Group();
  group.add(spin);
  group.scale.setScalar(OBJECT_VISUAL_SCALE);
  return group;
}

/** A small seeded generator, the demo's Mulberry32. */
export function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A star layer as flat unlit triangles facing the camera (+Z), one part per colour. */
export function starLayer(
  random: () => number,
  o: { count: number; right: number; upMin: number; upMax: number; forwardMin: number; forwardMax: number; size: number; colors: readonly number[] },
): THREE.Group {
  const group = new THREE.Group();
  const per = Math.ceil(o.count / o.colors.length);
  for (const color of o.colors) {
    const positions = new Float32Array(per * 9);
    for (let i = 0; i < per; i++) {
      const x = (random() * 2 - 1) * o.right;
      const y = o.upMin + random() * (o.upMax - o.upMin);
      // forward is -Z
      const z = -(o.forwardMin + random() * (o.forwardMax - o.forwardMin));
      const s = o.size * (0.7 + random() * 0.6);
      positions.set([x - s, y - s * 0.6, z, x + s, y - s * 0.6, z, x, y + s, z], i * 9);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
    mesh.userData.noBounds = false;
    group.add(mesh);
  }
  return group;
}

export function distantPlanet(o: { color: number; accent: number; radius: number; ring: boolean }): THREE.Group {
  const group = new THREE.Group();
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(o.radius, 32, 18),
    new THREE.MeshStandardMaterial({ color: o.color, emissive: o.color, emissiveIntensity: 0.1 }),
  );
  if (o.ring) {
    const ringMesh = new THREE.Mesh(
      new THREE.TorusGeometry(o.radius * 1.55, 0.08, 8, 72),
      new THREE.MeshBasicMaterial({ color: o.accent, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending }),
    );
    ringMesh.rotation.x = Math.PI * 0.55;
    ringMesh.rotation.z = Math.PI * 0.12;
    group.add(ringMesh);
  }
  group.add(planet);
  return group;
}
