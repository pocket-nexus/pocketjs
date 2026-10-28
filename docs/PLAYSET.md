# Playset

Playset is the PocketJS SDK for small 3D games that hold 60 frames per second
on a Nintendo 3DS, the Old model included. A game is a PocketJS app: its
content and gameplay are TypeScript in a `.pocket` package, and the work that
runs every frame belongs to native kernels in the runtime. Pocket Shell
installs and starts a playset game like any other app.

| Part | Path |
| --- | --- |
| Contract (views, descriptor layouts, ids) | [`contracts/spec/playset.ts`](../contracts/spec/playset.ts) |
| Kernels (Rust, `no_std`) | [`engine/crates/pocket-playset`](../engine/crates/pocket-playset) |
| PICA200 scene renderer | [`devices/3ds/pocket-3ds-playset`](../devices/3ds/pocket-3ds-playset) |
| QuickJS binding and DSP mixer | [`products/3ds/src/playset.c`](../products/3ds/src/playset.c), [`playset_audio.c`](../products/3ds/src/playset_audio.c) |
| Desktop binding (headless) | [`platforms/sim/playset.ts`](../platforms/sim/playset.ts) |
| TypeScript SDK | `@pocketjs/framework/playset`, `@pocketjs/framework/playset/three` |
| Games | [`apps/playset/`](../apps/playset) |
| Porting procedure | [`skills/playset-port`](../skills/playset-port/SKILL.md) |

A guest gets `globalThis.playset` when its plan declares the **`game.playset`**
capability. The 3DS product links the kernels into its runtime archive, so a
game package carries no native code.

## Three layers

| Layer | Runs | What it holds |
| --- | --- | --- |
| Content | once, at load | three.js-shaped `Object3D` trees turned into native models; scenery, ground, terrain, water, sky, fog, light; sound descriptions |
| Behaviour as data | natively, every step | archetypes: a motion kernel, a brain, weapons, joint drivers, collision layers, sounds; rules for what a contact between two layers does; particle emitters; the camera rig |
| Gameplay | TypeScript, at event rate or on a budget | event handlers (hits, deaths, pickups, gates), timers, waves, scoring, power-ups, retuning archetypes, per-slot scripts, autopilots, the interface |

**Per frame the guest calls into native code once** (`Playset.frame()` runs one
step), then reads event records and slot state from Float32Array views over
native memory. Reading `ent[s * 16]` is an array load, not a call.

## Content

`@pocketjs/framework/playset/three` keeps three.js r161 names, parameter order
and defaults for `Group`, `Mesh`, the primitive geometries, the `Mesh*Material`
classes, `Vector3`, `Euler` and `Color`. `Playset.model(root)` flattens a tree
into one description and returns a native model id; the tree is garbage
afterwards. A GameBlocks visual factory ports by changing its import.

| three.js | Playset |
| --- | --- |
| Box, Sphere, Cylinder, Cone, Capsule, Torus, Plane, Circle, Ring, Icosahedron, Octahedron, Dodecahedron, Tetrahedron | the same primitives, generated natively; segment counts above the device caps (12 radial, 8 rings, 16 tubular) are reduced |
| `BufferGeometry` with a position attribute | raw triangles |
| materials | a colour, an emissive amount, an opacity and a blend mode; maps, metalness and roughness are dropped |
| `geometry.rotateX/translate/scale` | applied before the mesh transform |
| `flatShading`, `userData.jitter` | faceted normals; seeded vertex displacement (rocks) |
| `Joint` or `object.joint = true` | a joint: its subtree moves with archetype joint drivers |
| Points, Lines, shadow maps, textures | not drawn; stars become triangles, shadows become blob shadows |

`Playset.place(model, at, { static: true })` bakes scenery into world-space
batches per 32 m cell: **any number of static nodes costs one draw per visible
cell**. A node placed with `static: false` keeps its own matrix and moves with
`Playset.move`.

Models drawn by slots share draws: a model with one joint and under 300
vertices is replicated in its vertex buffer, and **one draw carries up to 20
instances** through the shader's bone palette.

## Behaviour as data

An archetype is one descriptor of 128 floats. `Playset.archetype(spec)`
encodes it; `Playset.retune(arch, changes)` re-encodes it and live slots use
the new values on the next step.

