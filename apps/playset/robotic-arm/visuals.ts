// Robotic Arm's models, ported from GameBlocks' robotic-arm demo
// (https://gb-robotic-arm.vercel.app/src/game.js, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's boxes, cylinders, spheres and colours. The
// demo's basis is right = +x, up = +z, forward = +y; the playset's is right
// = +X, up = +Y, forward = -Z, so a demo point (right, up, forward) sits at
// (right, up, -forward) and a demo basisBox(width, height, depth) is the
// same BoxGeometry here. Deviations: the point lights, shadow maps and
// metalness are gone (the light strips stay as unlit bars); the arm's two
// segments are separate models with their lengths baked in, because both
// keep a fixed length under the demo's IK; the fingers hinge at the bridge
// instead of sliding (the same 3 cm of travel at the pads); the cans' rims
// use 4x14 segments; and the screen-centre crosshair is a small unlit
// cross one metre in front of the eye.

import * as THREE from "@pocketjs/framework/playset/three";

export const TABLE_TOP = 0.58;
export const CAN_RADIUS = 0.16;
export const CAN_HALF_HEIGHT = 0.29;
/** the can model stands on its origin; its centre (the demo's group
 *  position, 4 mm above the table) is CAN_LIFT up */
export const CAN_LIFT = CAN_HALF_HEIGHT + 0.004;
export const UPPER_LENGTH = 0.749;
export const FOREARM_LENGTH = 0.93;
export const CLAW_GRIP_LOCAL_Y = 0.24;
export const CLAW_GRIP_LOCAL_Z = -0.36;
export const CLAW_OPEN_GAP = 0.34;
const CLAW_CAN_VISUAL_CLEARANCE = 0.22;
const CLAW_FINGER_WIDTH = 0.075;
export const CLAW_HOLD_GAP = (CAN_RADIUS * 2 + CLAW_CAN_VISUAL_CLEARANCE + CLAW_FINGER_WIDTH) * 0.5;
/** the finger hinge sits at the bridge; the pad is this far ahead of it */
export const FINGER_HINGE_REACH = 0.44;

export const TABLES = {
  serve: { centerRight: -2.05, centerForward: 2.0, halfRight: 0.85, halfForward: 1.75 },
  receive: { centerRight: 2.05, centerForward: 2.0, halfRight: 0.85, halfForward: 1.75 },
} as const;

const FACTORY_WALLS = { halfRight: 5.45, frontForward: -3.08, backForward: 5.38, height: 3.05, thickness: 0.18 };

export const PALETTE = {
  background: 0x172123,
  floor: 0x263030,
  floorPad: 0x303c39,
  techPanel: 0x18282b,
  techPanelLight: 0x385054,
  screenGlow: 0x7de7f3,
  factoryWall: 0x202b2d,
  factoryWallPanel: 0x2b393b,
  factoryWallTrim: 0x11191b,
  factoryGlow: 0x6ce5f0,
  table: 0x56625f,
  tableLeg: 0x2e383a,
  armDark: 0xf0aa14,
  armLight: 0xffd64d,
  joint: 0xf5bf2f,
  claw: 0xb8c0bd,
  clawDark: 0x596263,
  ghost: 0xffd64d,
};

export const CARGO = [
  { id: "red", label: "Red can", color: 0xe85b62, right: -1.65, forward: 1.0 },
  { id: "green", label: "Green can", color: 0x64c878, right: -1.65, forward: 2.0 },
  { id: "blue", label: "Blue can", color: 0x58a9ff, right: -1.65, forward: 3.0 },
] as const;

const std = (color: number, emissive = 0, emissiveIntensity = 1) =>
  new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity });

const materials = {
  floor: std(PALETTE.floor),
  floorPad: std(PALETTE.floorPad),
  techPanel: std(PALETTE.techPanel),
  techPanelLight: std(PALETTE.techPanelLight),
  screenGlow: new THREE.MeshBasicMaterial({ color: PALETTE.screenGlow }),
  factoryWall: std(PALETTE.factoryWall),
  factoryWallPanel: std(PALETTE.factoryWallPanel),
  factoryWallTrim: std(PALETTE.factoryWallTrim),
  factoryGlow: new THREE.MeshBasicMaterial({ color: PALETTE.factoryGlow }),
  table: std(PALETTE.table),
  tableLeg: std(PALETTE.tableLeg),
  armDark: std(PALETTE.armDark),
  armLight: std(PALETTE.armLight),
  joint: std(PALETTE.joint),
  claw: std(PALETTE.claw),
  clawDark: std(PALETTE.clawDark),
};

/** basisBox + basisPos: a box of (width, height, depth) at a demo point. */
function box(
  group: THREE.Group,
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  right: number,
  up: number,
  forward: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(right, up, -forward);
  mesh.rotation.set(rx, ry, rz);
  group.add(mesh);
  return mesh;
}

/** The factory hall: floor, walls with panels and light strips, the floor
 *  tray, the two tables with pads, instrument panels and legs, and the two
 *  control pedestals. One static model. */
