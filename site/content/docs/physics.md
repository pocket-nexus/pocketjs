# Physics

`@pocketjs/framework/physics` models 2D scenes of bodies that fall, collide,
wobble and spring home: toys under gravity, letters resting in their layout
slots, a pocket that swallows what is dropped in it. **The simulation runs in
the Rust core inside `Ui::tick`, and each tick ends by writing every body's pose
into the nodes bound to it as paint-only props.** Painting, clipping and hit
testing reuse the retained tree, and motion never runs layout.

An app requires the capability `ui.physics`. The wasm core behind the web and
sim hosts and the Nintendo 3DS host implement it; the contract is the five
optional ops 52–56 in [Native contract](/docs/native-contract/), with every key,
command, event and query pinned in `contracts/spec/physics.ts`.

```json
{ "engine": { "capabilities": { "requires": ["ui.physics"] } } }
```

## The frame contract

Application code creates objects and issues commands at interaction edges: a
launch, a hop, a stylus grab. The core does the rest.

- **A world advances `substeps` semi-implicit Euler steps per core tick**
  (default 2), each `1 / (hz · substeps)` s long, so a 60 Hz realm integrates
  at 120 Hz. Contacts are resolved in three passes per step.
- **After the tick, every view carries `translateX`, `translateY`, `rotate`,
  `skewX`, `scaleX`, `scaleY` and `originY` values the body wrote into its
  animation layer.** Those props are paint-only, so a moving body costs no
  relayout. Destroying the body removes the values and the node shows its
  styled pose again.
- **Events produced by the ticks of frame N reach the app at the start of frame
  N+1**, through the service pump that runs before frame hooks. A live world
  costs one `physicsEvents` crossing per frame; no world costs nothing.
- **Randomness comes from the world's seeded xorshift generator**, trigonometry
  from the core's polynomial `sin`/`cos`/`atan2`, and iteration follows slot
  order. The same parameters, commands and input tape produce the same bits on
  every host.

## Worlds and surfaces

```ts
import { createWorld } from "@pocketjs/framework/physics";
import { onCleanup } from "solid-js";

const world = createWorld({
  gravity: [0, 1450],               // px/s², +y down
  substeps: 2,
  seed: 7,
  surfaces: { primary: [0, 0], auxiliary: [40, 296] },
});
onCleanup(() => world.destroy());
```

**One world spans every UI output.** Each surface is a window placed at an
origin in world space; a view is positioned relative to the surface its root
ancestor belongs to. On the 3DS the 400×240 top screen sits at `[0, 0]` and the
320×240 bottom screen at `[40, 296]`: centred under it, past a 56 px hinge that
neither screen shows. A body bound to one node per surface is drawn by
whichever window it is inside, so a toy thrown off the top of the bottom screen
reappears at the bottom of the top screen.

A view's position is the sum of its ancestors' layout offsets. **Ancestor
transforms are not part of it**, so bind bodies to nodes whose ancestors do not
move.

## Bodies

```ts
const toy = world.body({
  views: [bottomNode, topNode],
  shape: { circle: 20 },            // or { box: [hw, hh], corner }
  mass: 400,                        // 0 = immovable; omit for density × area
  restitution: 0.5,
  friction: 0.35,
  position: [200, 420],
  velocity: [180, -900],
  spin: 360,                        // degrees per second
  pickable: true,
});
```

A body collides as sample circles: one for a circle, eight for a rounded box
(its corners and edge midpoints, shrunk by the corner radius). Samples meet
static colliders and the exact shape of other bodies. Contacts slower than
`bounceSpeed` (110 px/s) do not bounce. `layer` and `mask` bits filter pairs:
two objects touch when each one's layer is in the other's mask.

### Anchors

An anchor holds a body at rest with damped springs. **`to: "layout"` anchors it
to the layout centre of its first view**, so flexbox decides where the body
rests and the springs decide how it gets there:

```ts
const letter = world.body({
  views: [slot],
  shape: { box: [26, 30], corner: 8 },
  anchor: {
    to: "layout",
    angle: -5,                                   // rest tilt, degrees
    spring: { stiffness: 190, damping: 13 },
    spin: { stiffness: 230, damping: 13 },
    airGravity: 790,                             // for hops
  },
});
```

Anchored bodies still take contact impulses, so a toy dropped on a letter
pushes it down and the letter springs back when the toy rolls off. `axes`
limits the springs to some of `x`, `y` and `angle`; a body anchored only on
`angle` is a free body that rights itself.

### Jelly

Jelly is secondary motion the core adds to the pose. Every channel is a damped
spring:

