# Physics

`@pocketjs/framework/physics` models 2D scenes of bodies that fall, collide,
wobble and spring home: toys under gravity, letters resting in their layout
slots, a pocket with a zone that takes in the toys dropped into it. **The
simulation runs in the Rust core inside `Ui::tick`, and each tick ends by
writing every body's pose into the nodes bound to it as paint-only props.**
Painting, clipping and hit testing reuse the retained tree, and motion never
runs layout.

An app requires the capability `ui.physics`. The wasm core behind the web and
sim hosts, the Nintendo 3DS host and the iPod touch 4 host implement it; the contract is the five
optional ops 52–56 in [Native contract](/docs/native-contract/), with every key,
command, event, query and fixed constant pinned in `contracts/spec/physics.ts`.

```json
{ "engine": { "capabilities": { "requires": ["ui.physics"] } } }
```

## The frame contract

Application code creates objects and issues commands at interaction edges: a
launch, a hop, a stylus grab. Integration, collision, deformation, particles
and event detection run in the core every tick.

- **A world advances `substeps` semi-implicit Euler steps per core tick**
  (default 2), each `1 / (hz · substeps)` s long, so a 60 Hz realm integrates
  at 120 Hz. Contacts are resolved in three passes per step.
- **After the tick, every view carries `translateX`, `translateY`, `rotate`,
  `skewX`, `scaleX`, `scaleY` and `originY` values in its physics layer.** The
  physics layer resolves after styles, overrides and animation tracks, so the
  view's own `animate()` and `cancelAnim()` neither read nor freeze a pose.
  Those props are paint-only, so a moving body costs no relayout. Destroying
  the body clears the layer and the node shows its styled pose again.
- **Events produced by the ticks of frame N reach the app at the start of frame
  N+1**, through the service pump that runs before frame hooks. A world records
  events only while it has at least one handler (`onLand`, `onHit`, `onClear`,
  `onEnter`, `onLeave`, `onOverflow`), and the pump is registered only while
  some world has one: **a world with handlers costs one `physicsEvents`
  crossing per frame, a world without them costs none.** A world keeps at most
  128 records per tick and 8 ticks of records while nobody drains; the rest
  arrive as one `overflow` record with the dropped count, which
  `world.onOverflow` receives and `world.droppedEvents` accumulates.
- **A handler that throws does not cost the frame's other events.** The pump
  delivers every record, then rethrows the first error.
- **Randomness comes from seeded xorshift generators**: one per world, and one
  per emitter so particles do not shift the world's sequence. Trigonometry
  comes from the core's polynomial `sin`/`cos`/`tan`/`atan2`, and iteration
  follows slot order. The same parameters, commands and input tape produce the
  same bits on every host.

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
neither screen shows. A body bound to one node per surface is drawn by the
window it is inside, so a toy thrown off the top of the bottom screen
reappears at the bottom of the top screen. `world.toWorld(x, y, surface)`
converts a surface point, such as a stylus position, to world coordinates.

A view's position is the sum of its ancestors' layout offsets. **Ancestor
transforms are not part of it**, so bind bodies to nodes whose ancestors do not
move.

## Bodies