export function factory(): THREE.Group {
  const g = new THREE.Group();
  box(g, 11, 0.08, 13, materials.floor, 0, -0.04, -0.45);

  const W = FACTORY_WALLS;
  const wallHalfForward = (W.backForward - W.frontForward) * 0.5;
  const wallCenterForward = (W.backForward + W.frontForward) * 0.5;
  const wallCenterY = W.height * 0.5;
  box(g, W.halfRight * 2 + W.thickness * 2, W.height, W.thickness, materials.factoryWall, 0, wallCenterY, W.backForward);
  box(g, W.halfRight * 2 + W.thickness * 2, W.height, W.thickness, materials.factoryWall, 0, wallCenterY, W.frontForward);
  box(g, W.thickness, W.height, wallHalfForward * 2, materials.factoryWall, -W.halfRight, wallCenterY, wallCenterForward);
  box(g, W.thickness, W.height, wallHalfForward * 2, materials.factoryWall, W.halfRight, wallCenterY, wallCenterForward);
  // back wall panels and ribs, three light bars
  for (const right of [-3.6, -2.4, -1.2, 0, 1.2, 2.4, 3.6]) {
    box(g, 0.82, 1.62, 0.035, materials.factoryWallPanel, right, 1.42, W.backForward - 0.106);
    box(g, 0.045, 2.2, 0.05, materials.factoryWallTrim, right + 0.48, 1.44, W.backForward - 0.125);
  }
  for (const right of [-2.95, 0, 2.95]) box(g, 0.72, 0.045, 0.055, materials.factoryGlow, right, 2.42, W.backForward - 0.13);
  // side wall panels, trims and a light bar along each side
  for (const right of [-W.halfRight + 0.012, W.halfRight - 0.012]) {
    for (const forward of [-2.18, -0.9, 0.38, 1.66, 2.94, 4.22]) {
      box(g, 0.035, 1.42, 0.82, materials.factoryWallPanel, right, 1.32, forward);
      box(g, 0.05, 2.08, 0.045, materials.factoryWallTrim, right, 1.38, forward + 0.48);
    }
    box(g, 0.055, 0.055, W.backForward - W.frontForward - 0.9, materials.factoryGlow, right, 2.46, wallCenterForward);
  }

  for (const t of [TABLES.serve, TABLES.receive]) {
    // floor pad, the table top, its instrument panel and four legs
    box(g, t.halfRight * 2 + 0.42, 0.028, t.halfForward * 2 + 0.46, materials.floorPad, t.centerRight, 0.01, t.centerForward);
    box(g, t.halfRight * 2, 0.22, t.halfForward * 2, materials.table, t.centerRight, TABLE_TOP - 0.11, t.centerForward);
    box(g, t.halfRight * 1.32, 0.018, t.halfForward * 1.42, materials.techPanel, t.centerRight, TABLE_TOP + 0.014, t.centerForward);
    const legHeight = TABLE_TOP - 0.24;
    for (const right of [t.centerRight - t.halfRight + 0.18, t.centerRight + t.halfRight - 0.18]) {
      for (const forward of [t.centerForward - t.halfForward + 0.22, t.centerForward + t.halfForward - 0.22]) {
        box(g, 0.1, legHeight, 0.1, materials.tableLeg, right, legHeight * 0.5, forward);
      }
    }
  }
  // the floor tray down the aisle and its hatches
  box(g, 0.58, 0.026, 5.65, materials.techPanel, 0, 0.038, 1.22);
  for (const forward of [-1.05, 0.15, 1.35, 2.55]) box(g, 0.44, 0.031, 0.52, materials.techPanelLight, 0, 0.064, forward);
  // control pedestals with their glowing screens
  for (const spec of [
    { right: -0.54, forward: -1.04, yaw: -0.32 },
    { right: 0.54, forward: -1.04, yaw: 0.32 },
  ]) {
    box(g, 0.34, 0.34, 0.24, materials.techPanel, spec.right, 0.17, spec.forward, 0, spec.yaw, 0);
    box(g, 0.28, 0.02, 0.18, materials.screenGlow, spec.right, 0.38, spec.forward + 0.015, -0.48, spec.yaw, 0);
  }
  return g;
}

/** The light strips' point lights as glow on the walls: four nested
 *  additive discs of one opacity per light, so the centre is brightest
 *  (the demo's PointLight(0x6ce5f0, 0.42, 3.6) falloff) in one pass. */
export function wallGlow(): THREE.Group {
  const g = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color: PALETTE.factoryGlow, transparent: true, opacity: 0.055, blending: THREE.AdditiveBlending });
  const W = FACTORY_WALLS;
  // right, forward, yaw (a disc faces +Z before it turns)
  const spots: [number, number, number][] = [
    [-3.1, W.backForward - 0.2, 0],
    [0, W.backForward - 0.2, 0],
    [3.1, W.backForward - 0.2, 0],
    [-W.halfRight + 0.1, 1.2, Math.PI / 2],
    [W.halfRight - 0.1, 1.2, -Math.PI / 2],
  ];
  for (const [right, forward, yaw] of spots) {
    for (const r of [0.16, 0.3, 0.46, 0.64]) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 16), glow);
      disc.position.set(right, 2.32, -forward);
      disc.rotation.y = yaw;
      g.add(disc);
    }
  }
  return g;
}