| Channel | Drives | Excited by |
|---|---|---|
| `squash` | scale across (`1 + q·across`) and along (`1 − q·along`) the squash axis | `impact` (per px/s of velocity change), `dent` (set directly per px/s of impact speed), `land`, `kick`, `press` |
| `lean` | `skewX`, toward `−vx · gain` degrees | horizontal speed, `lean.impact` |
| `pulse` | uniform scale, toward the `press` target | `kick`, `press` |
| `stretch` | negative squash while airborne or in flight | vertical speed |

`squash.axis: "body"` squashes the body's own vertical axis (a letter sitting on
its foot); `"impact"` squashes along the last contact normal in world space (a
ball that splats against a wall). `pivot` moves the point that rotation and
squash turn about to `pivot` px below the centre, so a letter squashes onto
its baseline instead of its middle.

**The pose written to the views is `rotate · skewX · scale`, composed about the
pivot.** An impact-axis squash is a world-space deformation composed with the
rotation; the core decomposes the product into the same three props, which
reach every 2D linear map with a positive determinant.

### Commands

| Method | Effect |
|---|---|
| `impulse(vx, vy, spin?)`, `setVelocity(…)`, `teleport(x, y, angle?)` | move a free body |
| `launch({ from, to?, duration, turn?, endOffset?, arrive?, grow?, endScale? })` | a kinematic ballistic flight that arrives `duration` s later moving down at `arrive` px/s; `to` defaults to the anchor. Arrival emits `land` and hands the body back to its springs |
| `hop(up, stretch?, spin?)` | leave the anchor line under `airGravity` and land back on it |
| `kick({ squash, lean, spin, pulse })` | add to the jelly velocities |
| `press(squash, pulse?)` | hold jelly targets while a finger is down; `press(0)` releases |
| `grab(x, y, { surface, mode })`, `drag(x, y, surface)`, `release()` | `"tether"` pulls the grabbed point with a force-limited soft joint; `"carry"` moves the body with the pointer and throws it with the pointer's smoothed velocity |
| `settle(vxScale, spinScale)` | damp the next floor contact once |
| `setAnchor(x, y, angle?)`, `wake()` | move a point anchor; start a body created `asleep` |

Getters (`x`, `y`, `angle`, `vx`, `vy`, `spin`, `speed`, `grounded`,
`airborne`, `mode`) are synchronous queries.

## Colliders, zones and emitters

```ts
const pocketWall = world.collider({
  shape: { chain: outline, radius: 6 },          // open polyline
  owner: { body: pocket, squash: 0.002, spin: 0.04 },
});
const inside = world.zone({ shape: { chain: outline, closed: true } });
inside.onEnter((body) => swallow(body));
```

- **Colliders** are static rounded boxes, circles, thick polylines, or
  `{ node }`: a node's layout box, re-read every tick. A collider with an
  `owner` passes each impact to that body's jelly as squash and spin, which is
  how a shelf or a pocket reacts to being hit without moving.
- **`ghost: collider`** on a body ignores one collider until the body's bounds
  have left it, then emits `clear`. A toy spawned inside the pocket passes
  through its walls on the way out.
- **Zones** report a body's centre entering and leaving.
- **Emitters** drive a pool of image nodes as particles: `burst(x, y, count,
  { angle, spread, speed })` and `stream(rate, x, y, w, h)`. Each particle takes
  a texture from `textures`, and the core writes its translate, rotate, scale
  and opacity, hiding the node with opacity 0 when the particle ends. Scale
  curves are `constant`, `pop` and `shrink`; alpha curves `constant`, `fade`
  and `twinkle`.

Handlers: `body.onLand`, `body.onHit` (contacts at or above `hitSpeed`),
`body.onClear`, `zone.onEnter`, `zone.onLeave`, and the world-wide
`world.onHit` / `world.onLand`. `world.pick(x, y, surface, slop)` returns the
topmost pickable body under a surface point; bodies grabbed last are on top.

## The 3DS Pocket Nexus scene

`apps/nexus` is the pocket.nexus homepage on the 3DS, built from these
primitives. The letters are anchored jelly bodies whose homes are flexbox
slots on the top screen, with a second view on the bottom screen for the part
of their flight below the hinge. The pocket is an immovable jelly body that
owns its outline collider, and a zone inside it swallows toys the stylus has
touched. `apps/nexus/gen-art.ts` bakes the homepage's canvas art into the
sprites.

```sh
bun apps/nexus/gen-art.ts      # re-bake the sprites (headless Chrome)
bun tools/3ds.ts nexus         # dist/3ds/pocket-nexus.3dsx
```