```ts
const toy = world.body({
  views: [bottomNode, topNode],     // at most 4
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

**A contact takes the smaller restitution and the mean friction of its two
sides.** Bodies default to restitution 0.3 and friction 0.4, colliders to
restitution 1 and friction 0.55, so against a collider the body's restitution
applies.

### Anchors

An anchor holds a body at rest with damped springs. **`to: "layout"` anchors it
to the layout centre of its first view**: flexbox places the rest position and
the springs set the motion toward it.

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

A body created with a layout anchor and no `position` starts at its rest
position once layout has placed the view; `body.home` returns that position,
or `undefined` before the first layout.

Anchored bodies still take contact impulses, so a toy dropped on a letter
pushes it down and the letter springs back when the toy rolls off. `axes`
limits the springs to some of `x`, `y` and `angle`; a body anchored only on
`angle` is a free body that turns back to its rest angle. **`free: true` gates
the springs on the body being free**: not grabbed, and 0.15 s without floor
contact. Such a body turns upright in the air and rests at whatever angle it
lands.

### Jelly

Jelly is secondary motion the core adds to the pose. Every channel is a damped
spring:

| Channel | Drives | Excited by |
|---|---|---|
| `squash` | scale across (`1 + q·across`) and along (`1 − q·along`) the squash axis | `impact` (per px/s of velocity change), `dent` (sets the squash per px/s of impact speed), `land`, `kick`, `press` |
| `lean` | `skewX`, toward `−vx · gain` degrees | horizontal speed, `lean.impact` |
| `pulse` | uniform scale, toward the `press` target | `kick`, `press` |
| `stretch` | negative squash while airborne or in flight | vertical speed |

`jelly.minSpeed` leaves the jelly unchanged for contacts slower than it (px/s):
`impact`, `lean.impact` and `dent` apply only above it. `squash.axis: "body"`
squashes the body's own vertical axis (a letter sitting on its foot);
`"impact"` squashes along the last contact normal in world space (a ball that
splats against a wall). `pivot` moves the point that rotation and squash turn
about to `pivot` px below the centre, so a letter squashes onto its baseline
instead of its middle.

**The pose written to the views is `rotate · skewX · scale`, composed about the
pivot.** An impact-axis squash is a world-space deformation composed with the
rotation; the core decomposes the product into the same three props, which
reach every 2D linear map with a positive determinant.

### Commands

| Method | Effect |
|---|---|
| `impulse(vx, vy, spin?)`, `setVelocity(…)` | change a body's velocity |
| `teleport(x, y, angle?)` | move a body without sweeping; the angle stays unless given |
| `launch({ from, to?, duration, turn?, endOffset?, arrive?, grow?, endScale?, solid? })` | a kinematic ballistic flight that arrives `duration` s later moving down at `arrive` px/s; `to` defaults to the anchor. The flight passes through free bodies unless `solid`. Arrival emits `land` and hands an anchored body back to its springs |
| `hop(up, stretch?, spin?)` | leave the anchor line under `airGravity` and land back on it |
| `kick({ squash, lean, spin, pulse })` | add to the jelly and spin velocities |
| `press(squash, pulse?)` | hold jelly targets while a finger is down; `press(0)` releases |
| `grab(x, y, { surface, mode })`, `drag(x, y, surface)`, `release()` | `"tether"` pulls the grabbed point with a force-limited soft joint; `"carry"` moves the body with the pointer and throws it with the pointer's smoothed velocity |
| `settle(vxScale, spinScale)` | damp the next floor contact once |
| `setAnchor(x, y, angle?)`, `wake()` | rest at a world point from now on; start a body created `asleep` |

**Getters (`x`, `y`, `angle`, `vx`, `vy`,
`spin`, `speed`, `grounded`, `airborne`, `mode`, `home`) are synchronous
queries, one host crossing each**; read them at interaction edges, not every
frame.

## Colliders, zones and emitters

```ts
const pocketWall = world.collider({
  shape: { chain: outline, radius: 6 },          // open polyline, at most 32 points
  owner: { body: pocket, squash: 0.002, spin: 0.04, minSpeed: 240 },
});
const inside = world.zone({ shape: { chain: outline, closed: true } });
inside.onEnter((body) => swallow(body));
```

- **Colliders** are static rounded boxes, circles, thick polylines, or
  `{ node }`: a node's layout box, re-read every tick. A collider with an
  `owner` passes each impact faster than `owner.minSpeed` to that body's jelly
  as squash and spin, so a shelf or a pocket squashes and rocks when hit
  without moving.
- **`ghost: collider`** on a body ignores one collider until the body's bounds
  have left it, then emits `clear`. A toy spawned inside the pocket passes
  through its walls on the way out.
- **Zones** report a body's centre entering and leaving; destroying a body
  inside a zone reports `leave`.
- **Emitters** drive a pool of up to 64 image nodes as particles: `burst(x, y,
  count, { angle, spread, speed })` and `stream(rate, x, y, w, h)`. Each
  particle takes a texture from `textures` (up to 16), and the core writes its
  translate, rotate, scale and opacity, hiding the node with opacity 0 when the
  particle ends. Destroying the emitter gives every pool node its own texture
  and styled pose back. Scale curves are `constant`, `pop` and `shrink`; alpha
  curves `constant`, `fade` and `twinkle`.

Handlers: `body.onLand`, `body.onHit` (contacts at or above `hitSpeed`, at most
one per 0.12 s), `body.onClear`, `zone.onEnter`, `zone.onLeave`, and the
world-wide `world.onHit`, `world.onLand` and `world.onOverflow`. Each returns
its unsubscribe function. `world.pick(x, y, surface, slop)` returns the topmost
pickable body under a surface point; bodies grabbed last are on top.

Options past a limit (views, pool, chain points, textures) throw when the
object is created.

## Fixed behaviour

These constants are part of the contract, not parameters:

| Behaviour | Value |
|---|---|
| Contact passes per substep | 3 |
| Penetration corrected per contact | 70% body–body, 100% body–collider |
| `hit` cooldown per body | 0.12 s |
| `launch` grow | over the first 0.2 s, overshoot 1.9; flight stretch at 40% of `stretch.gain` |
| `launch` arrival on an anchor | keeps 10% of the horizontal speed, 30% of `arrive` downward and 12% of the spin; jelly lands at 85% of `arrive`, the speed `land` reports |
| Hop landing rebound | 8% |
| Carried body released onto its anchor | lands within 5% of its size, faster than 60% of its size per second |
| `tether` | grab point at 75% of the offset from the centre, 28.8 /s error gain, limit 40000·strength px/s², spin damping 4.3 /s |
| `carry` pointer smoothing | 41.6 /s |
| Impact caps | squash kick 5.5 per contact, lean kick 172 °/s, dents below 0.035 ignored |
| `anchor.free` grace | 0.15 s without floor contact |

## The 3DS Pocket Nexus scene

`apps/nexus` is the pocket.nexus homepage on the 3DS, built from these
primitives. The letters are anchored jelly bodies whose homes are flexbox
slots on the top screen, with a second view on the bottom screen for the part
of their flight below the hinge. The pocket is an immovable jelly body
anchored to its layout box that owns its outline collider, and a zone inside
it swallows toys the stylus has touched. `apps/nexus/gen-art.ts` bakes the
homepage's canvas art into the sprites.

```sh
bun apps/nexus/gen-art.ts      # re-bake the sprites (headless Chrome)
bun tools/3ds.ts nexus         # dist/3ds/nexus-main.3dsx
```

## The touch Pocket Nexus scene

`apps/nexus-touch` is the same homepage on one 320×480 touch screen, built
for the iPod touch 4 as a standalone app. **`apps/nexus-touch/gen-art.ts`
opens the homepage document at 320×480 with its top bar and button hidden,
so the page's own `layout()` places the wordmark, the lede and the hint; the
bake measures that layout and captures the page's text and sky at device
scale 2.** Beyond the 3DS scene it carries the homepage's letter handling:

- **A tapped letter hops** (`hop`) and may answer in a speech bubble.
- **A dragged letter is carried** (`grab` with `mode: "carry"`) and springs
  home when released.
- **A letter dropped over the pocket's mouth is swallowed**: a `launch` into
  the mouth, a `setAnchor` below the screen while the pocket chews, and a
  `launch` from the mouth back to its slot. A second view of each letter,
  drawn behind the pocket's front, shows it inside the pocket.

Per-frame JS moves the O's eyes and the pocket's pupils toward what the
finger is doing, keeps the bubbles on the toys that carry them, and writes
the toys' floor shadows in one `setPropBatch` crossing.

```sh
bun apps/nexus-touch/gen-art.ts                            # re-bake the art from the homepage
POCKETJS_IPODTOUCH4_APP=nexus-touch bun ipodtouch4 build   # dist/ipodtouch4/PocketNexus.app
```