/** Upper arm along -Z from the shoulder (origin) to the elbow. */
export function upperArm(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.078, 24, 16), materials.joint);
  const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 16), materials.joint);
  elbow.position.z = -UPPER_LENGTH;
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, UPPER_LENGTH, 18), materials.armLight);
  // the cylinder's +Y onto -Z
  upper.rotation.x = -Math.PI / 2;
  upper.position.z = -UPPER_LENGTH / 2;
  g.add(base, elbow, upper);
  return g;
}

/** Forearm along -Z from the elbow (origin) to the wrist, and the claw on
 *  the wrist in the demo's claw frame (x right, y up, -z along the tool).
 *  Joints "left" and "right" hinge the fingers. */
export function forearmClaw(): THREE.Group {
  const g = new THREE.Group();
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.064, FOREARM_LENGTH, 18), materials.armDark);
  forearm.rotation.x = -Math.PI / 2;
  forearm.position.z = -FOREARM_LENGTH / 2;
  const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.062, 24, 16), materials.joint);
  wrist.position.z = -FOREARM_LENGTH;
  g.add(forearm, wrist);

  const claw = new THREE.Group();
  claw.position.z = -FOREARM_LENGTH;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.22), materials.claw);
  palm.position.set(0, CLAW_GRIP_LOCAL_Y * 0.45, 0.08);
  claw.add(palm);
  const bridgeWidth = CLAW_OPEN_GAP - 0.16 + CLAW_FINGER_WIDTH * 0.55;
  for (const side of [-1, 1]) {
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(bridgeWidth, 0.17, 0.25), materials.claw);
    bridge.position.set(side * (0.16 + bridgeWidth * 0.5), 0.18, -0.08);
    claw.add(bridge);
    const hinge = new THREE.Joint(side < 0 ? "left" : "right");
    hinge.position.set(side * CLAW_OPEN_GAP, CLAW_GRIP_LOCAL_Y, -0.08);
    const finger = new THREE.Mesh(new THREE.BoxGeometry(CLAW_FINGER_WIDTH, 0.12, 0.46), materials.claw);
    finger.position.z = -0.31 + 0.08;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(CLAW_FINGER_WIDTH + 0.014, 0.13, 0.11), materials.clawDark);
    pad.position.z = -0.52 + 0.08;
    hinge.add(finger, pad);
    claw.add(hinge);
  }
  g.add(claw);
  return g;
}

/** A cargo can, standing on its origin (the demo's group centre is CAN_LIFT up). */
export function can(color: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(CAN_RADIUS, CAN_RADIUS, CAN_HALF_HEIGHT * 2 - 0.08, 36),
    new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.08) }),
  );
  const metal = new THREE.MeshStandardMaterial({ color: 0xd3dcda });
  const ink = new THREE.MeshStandardMaterial({ color: 0xf4f7f6 });
  const topLid = new THREE.Mesh(new THREE.CylinderGeometry(CAN_RADIUS + 0.005, CAN_RADIUS + 0.005, 0.035, 36), metal);
  const bottomLid = topLid.clone();
  topLid.position.y = CAN_HALF_HEIGHT - 0.023;
  bottomLid.position.y = -CAN_HALF_HEIGHT + 0.023;
  const topRim = new THREE.Mesh(new THREE.TorusGeometry(CAN_RADIUS - 0.018, 0.018, 4, 14), metal);
  const bottomRim = topRim.clone();
  topRim.position.y = CAN_HALF_HEIGHT;
  bottomRim.position.y = -CAN_HALF_HEIGHT;
  topRim.rotation.x = Math.PI * 0.5;
  bottomRim.rotation.x = Math.PI * 0.5;
  const pullTab = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.055), metal);
  pullTab.position.set(0.06, CAN_HALF_HEIGHT, 0.02);
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.28, 0.18), ink);
  label.position.set(CAN_RADIUS - 0.002, 0, 0);
  const inner = new THREE.Group();
  inner.position.y = CAN_LIFT;
  inner.add(body, topLid, bottomLid, topRim, bottomRim, pullTab, label);
  g.add(inner);
  return g;
}

/** The target ghost shown when the claw goal is out of reach. */
export function ghost(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 12), new THREE.MeshBasicMaterial({ color: PALETTE.ghost, transparent: true, opacity: 0.2 })));
  return g;
}

/** The demo's CSS crosshair: two thin unlit bars one metre ahead of the eye. */
export function crosshair(): THREE.Group {
  const g = new THREE.Group();
  // 24 x 2 px of a ~900 px tall page is 6 x 1 px of the 240 px screen
  const mat = new THREE.MeshBasicMaterial({ color: 0xf4f7f6, transparent: true, opacity: 0.8 });
  const h = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.006, 0.001), mat);
  const v = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.036, 0.001), mat);
  h.position.z = -1;
  v.position.z = -1;
  g.add(h, v);
  return g;
}
