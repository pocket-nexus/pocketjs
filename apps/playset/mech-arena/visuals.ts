// Mech Arena's models, ported from GameBlocks' mech-arena
// (https://gb-mech-arena.vercel.app/src/main.js, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; the import moved to the
// playset facade. Deviations: the drones' eye sits at -Z (the playset
// forward; the demo turned +Z to the mech with lookAt), and the missile points
// along -Z (the demo turned +Y along its flight); segment counts are lowered
// for the PICA (pillars 10, spheres 8x6, the missile cone 8); the drones'
// health bars, the guns' recoil and the core's pulse are not drawn.

import * as THREE from "@pocketjs/framework/playset/three";

export const COLORS = {
  ground: 0xb99a64,
  wall: 0x725436,
  wallTrim: 0xe3c178,
  player: 0x7de8ff,
  playerDark: 0x17242c,
  missile: 0xaedfff,
  missileFlame: 0x67c8ff,
  shot: 0xff7661,
};

function part(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

/** The player's mech (the demo's createMech), at scale 1.2. */
export function mech(primary = COLORS.player, dark = COLORS.playerDark): THREE.Group {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: primary, emissive: 0x061f27, roughness: 0.3, metalness: 0.66 });
  const armor = new THREE.MeshStandardMaterial({ color: dark, emissive: 0x061017, roughness: 0.42, metalness: 0.48 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x64f4ff });
  const amber = new THREE.MeshBasicMaterial({ color: 0xffd36a });
  group.add(
    part(1.7, 0.5, 1.0, armor, 0, 1.4, 0), // hips
    part(2.2, 1.35, 1.35, metal, 0, 2.35, 0), // torso
    part(0.95, 0.45, 0.16, glow, 0, 2.58, -0.71), // cockpit
    part(0.42, 0.16, 0.08, amber, 0, 2.25, -0.75), // core
    part(0.8, 0.42, 0.72, armor, 0, 3.23, -0.08), // head
    part(0.45, 1.1, 0.48, armor, -1.5, 2.18, -0.08), // left arm
    part(0.45, 1.1, 0.48, armor, 1.5, 2.18, -0.08), // right arm
    part(0.26, 0.26, 1.7, metal, -1.5, 2.15, -0.96), // left gun
    part(0.26, 0.26, 1.7, metal, 1.5, 2.15, -0.96), // right gun
    part(0.34, 0.34, 0.12, amber, -1.5, 2.15, -1.84), // gun tips
    part(0.34, 0.34, 0.12, amber, 1.5, 2.15, -1.84),
  );
  group.scale.setScalar(1.2);
  return group;
}

export type DroneType = "scout" | "striker" | "bulwark";

/** A drone: emissive box, its translucent shell, a white eye toward its target. */
export function drone(color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.42, roughness: 0.3, metalness: 0.5 });
  const cubeSize = radius * 1.38;
  const body = new THREE.Mesh(new THREE.BoxGeometry(cubeSize, cubeSize * 0.6, cubeSize), material);
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(cubeSize * 1.08, cubeSize * 0.6 * 1.08, cubeSize * 1.08),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  eye.position.set(0, 0.06, -cubeSize * 0.52);
  group.add(core, body, eye);
  return group;
}

/** A missile along -Z: the emissive cone, its flame, a translucent trail. */
export function missile(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.48, 1.8, 8),
    new THREE.MeshStandardMaterial({ color: COLORS.missile, emissive: COLORS.missile, emissiveIntensity: 0.7, roughness: 0.28 }),
  );
  body.rotation.x = -Math.PI / 2;
  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 8, 6),
    new THREE.MeshBasicMaterial({ color: COLORS.missileFlame, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  flame.position.set(0, 0, 1.05);
  const trail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.34, 3.0, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8bd8ff, transparent: true, opacity: 0.36, depthWrite: false }),
  );
  trail.rotation.x = -Math.PI / 2;
  trail.position.set(0, 0, 2.4);
  group.add(trail, body, flame);
  return group;
}

export function shot(color: number): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(0.36, 8, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })));
  return group;
}

/** One pillar of the arena rings: tapered body and a glowing cap. */
export function pillar(bodyRadius: number, height: number): THREE.Group {
  const group = new THREE.Group();
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x937248, roughness: 0.86, metalness: 0.05 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xd8bd79, emissive: 0x3f2c17, roughness: 0.58 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius * 0.68, bodyRadius, height, 10), pillarMat);
  body.position.y = height / 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius, bodyRadius * 1.45, 0.32, 10), capMat);
  cap.position.y = height + 0.08;
  group.add(body, cap);
  return group;
}

/** The four low walls and their trims around a `worldSize` arena. */
export function walls(worldSize: number): THREE.Group {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.82, metalness: 0.08 });
  const trimMat = new THREE.MeshBasicMaterial({ color: COLORS.wallTrim });
  const half = worldSize / 2;
  const wallHeight = 1.15;
  const thickness = 0.8;
  // demo (right, forward) -> playset (x, -z)
  for (const wall of [
    { r: 0, f: half - thickness / 2, w: worldSize, d: thickness },
    { r: 0, f: -half + thickness / 2, w: worldSize, d: thickness },
    { r: half - thickness / 2, f: 0, w: thickness, d: worldSize },
    { r: -half + thickness / 2, f: 0, w: thickness, d: worldSize },
  ]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(wall.w, wallHeight, wall.d), wallMat);
    mesh.position.set(wall.r, wallHeight / 2, -wall.f);
    group.add(mesh);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(wall.w, 0.06, wall.d), trimMat);
    trim.position.set(wall.r, wallHeight + 0.05, -wall.f);
    group.add(trim);
  }
  return group;
}