| Kernel (`motion.*`) | Moves | Intents it reads |
| --- | --- | --- |
| `ballistic` | under gravity with drag, bounce or stick | none |
| `linear` | straight, or homing on its target | none |
| `planar` | on the ground plane, world, heading or tank frame | X, FWD, TURN, RISE |
| `character` | walks, runs, jumps under gravity; world, heading, camera, tank or first-person frame | X, FWD, TURN, RISE, JUMP, AUX |
| `car` | arcade car with grip, drift and slopes | FWD, TURN, JUMP (handbrake), AUX (boost) |
| `boat` | hull on the water surface with roll and pitch | FWD, TURN |
| `plane` | aircraft attitude with banked turns; with `banked`, GameBlocks' AirplaneMotionController: TURN holds a bank angle that turns the heading, FWD moves a throttle, a floor over the terrain | RISE (pitch), TURN (roll, or bank), X (rudder), FWD, AUX (boost when banked) |
| `hover` | drone or submarine | X, FWD, TURN, RISE |
| `path` | along a path at its slot's SPEED | none |
| `turret` | yaw and pitch toward its target | TURN, RISE without a target |
| `runner` | lanes toward -Z with jumps and slides | X, JUMP, RISE |
| `attached` | rides another slot at an offset | none |

A brain picks a target and writes the same intents a player's stick writes.
The target is the nearest slot on some layers (`{ nearest }`), the slot on
some layers furthest along its `motion.path` path (`{ leading }`, a tower's
creep), the slot's own TARGET, or a point. A slot without a brain takes its
intents from the guest (`Playset.steer`, `Playset.buttons`).

**The native brain holds no behaviour of its own.** It evaluates the
archetype's behaviour: up to four states, each a weighted sum of up to four
steering terms (`steer.seek`, `flee`, `orbit`, `wander`, `home`, `lead`,
`altitude`, `forward`, `weave`) with a speed, a boost, a fire range and cone
and an optional FWD intent, and up to three transitions (`when.near`, `far`,
`after`, `hurt`, `target`, `noTarget`, `chance`). The kernel's `drive` turns
the summed direction into that kernel's intents. The behaviour is 160 floats
sent after the archetype's 128, so `retune` changes it like any other field.
`brain.seek`, `flee`, `orbit`, `wander`, `herd`, `pursue`, `turret` and
`strafe` are TypeScript presets written with `brain.steer({ target, states })`:

```ts
// brain.herd: graze at half speed; bolt with AUX held while a hunter is in sight
brain.steer({
  target: { nearest: L.player, sight: 18 },
  states: [
    { speed: 0.5, terms: [steer.wander({ turn: 1.2, every: 2.5, idle: 0.3 }), steer.home(9, 2)], next: [when.target(1)] },
    { speed: 1, boost: true, terms: [steer.flee()], next: [when.after(2.6, 0)] },
  ],
});
```

A rule (`Playset.rule(layersA, layersB, spec)`) says what a contact does:
damage either side, kill either side, push apart, bounce, collect (PICKUP),
and report (HIT). Contacts are found on a uniform grid; projectiles skip
their shooter and its team.

Genre engines beyond the kernels are modules reached through
`Playset.call(module, op, args, out)`: the snake board, the marble plate and
the voxel world (`PLAYSET_MODULE`). Each drives its own slots after the
world's step and reports its own events, numbered from `PLAYSET_MODULE_EVENT`
(`SNAKE_EVENT.EAT`, `SNAKE_EVENT.CRASH`, `MARBLE_EVENT.END`); the global
`EVENT` table holds HIT, DEATH, EXPIRE, FIRE, GROUND, BOUNDS, PICKUP and
ARRIVE. `@pocketjs/framework/playset/snake` (`SnakeBoard`: grid snakes
with a slot per segment, food, collisions and a flood-fill + BFS planner) and
`@pocketjs/framework/playset/marble` (`MarbleBoard`: a tilting plate with
walls, moving blocks, holes, stars and a goal, the ball's physics, and a
route planner) name their ops; **the calls a game makes while it plays
(`turn`, `state`, `route`) write a preallocated argument array and allocate
nothing**.

## Sound

`Playset.sound(spec)` renders a description (wave, pitch sweep, envelope,
duty, vibrato, noise, low-pass, arpeggio, echo, loop) into mono PCM once.
`sfx` holds presets. Weapons, hits, deaths, spawns and pickups play an
archetype's sounds natively at their position, attenuated by distance from
the camera and panned across its right axis; **at most two copies of one
sound start in one frame and ten sounds in all**. An archetype's `hum` loops
while it is the camera target, its pitch following its speed. The 3DS mixes
on NDSP channels 2..23; it needs the DSP firmware dump at
`sdmc:/3ds/dspfirm.cdc` and is silent without it.

## The interface

