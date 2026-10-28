---
name: playset-port
description: Port a GameBlocks browser game (three.js + plain ES modules, gb-<name>.vercel.app) to Playset so it runs at 60 fps on a Nintendo 3DS as a Pocket Shell app, with its visuals, gameplay, autopilot, interface and sound. Use when converting a three.js mini-game to the 3DS, adding a game under apps/playset/, or deciding what belongs in a native kernel and what stays TypeScript.
---

# Port a GameBlocks game to Playset

Read [`docs/PLAYSET.md`](../../docs/PLAYSET.md) first: it states the three
layers, the kernel table, sound, the shared interface and the measured costs
this procedure applies. [`apps/playset/space-shooter`](../../apps/playset/space-shooter)
is the reference port; copy its shape.

## 1. Get the source

```sh
bun tools/playset-mirror.ts <demo> .pocket-build/gameblocks
```

Every demo is `src/main.js` (input, loop, DOM HUD), `src/game.js` (state,
`step`), a `player-ai.js` autopilot and copies of GameBlocks modules under
`src/modules/`. Read `game.js` and the AI in full before writing anything;
list the game's entities, what moves them, what they collide with, what the
player sees and hears.

## 2. Files

```
apps/playset/<demo>/
  pocket.json   id dev.pocket-nexus.playset.<demo>, output playset-<demo>,
                requires game.playset + the touch-screen capabilities (copy
                space-shooter's)
  main.tsx      mount(() => <App />)
  app.tsx       <GameShell game={createGame()} /> and nothing else
  game.ts       createGame(): PlaysetGame; the gameplay class
  visuals.ts    the demo's visual factories on @pocketjs/framework/playset/three
  ai.ts         optional, the autopilot when it is long
```

Every file that keeps the demo's code starts with an attribution line:
`ported from GameBlocks' <demo> (https://gb-<demo>.vercel.app/, MIT, xt4d/GameBlocks)`,
plus the deviations from the original.

## 3. Map the demo

| In the demo | In the port |
| --- | --- |
| `THREE.Mesh/Group` factories | the same code with `import * as THREE from "@pocketjs/framework/playset/three"`, passed to `play.model()` once |
| a class with `update(dt)` that moves an object | an archetype with a kernel (`motion.*`) and maybe a brain (`brain.*` presets, or `brain.steer` states of `steer.*` terms and `when.*` transitions) |
| `MotionController` (vehicle, character, aircraft, car) | `motion.planar/character/plane/car/boat/hover`; copy the demo's tuning numbers |
| `ProjectileManager`, `ProjectileWeaponSystem` | a projectile archetype (`motion.linear` or `ballistic`, `projectile: true`) and a weapon on the shooter |
| hit tests in `resolve*` | layers (`layers(...)`), `hits:` masks and `play.rule(a, b, {...})` |
| `WaveSpawnDirector`, timers, scoring, power-ups | TypeScript in the gameplay class, run from `frame()` and event handlers |
| `Explosion` and other particle meshes | `play.emitter({...})` as an archetype's `death` or `trail`, or `play.burst()` |
| camera rigs | `play.followCamera/orbitCamera/firstPersonCamera/fixedCamera` |
| terrain, track, water, arena | `play.terrain/ground/water/bounds`, static `play.place()`, colliders |
| `Math.random()` | `mulberry(seed)` from `apps/playset/kit/random.ts` |
| DOM HUD | `readouts` and `topLine()` of the `PlaysetGame`; the shell draws them |
| `player-ai.js` | the demo mode autopilot (`start(true)`), required |
| no sound | sounds from `sfx` presets: every weapon, hit, death, pickup, the UI, an engine `hum` for a vehicle, and a wave/level/finish cue |

When a mechanic has no kernel, choose in this order: a kernel's tuning, a
brain, a rule, a `play.script(arch, fn, every)` over a few dozen slots, then
plain TypeScript at event rate. A new kernel or module (Rust) is last, and
only for work that touches many slots every frame; if you add one, it goes in
its own file under `engine/crates/pocket-playset/src/modules/` behind
`Playset.call`, with a unit test.

## 4. Budgets (Old 3DS)

- **Guest JavaScript at most 3 ms a frame**: a simple operation costs 0.5 µs,
  a typed-array update 3.7 µs, a native call 20–40 µs, an allocation 23 µs.
  No allocation in the frame path. Hoist views, ids and constants into locals
  in any loop; write autopilots as one pass into flat arrays, and run them
  every 3rd to 6th frame.
- **About 10,000 vertices a frame**: count three per flat-shaded triangle; use
  low segment counts (spheres 8x6, cylinders 6–8, capsules 1x4 for small
  things); scenery goes through `place(..., { static: true })`; many copies of
  one small model share draws (up to 20 per draw).
- `tools/playset-sim.ts` enforces 140 draws, 16,000 triangles and 1,200 bone
  matrices.
- The touch screen costs 3–4 ms of CPU: use the shell; keep readouts to six.

## 5. Verify

```sh
bun tools/playset-sim.ts playset/<demo> --frames 3600   # must pass; watch the status line advance
bun tools/playset-sim.ts playset/<demo> --play          # a real run with a neutral pad
bun tools/playset-azahar.ts playset/<demo> --frames 240,300   # look at the PNGs
bun node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

The Azahar tool builds a capture `.3dsx` with a baked button tape
(`--tape "0:0x0,120:0x2000"`, masks from `BTN` in contracts/spec/spec.ts; the
circle pad stays centred) and writes the top screen over the touch screen to
`.pocket-build/validation/playset/`. Look at every picture: the camera frames
the action, models face their direction of travel, nothing is black or
missing, the touch screen text fits.

Device measurement (`bun tools/3ds-dev.ts push --app playset/<demo>` and
`devStats`) belongs to whoever holds the console.

## 6. Hand back

A Conventional Commit on your branch (`feat(playset): <Demo> ...`), and a
report: what maps natively and what stays TypeScript, the deviations, the
sim's peak draws/triangles/sounds, and the pictures you looked at.