[`apps/playset/kit/shell.tsx`](../apps/playset/kit/shell.tsx) is the interface
every game shares: the scene on the top screen with one corner line, and on
the touch screen the title card (Play, Demo, the controls), the readouts with
bars, the game-over card and a developer panel. A game implements
`PlaysetGame` ([`kit/game.ts`](../apps/playset/kit/game.ts)), which has no UI
code. Readouts are sampled six times a second and written through
`@pocketjs/framework/hot`. Every game has a demo autopilot, which is also the
title screen's backdrop and what the headless runner plays.

## Measured boundaries (Old 3DS, 268 MHz)

| Cost | Measured |
| --- | --- |
| One simple QuickJS operation (local float arithmetic, a loop step) | **0.5 µs** |
| A Float32Array element read-modify-write | **3.7 µs** |
| A small object allocation | **23 µs** |
| A call from JS into the playset binding | **20–40 µs** |
| PICA vertex work with the playset shader | **≈0.3 µs per vertex** |
| A float comparison in native code (VFP flags moved to the integer core) | **a pipeline stall per comparison** |

### One frame

devStats reports the canonical tick as two phases: `tick` is the runtime's
advance (input, the guest's frame, the core step) and `draw` is its present
(both screens' draw lists and their submission, the playset scene included).
Snake Clash, launched from Pocket Shell's Home:

| Part | ms |
| --- | --- |
| Guest JavaScript and the native step (`game.frame`) | 1.2 |
| The rest of advance (the frame pump, the core step) | 1.4 |
| The playset scene: `pps_prepare` and the PICA submission | 1.7 |
| The touch screen: its draw list, and a reused or skipped submission | 0.1–0.4 |
| Both screens' draw lists in the core, and the coordinator | ≈1.1 |
| Display transfers | 0.45 per screen |
| Waiting for the GPU | 0.15 |
| **Canonical tick** | **6.8–7.4** |

**The PICA driver presents deferred**: a frame's flush ends its citro3d
frame, the GPU draws it while the guest's next turn runs, and the next
present's completion transfers and swaps each screen after the vblank
between the turns. Before, the CPU waited 2.5–3.6 ms a frame for the GPU.
**A screen whose two buffers already show its unchanged build is not
submitted again**, so a touch screen whose readouts did not change costs
0.1 ms.

What follows from them for a game's per-frame JavaScript:

- **A frame affords about 3 ms of guest JavaScript**, which is a few thousand
  simple operations. The demo autopilot of Space Shooter cost 14.7 ms per call
  as ported; one pass into flat arrays, locals for every constant and view,
  and lanes evaluated against the threats alone brought it to 1.75 ms. It
  runs every sixth frame.
- **Nothing allocates per frame**: no closures, arrays, objects or string
  building in the frame path. Event handlers receive numbers.
- **About twenty native calls per frame** at most; slot state is read and
  written through the views.
- **A readout is written when its text changes**: each write rebuilds the
  touch screen's submission.
- Logic that touches every slot every frame belongs to a kernel, a
  behaviour or a rule. `Playset.script(arch, fn, every)` runs a guest function over the slots
  of one archetype every `every` steps, for logic that a few dozen slots can
  afford.

For native code that runs per element every frame:

- **No float comparison in the loop body**: clamps, `min`/`max` and range
  folds each stall the ARM11. `sinf` rounds with the 1.5 × 2²³ constant and
  folds with bit masks; the water grid writes values that are in range by
  construction. Pirate Seas' `pps_prepare` went from 4.7 to 1.7 ms this way.
- **Tables for what repeats**: the water's sines per column and per row
  (about 130 a frame instead of ten per vertex), a blob shadow's rim, the
  water's index buffer.

For content, the GPU is the limit: **about 10,000 vertices a frame** leaves
time for the interface. Flat shading and jitter unshare vertices (three per
triangle), and three.js default segment counts are reduced natively.

## Validation

```sh
cargo test -p pocket-playset
bun tools/playset-schema.ts --check
bun tools/playset-sim.ts playset/space-shooter       # headless, the demo autopilot plays
bun tools/playset-azahar.ts playset/space-shooter --frames 300,360
bun tools/3ds.ts playset/space-shooter               # dist/3ds/playset-space-shooter.3dsx
bun tools/3ds-dev.ts push --app playset/space-shooter
```

`tools/playset-sim.ts` fails on an exception, on a run that ends within ten
seconds, and on a frame record over 140 draws, 16,000 triangles or 1,200 bone
matrices. A sim pass is not a frame-rate measurement; frame rates come from
`devStats` on the console.
