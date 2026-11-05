<img class="w-full rounded-xl border border-line" src="/assets/blog/voxel-psp-pallet-town.png" alt="Pallet Town as a voxel diorama on a real PSP: two gabled houses with tiled roofs, a large lab building, carved bushes, flowers, an NPC in blue and the player standing on the path between them, in warm per-tile color." />

<p class="text-sm text-slate-500 -mt-4">Pallet Town on a PSP-2000, photographed by the machine itself over PSPLINK. Every screenshot in this post is a hardware capture; none of these pixels live in any repo, for reasons the post gets to.</p>

There is a Lua project called [gen1recomp](https://github.com/bryanthaboi/gen1recomp) that re-implements the first-generation Game Boy creature-RPG (the one with the red cartridge) as a clean modern engine that reads your own ROM for its content. And there is a mod for it, [DramaticShape's Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod), that does something quietly spectacular: it re-reads the flat GB tile maps as *architecture*, so walls get height, roofs get gables, trees get carved into little round hulls, and the whole game becomes a walking 3D diorama. Both run on [LÖVE](https://love2d.org/), the C++ game framework you script in Lua. Both are desktop programs.

We rewrote the pair, gameplay into TypeScript and renderer into Rust, and now the diorama runs on a **2004 Sony PSP**: 333 MHz, no shaders, no JIT. The result is [Pocket Voxel](https://github.com/pocket-nexus/pocket-voxel), a specialized runtime of [PocketJS](/blog/introducing-pocketjs/), and this post is the story of the port: why a rewrite rather than a port of the engine, what a creature-RPG looks like rebuilt from first principles in TypeScript, and how two Lua codebases we never vendored kept every formula honest anyway.

## Why rewrite, and why these languages

The lazy framing is "LÖVE doesn't run on a PSP," which is true but not the reason. Someone determined enough could port a Lua interpreter and enough of LÖVE's surface to a handheld. The reason is that the *shape* of a desktop engine is wrong for this machine, in ways no porting effort fixes:

- **LÖVE is a runtime-everything engine.** The Voxel Mod classifies tiles, measures building volumes, carves tree hulls, and meshes chunks *while the game runs*, on a machine with cycles to spare. The PSP has no cycles to spare; it wants the console discipline PocketJS inherited from [Pocket3D](/blog/shipping-openstrike/): move every cost you can to build time, and ship bytes the GPU reads in place.
- **Lua's performance story on this hardware is our JavaScript story, without our escape hatch.** Any dynamic language on a 333 MHz in-order MIPS core runs interpreted and is allergic to per-frame work. PocketJS spent its first month building exactly this answer: a measured budget for guest work (QuickJS: **~1.7 µs per host call, ~8k calls per frame**), a native core that owns everything per-pixel and per-vertex, and a deterministic test culture that makes the split safe to live with. Rewriting *into* that runtime is cheaper than rebuilding that runtime around Lua.
- **A product should outlive its first machine.** The gameplay compiled as a QuickJS guest bundle is the same artifact on a PSP, a Vita, or a desktop, which is the claim OpenStrike proved for an FPS. A LÖVE program is welded to LÖVE.

So: TypeScript for the game, because the game is *product logic* (rules, menus, text, saves), and product logic is what the PocketJS guest tier is for. Rust for the renderer, because voxel chunks, culling, and a fixed-function GPU are what the core tier is for. Which leaves the real question of the project: if you're rewriting everything, what stops the rewrite from quietly becoming a *different game*?

The answer is the method the whole port ran on: **the Lua is the spec, and the spec is executable.** Both upstreams are MIT-licensed, and neither ships a line of code into our tree. Instead, `luajit` plus a small LÖVE stub runs the original engine headless on the build machine, as an *oracle*. Port a formula, then make the oracle print its answers, and diff bit-for-bit. Every ported function carries a provenance comment like `// gen1recomp BattleState.lua:3397`, naming the exact Lua it must agree with, and a later line-by-line audit of the shipped port found the rules layer verbatim-correct, with every real gap in the glue around it. You can't get that guarantee porting from a design document, because a design document doesn't run.

<svg viewBox="0 0 760 296" width="100%" role="img" aria-label="Diagram of the porting method. Left: the upstream desktop stack, LÖVE with C plus plus, hosting gen1recomp Lua gameplay and the Voxel Mod Lua renderer. Right: the Pocket Voxel stack, a TypeScript gameplay guest on QuickJS and a Rust scene core on the PSP. Between them, arrows labeled executable spec. At the bottom, the parity oracle: luajit plus a LÖVE stub runs the original headless and answers are diffed bit-for-bit; every formula cites its Lua file and line." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="296" rx="12" fill="#0b0f1a"/>
  <rect x="24" y="24" width="300" height="176" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="174" y="50" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">upstream · desktop only</text>
  <rect x="44" y="66" width="260" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="174" y="85" fill="#e2e8f0" font-size="12" text-anchor="middle">gen1recomp · gameplay, Lua</text>
  <text x="174" y="103" fill="#64748b" font-size="11" text-anchor="middle">ROM-fed engine, ~60k lines</text>
  <rect x="44" y="120" width="260" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="174" y="139" fill="#e2e8f0" font-size="12" text-anchor="middle">Voxel Mod · diorama renderer, Lua</text>
  <text x="174" y="157" fill="#64748b" font-size="11" text-anchor="middle">voxelizes at runtime, in-process</text>
  <text x="174" y="188" fill="#64748b" font-size="11" text-anchor="middle">LÖVE, the C++ engine underneath</text>
  <rect x="436" y="24" width="300" height="176" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="586" y="50" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pocket Voxel · PSP and up</text>
  <rect x="456" y="66" width="260" height="46" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="586" y="85" fill="#e2e8f0" font-size="12" text-anchor="middle">voxelmon/game · TypeScript guest</text>
  <text x="586" y="103" fill="#64748b" font-size="11" text-anchor="middle">the whole game state, on QuickJS</text>
  <rect x="456" y="120" width="260" height="46" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="586" y="139" fill="#e2e8f0" font-size="12" text-anchor="middle">pocketvoxel-core · Rust scene core</text>
  <text x="586" y="157" fill="#64748b" font-size="11" text-anchor="middle">a cook-time voxelizer feeds it a pak</text>
  <text x="586" y="188" fill="#64748b" font-size="11" text-anchor="middle">sceGu on PSP · soft rasterizer in CI</text>
  <path d="M324 89 L436 89" stroke="#475569" stroke-width="1.5"/>
  <path d="M436 89 l-9 -5 M436 89 l-9 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="380" y="80" fill="#94a3b8" font-size="11" text-anchor="middle">executable spec</text>
  <path d="M324 143 L436 143" stroke="#475569" stroke-width="1.5"/>
  <path d="M436 143 l-9 -5 M436 143 l-9 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="380" y="134" fill="#94a3b8" font-size="11" text-anchor="middle">re-derived</text>
  <rect x="24" y="216" width="712" height="62" rx="10" fill="#0e1626" stroke="#e6a94b" stroke-width="1.5"/>
  <text x="380" y="236" fill="#e6a94b" font-size="12" font-weight="700" text-anchor="middle">the parity oracle</text>
  <text x="380" y="254" fill="#94a3b8" font-size="11" text-anchor="middle">luajit + a LÖVE stub runs the original engine headless</text>
  <text x="380" y="270" fill="#94a3b8" font-size="11" text-anchor="middle">answers diffed bit-for-bit · every formula cites its Lua file:line</text>
</svg>

One more inheritance, this time of a legal stance rather than code: like upstream, Pocket Voxel is **ROM-fed**. The only content input is a canonical Gen-1 ROM you already own; the importer checks its SHA-1 before decoding a byte, everything derived from it lives in git-ignored `dist/`, and **no ROM-derived byte is ever committed**: no cooked pak, no extracted art, no golden PNGs. The rendering goldens in CI are frame *hashes*. The screenshots here exist because a real PSP drew them.

## The inversion

Every previous runtime in this family put the simulation in Rust and gave JavaScript the layer on top: OpenStrike's core owns movement, bots, and bullets while `rules.ts` owns round flow. Pocket Voxel flips it completely: **the game state lives in the guest.** Movement, collision, NPCs, warps, the script VM, text pagination, menus, the entire battle engine, the party, the bag, the save file, the RNG: all of it TypeScript, all of it inside QuickJS. The Rust core owns *presentation only*: cooked voxel chunks, up to 16 entity billboards, the camera, a battle stage, a retained 20×18 GB UI tile grid, and a chip synth that renders the ROM's own sound programs to PCM.

What makes the inversion viable is arithmetic, not ideology. The QuickJS budget on this CPU is ~8k host calls per frame, and a Gen-1 RPG is, architecturally, a *low-frequency state machine*. The player crosses a tile in 16 ticks. A textbox reveals one glyph per beat. So the guest describes its world to the core through a retained-scene protocol of tiny ops (`cam`, `ent`, `uiText`, `mapShow`, `arena`…), and steady-state boundary traffic measures **a couple of ops per tick, 10–40 in a busy frame**, three orders of magnitude under the wall. Opening a menu bursts a few hundred `ui*` ops, once. The trick that keeps text cheap is telling: the guest sends a message *once*, and the typewriter effect is a single retained reveal counter the core compares against. That is the same relational, retained-scene idea PocketJS's UI surface runs on, applied to a diorama.

<svg viewBox="0 0 760 360" width="100%" role="img" aria-label="Architecture diagram of the ownership inversion. Top box: the TypeScript guest on QuickJS owns world, battle, script VM, textbox, menus, party, bag, save, and seeded RNG, and calls frame once per host tick. An arrow labeled with the voxel surface ops (cam, ent, uiText, mapShow) leads down to the Rust core box, which owns the VXPK pak zero-copy, frustum-culled chunks, camera rungs, sixteen billboards, the battle stage, the retained GB UI grid with its reveal counter, and the chip synth, and builds one ordered draw list per frame. The draw list fans out to two backends: pocketvoxel-gu driving the PSP's GE, and pocketvoxel-sim, the software rasterizer CI uses. A footer notes both backends resolve every palette through one function so the pipelines cannot bind different colors." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="360" rx="12" fill="#0b0f1a"/>
  <rect x="60" y="20" width="640" height="80" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="380" y="44" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">the guest · TypeScript on QuickJS · the game state lives here</text>
  <text x="380" y="64" fill="#94a3b8" font-size="11.5" text-anchor="middle">world · battle · script VM · textbox · menus · party · bag · save · seeded RNG</text>
  <text x="380" y="82" fill="#64748b" font-size="11" text-anchor="middle">one frame(buttons) per host tick, exactly once</text>
  <path d="M380 100 L380 140" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 140 l-6 -9 M380 140 l6 -9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="396" y="118" fill="#38bdf8" font-size="11.5">the voxel surface: cam · ent · uiText · mapShow …</text>
  <text x="396" y="134" fill="#64748b" font-size="11">~1.6 ops/tick steady · 10–40 busy · budget ~8k</text>
  <rect x="60" y="140" width="640" height="86" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="164" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">pocketvoxel-core · Rust no_std · presentation only</text>
  <text x="380" y="184" fill="#94a3b8" font-size="11.5" text-anchor="middle">VXPK pak zero-copy · frustum-culled chunks · camera rungs · 16 billboards · battle stage</text>
  <text x="380" y="202" fill="#94a3b8" font-size="11.5" text-anchor="middle">retained 20×18 GB UI grid + reveal counter · chip synth → PCM</text>
  <text x="380" y="219" fill="#64748b" font-size="11" text-anchor="middle">one ordered draw list per frame</text>
  <path d="M280 226 L200 266" stroke="#475569" stroke-width="1.5"/>
  <path d="M200 266 l10 -8 M200 266 l12 0" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M480 226 L560 266" stroke="#475569" stroke-width="1.5"/>
  <path d="M560 266 l-10 -8 M560 266 l-12 0" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="60" y="266" width="300" height="62" rx="10" fill="#0e1626" stroke="#e6a94b" stroke-width="1.5"/>
  <text x="210" y="290" fill="#f1f5f9" font-size="12.5" text-anchor="middle">pocketvoxel-gu → the GE</text>
  <text x="210" y="310" fill="#94a3b8" font-size="11" text-anchor="middle">sceGu, 480×272, the real PSP</text>
  <rect x="400" y="266" width="300" height="62" rx="10" fill="#0e1626" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="550" y="290" fill="#f1f5f9" font-size="12.5" text-anchor="middle">pocketvoxel-sim → CI</text>
  <text x="550" y="310" fill="#94a3b8" font-size="11" text-anchor="middle">software rasterizer · PNGs + frame hashes</text>
  <text x="380" y="350" fill="#475569" font-size="11" text-anchor="middle">palettes resolve through one shared function, so GE and rasterizer cannot bind different colors</text>
</svg>

## A creature-RPG from first principles, in TypeScript

"Port the gameplay" flattens what was actually a re-architecture. The Lua engine is a fine desktop codebase of its era: 1-based indices, module-level state, LÖVE callbacks woven through the logic. The TypeScript is organized around a different center of gravity, **purity at the leaves and one writer at the boundary**, because that's what makes the oracle usable and the whole thing testable in milliseconds:

```text
apps/voxelmon/game/          (~11k lines of TypeScript)
├─ rules/        eleven pure formula modules: damage, stats, growth,
│                typechart, turnorder, catching, experience, status,
│                encounter, timing, bag. No I/O, no globals; every
│                function takes the RNG as a parameter. Each formula
│                cites the Lua it ports, and luajit re-runs that Lua
│                to check the answers bit-for-bit.
├─ world/        map (the bottom-left-tile collision rule), player
│                (16-tick steps, the 4-tick armed-turn window, the
│                wall-bonk), npc wander, warps and doors, the textbox
│                paginator, a generator-based script VM (its verbs
│                are the reference's verbs), and the overworld
│                controller, which preserves the reference engine's
│                update order line by line.
├─ battle/       the message/action queue IS the engine (say, act,
│                drain, wait, statBox), exactly as upstream; an effect
│                registry covering every move reachable on the cooked
│                maps, with the reference's own fallbacks for the rest.
├─ scene.ts      the one delta-emitting frontend: diffs game state
│                into surface ops. Nothing else touches the boundary.
├─ game.ts       the state stack: overworld / textbox / menu / battle.
└─ data.ts       typed loader for the imported datasets. Bun reads
                 JSON on the desk; QuickJS gets one cold parse at boot.
```

The discipline that pays off most is the smallest-sounding one: **rules take their randomness as an argument.** The Lua test harness injects fixed and sequenced RNGs to pin behavior; because the TS mirrors that shape, the same injectors drive both sides of the parity suite, and a damage-roll disagreement is a diff, not a debugging session. The suite currently stands at **226 tests and 47,715 assertions**, and the heaviest of them are exactly these cross-language matrices.

What does a frame actually look like? Here is the whole per-tick shape, trimmed of its profiler hooks. Sixty times a second the host calls the guest exactly once; the guest updates only the *top* of its state stack (a textbox freezes the world beneath it, exactly as upstream's stack works), then lets `scene.ts` diff what changed into surface ops:

```ts
// game.ts: one guest turn per host tick, exactly once
tick(buttons: number): void {
  this.input.setButtons(buttons);
  this.input.step();                  // edge-per-step input, Input.lua:109
  const top = this.stack[this.stack.length - 1];
  top?.update();                      // ONLY the top state runs this tick
  this.scene.emit(this);              // diff game state into surface ops
  this.driveAudio();                  // hand the core its music/sfx cues
  this.host.frameDone(this.tickIndex, buttons);
  this.tickIndex += 1;
}
```

While you walk, the top state is the overworld controller, and its update is a preserved copy of the reference's order, because that order is load-bearing: the script VM must win over the d-pad, and an emotion bubble freezes NPCs but not the player's step animation. Trimmed:

```ts
// world/overworld.ts: OverworldController.lua:883 update, same order
update(): void {
  this.runner.update();               // the script VM gets the frame first
  if (this.emote) {                   // an emote bubble holds the world for
    this.player.update();             // a beat; only the player animates
    return;
  }
  for (const npc of this.npcs) {
    npc.update(this.map, this.entities, this.shell.npcRng, this.tilePairs);
  }
  this.updateScriptMoves();
  const scripted = this.runner.isRunning() || this.scriptMoves.length > 0;
  if (!scripted && !this.transitioning) this.handleInput();
  const stepped = this.player.update();       // 16-tick grid steps
  if (stepped && !scripted) this.onStepComplete();
}
```

That last call, `onStepComplete()`, is the landed-step gauntlet, again in the original's order: warp-entry staleness, the standing-on-warp flag, arrival warps, held-direction collision warps, and only then the wild-encounter roll for the cell you landed on (grass, surfed water, or, on indoor maps outside the forest tileset, every tile, exactly as `wild_encounters.asm` has it). Walking into Route 1's tall grass and meeting a wild bird is that final line rolling against the ported encounter table.

Above the rules, this world layer is where a from-scratch rewrite would silently drift, because this is where thirty-year-old game feel lives. The reference is full of numbers that are *load-bearing* without being documented anywhere except the original 8-bit assembly: a step is 16 ticks; a direction press has a 4-tick window where it turns you in place before it walks you; bonking a wall animates a walk-in-place; every text beat and HP-drain speed traces to a cited line of the original asm via the Lua's own timing table, which the port copies constant-for-constant. This is where "the spec is executable" stops being a slogan: you don't have to *notice* that ledge hops can land off-map, or that warp entry is positionally disabled after arrival, because the oracle's test harness already encodes it, and a tape that walks the route fails if you got it wrong.

Battle needed a different backbone, and the reference's is worth copying precisely because you would not design it from scratch: **the battle engine is a message and action queue, and the queue is the engine.** Text pages, HP-bar drains, animation beats, and state mutations are all rows, executed in order by one pump; the builders keep upstream's insertion semantics (`say` appends, `sayNext` inserts right after the row being executed), because half of Gen 1's battle feel is *when* a line of text appears relative to the HP bar it explains. Here is a faint, composed as rows:

```ts
// battle/battle.ts: BattleState.lua:3624 onFaint, as queue rows
onFaint(battler: WildBattler): void {
  if (battler.faintQueued) return;
  battler.faintQueued = true;
  this.actNext(() => { battler.fainted = true; }); // staging hides the card
  this.insertNext({ wait: FAINT_SLIDE });
  if (!battler.isPlayer) {
    // core.asm:792: the victory theme starts AS THE SLIDE LANDS, before
    // the fainted text and the exp text, not after the box is dismissed
    this.actNext(() => this.audioCues.push("music:victory"));
  }
  this.sayNext(`${displayName(battler)}\nfainted!`);
  if (battler.isPlayer) this.act(() => this.playerMonFainted());
  else this.act(() => this.enemyMonFainted());
}
```

Even damage is a row: `applyDamage` subtracts hit points and queues `drainNext(target, hp)`, and that row holds the pump while the bar ticks down at the reference's own drain speed from the ported timing table. The formulas the rows *carry* (damage, crit, accuracy, catch) come only from `rules/`; the queue never computes, it sequences.

Evolution is the layering at its cleanest, because one feature crosses all three floors: a pure rule, a battle-exit hook, and text pages. The rule half lives in `rules/evolution.ts` and is careful about a Gen 1 subtlety that is easy to get wrong: after a battle, only mons that gained a level in *that* battle are checked, so a mon that qualified earlier waits for its next level-up:

```ts
// rules/evolution.ts: Evolution.lua:195 checkParty, the decision half.
// Pure: returns the queue, mutates nothing; the caller owns the pages.
export function checkParty<T extends EvoMon>(
  data: VoxelmonData,
  party: readonly T[],
  leveledUp: ReadonlySet<T> | null | undefined,
): { mon: T; to: string; evo: EvolutionEntry }[] {
  const pending = [];
  if (!leveledUp) return pending;
  for (const mon of party) {
    if (!leveledUp.has(mon)) continue;   // only mons that leveled THIS battle
    const hit = pendingFor(data, mon, { kind: "levelup" });
    if (hit) pending.push({ mon, to: hit[0], evo: hit[1] });
  }
  return pending;
}
```

The shell half runs where upstream's `afterBattle` runs, at the battle-exit site, and drives the pending list one page at a time: `apply` mutates the mon (stats recalculated for the new base stats, current HP keeping the same HP *lost*, dex flags set), the "Congratulations!" page shows, and then the *evolved* species' learnset is checked at exactly this level, because a mon that evolves at a learnset level gains that move and one that evolves a level later does not. None of that nuance was designed here. All of it was read out of the Lua, ported with its citation, and pinned by a test.

## The renderer moved from run time to cook time

The Voxel Mod's renderer is a beautiful piece of *interpretation*: it looks at flat GB tiles and decides, live, what is wall and what is roof and what is tree. It can afford to; it runs on a desktop, inside the game process. The PSP cannot, so the port's structural move is to split that renderer in half along the build-time/run-time line, exactly like a bundler:

<svg viewBox="0 0 760 336" width="100%" role="img" aria-label="Pipeline diagram. Your ROM, SHA-1 gated, flows into import plus cook: a manifest-driven TypeScript decoder producing 16 datasets, and a voxelizer that classifies tiles, measures building volumes against templates, carves tree hulls, segments per-pixel props, bakes ambient occlusion, ground, and facades, and packs CLUT8 atlases, emitting voxelmon.vxpak with sections CHNK, ATLS, VPAL, STMP, GAME, AUDI, META and CMAP. The pak is consumed zero-copy on the PSP. A caption notes the Lua mod did all of this at runtime; here it happens once on a laptop." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="336" rx="12" fill="#0b0f1a"/>
  <rect x="16" y="96" width="132" height="118" rx="10" fill="#111827" stroke="#2b3a55"/>
  <text x="82" y="124" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">your ROM</text>
  <text x="82" y="144" fill="#94a3b8" font-size="11" text-anchor="middle">the red cartridge</text>
  <text x="82" y="166" fill="#64748b" font-size="10.5" text-anchor="middle">SHA-1 checked</text>
  <text x="82" y="180" fill="#64748b" font-size="10.5" text-anchor="middle">before decoding</text>
  <text x="82" y="200" fill="#64748b" font-size="10.5" text-anchor="middle">never shipped</text>
  <path d="M148 155 L174 155" stroke="#475569" stroke-width="1.5"/>
  <path d="M174 155 l-8 -5 M174 155 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="180" y="36" width="282" height="240" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="321" y="62" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">import + cook · Bun, TS</text>
  <text x="321" y="80" fill="#38bdf8" font-size="11" text-anchor="middle">build time, on your laptop</text>
  <text x="198" y="106" fill="#94a3b8" font-size="11">· manifest decode → 16 datasets</text>
  <text x="198" y="128" fill="#94a3b8" font-size="11">· classify: wall/roof/water/tree</text>
  <text x="198" y="150" fill="#94a3b8" font-size="11">· measure volumes → templates</text>
  <text x="198" y="172" fill="#94a3b8" font-size="11">· carve tree hulls · pixel props</text>
  <text x="198" y="194" fill="#94a3b8" font-size="11">· bake AO, ground, facades</text>
  <text x="198" y="216" fill="#94a3b8" font-size="11">· pack CLUT8 atlases, swizzled</text>
  <text x="198" y="246" fill="#64748b" font-size="10.5">the Lua mod does all of this at</text>
  <text x="198" y="260" fill="#64748b" font-size="10.5">runtime, per map; here it runs once</text>
  <path d="M462 155 L472 155" stroke="#475569" stroke-width="1.5"/>
  <path d="M472 155 l-8 -5 M472 155 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="478" y="36" width="266" height="240" rx="10" fill="#111827" stroke="#2b3a55"/>
  <text x="611" y="62" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">voxelmon.vxpak</text>
  <text x="494" y="90" fill="#e2e8f0" font-size="11">CHNK  <tspan fill="#64748b">pre-meshed chunks, i16</tspan></text>
  <text x="494" y="112" fill="#e2e8f0" font-size="11">ATLS  <tspan fill="#64748b">swizzled CLUT8 pages</tspan></text>
  <text x="494" y="134" fill="#e2e8f0" font-size="11">VPAL  <tspan fill="#64748b">per-tile color palettes</tspan></text>
  <text x="494" y="156" fill="#e2e8f0" font-size="11">STMP  <tspan fill="#64748b">removable stamps</tspan></text>
  <text x="494" y="178" fill="#e2e8f0" font-size="11">GAME  <tspan fill="#64748b">guest dataset, one parse</tspan></text>
  <text x="494" y="200" fill="#e2e8f0" font-size="11">AUDI  <tspan fill="#64748b">the ROM's sound programs</tspan></text>
  <text x="494" y="222" fill="#e2e8f0" font-size="11">META · CMAP  <tspan fill="#64748b">validation</tspan></text>
  <text x="611" y="252" fill="#64748b" font-size="10.5" text-anchor="middle">git-ignored: all ROM-derived</text>
  <path d="M380 288 L380 306" stroke="#475569" stroke-width="1.5"/>
  <text x="380" y="326" fill="#94a3b8" font-size="11.5" text-anchor="middle">the PSP maps the pak and draws in place; meshes never parsed, copied, or rebuilt on device</text>
</svg>

Everything the mod decided per-frame, the cooker decides once: the tile classifier with its conditional pins (one tile id can be a wall base *and* a shop counter, disambiguated by what sits above it), the repeat-aware building measurement that votes on heights across a facade, authored building templates applied in a four-stage read-measure-model-emit pipeline, tree canopies carved band-by-band into round hulls, props segmented from their sprites pixel by pixel, ambient occlusion computed into vertex shade. The PSP consumes finished 16×16-tile chunk meshes, zero-copy, the way OpenStrike consumes a cooked BSP. The importer feeding all this is worth a sentence of its own: it is manifest-driven, consuming the reference project's 3,274-entry symbol table verbatim rather than transcribing offsets, and its 16 output datasets are field-for-field parity-checked against the reference's own extractor before anything downstream trusts them.

### The sound programs, or: an own goal, admitted

Audio is the one place "presentation is data" earned an asterisk, and we earned it the expensive way. The first synth was a faithful TypeScript port of the reference's DMG chip interpreter (envelopes, vibrato, the noise LFSR, all of it), and we shipped a device build believing its switch was off. The device got laggy *and* musical at the same time; we blamed threading. The truth, dug out by a proper audit: the switch had been on the whole time (`setAudio(null)` meant "load the banks from the pak," and the comment beside it said the opposite), and the lag was the synth itself. The arithmetic is brutal and worth stating as a law: **one second of 11 kHz chip audio cost ~2.3 seconds of CPU in interpreted JavaScript on this machine.** An interpreted synth on device isn't over budget; it's arithmetically impossible.

So the synth moved into the Rust core, and the TS port was deleted the same day; keeping it as a "reference" would have enshrined our own intermediate artifact as truth. The real reference is the upstream `ChipSynth.lua`, run under LuaJIT, and the Rust interpreter was verified against it across **all 303 sound programs in the ROM (45 songs, 104 effects, 154 cries), five seconds each: zero differing samples out of ~200 million.** That sweep caught three rounding bugs no hand-written unit test would have found. Cost on device: the guest names a song in numbers, the core synthesizes PCM at **a fraction of a millisecond per tick**, and the ring is pumped inside the GPU's own wait bubble, where it is effectively free.

## One tape, four executors

Determinism is the family religion, and this port kept it strict. Input is an *intent tape*: walk three tiles north, press A, wait. Never frame counts. Logic steps at a fixed 60 Hz with a seeded RNG. So one tape that walks from the player's bedroom, downstairs, out into town, north through the tall grass (fighting the wild bird it finds there), and on to the next town is not a demo; it is *the* artifact everything else is checked against:

<svg viewBox="0 0 760 210" width="100%" role="img" aria-label="Verification chain. story.tape flows into the gameplay port running in Bun, which emits story.vtrace, the full op trace. The trace fans into the software rasterizer, which produces PNGs locally and FNV frame hashes committed as goldens, and into a capture EBOOT replaying the same trace on the PPSSPP emulator and on a real PSP, compared image-to-image against the rasterizer at eleven marks." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="210" rx="12" fill="#0b0f1a"/>
  <rect x="20" y="76" width="128" height="56" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="84" y="100" fill="#f1f5f9" font-size="12" text-anchor="middle">story.tape</text>
  <text x="84" y="118" fill="#64748b" font-size="10.5" text-anchor="middle">intent, not frames</text>
  <path d="M148 104 L176 104" stroke="#475569" stroke-width="1.5"/><path d="M176 104 l-8 -5 M176 104 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="182" y="76" width="150" height="56" rx="10" fill="#111827" stroke="#2b3a55"/>
  <text x="257" y="100" fill="#f1f5f9" font-size="12" text-anchor="middle">gameplay, in Bun</text>
  <text x="257" y="118" fill="#64748b" font-size="10.5" text-anchor="middle">60 Hz · seeded RNG</text>
  <path d="M332 104 L360 104" stroke="#475569" stroke-width="1.5"/><path d="M360 104 l-8 -5 M360 104 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="366" y="76" width="128" height="56" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="430" y="100" fill="#f1f5f9" font-size="12" text-anchor="middle">story.vtrace</text>
  <text x="430" y="118" fill="#64748b" font-size="10.5" text-anchor="middle">the full op stream</text>
  <path d="M494 92 L534 56" stroke="#475569" stroke-width="1.5"/><path d="M534 56 l-11 3 M534 56 l-6 9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M494 116 L534 152" stroke="#475569" stroke-width="1.5"/><path d="M534 152 l-6 -9 M534 152 l-11 -3" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="540" y="24" width="200" height="56" rx="10" fill="#111827" stroke="#2b3a55"/>
  <text x="640" y="46" fill="#f1f5f9" font-size="12" text-anchor="middle">software rasterizer</text>
  <text x="640" y="64" fill="#64748b" font-size="10.5" text-anchor="middle">PNGs local · hashes → goldens</text>
  <rect x="540" y="128" width="200" height="56" rx="10" fill="#111827" stroke="#e6a94b" stroke-width="1.5"/>
  <text x="640" y="150" fill="#f1f5f9" font-size="12" text-anchor="middle">capture EBOOT</text>
  <text x="640" y="168" fill="#64748b" font-size="10.5" text-anchor="middle">PPSSPP + real PSP · 11 marks</text>
  <text x="380" y="200" fill="#475569" font-size="11" text-anchor="middle">same tape → same trace → four executors that must agree: Bun, rasterizer, emulator, hardware</text>
</svg>

The committed goldens are hash lines, fifteen per tape, because pixels would be ROM-derived. When the emulated GPU and the software rasterizer are compared image-to-image at the story's eleven marks, they agree within a documented seam-rounding tolerance; when a change is *supposed* to be invisible, the hashes say so byte-for-byte, which is what later made it safe to rip the renderer's internals out repeatedly in the name of speed.

For the record, because it still surprises us: the distance from an empty directory to that whole chain green (importer parity, rules oracle, overworld, wild battles, the Rust core, the cooked pak, the sceGu EBOOT, the emulator end-to-end) **was one working session; the draft PR went up four hours and eighteen minutes after the first prompt.** Five research agents mapped the two upstreams and our own substrate in parallel; a design doc and a codegen'd, drift-guarded surface contract pinned the seams; and from there every port proceeded against an oracle instead of against hope. Thirty-four hours later the project moved out into its own repo. In between came the part no oracle covers.

## The machine disagrees

The first time the EBOOT ran on real hardware, the world was alive: an NPC wandering Pallet Town, water animating, the diorama standing up in perspective. The player, though, was a rectangle of colored static. The emulator showed nothing wrong. A day of PSPLINK loops (rebuild, `ldstart`, screenshot, diff against the rasterizer, about 12 seconds a cycle) turned that one symptom into three distinct bugs, and each one is a lesson about this class of hardware:

1. **Textured 3D draws must use 16-bit indexed vertices.** Float vertex formats, which the emulator accepts happily, sample garbage on the real GE. Every textured path now speaks i16, and the software rasterizer truncates identically so the two can never disagree about a pixel.
2. **CLUT8 texture pages must be at least 64 pixels wide.** Our sprite sheets were 16-pixel-wide pages, which real silicon missamples into vertical-strip noise. The emulator's software renderer actually agrees with hardware here, but the end-to-end test's fuzz tolerance had been quietly absorbing the difference. The tolerance was hiding a law.
3. **The third bug, determinism could never have caught.** The guest was passing the ROM's sprite *index* where the surface wanted an atlas *page*; page 0 is the terrain atlas, so the hero wore the tree texture, and NPCs, whose indices happened to land inside the sprite range, wore each other's clothes and looked plausible. Both the GE and the reference rasterizer executed the same wrong op stream in perfect agreement. Cross-executor comparison proves *consistency*, not *correctness*; this one took a person holding the device saying "the player flickers like a tree," twice, before we believed the report over the green tests.

The same loop settled the rest of the launch-day list. The game was grayscale because the Game Boy was; color is per-tile palettes from the reference project's `pokered-gbc`-derived tables (Red itself ships no color code), cooked into the pak like everything else, with both backends resolving every draw's palette through one shared function so CI and silicon cannot drift by a CLUT entry. Dialogue crawled at six frames a second because the UI layer issued one upload and one draw call *per tile* (a textbox is a hundred tiles) and the guest was re-encoding glyph strings every tick; one batched upload plus an indexed encoder took dialogue frames from 145 ms to **10.7 ms**. Every one of these was invisible on the desk and undeniable on the glass.

<img class="w-full rounded-xl border border-line" src="/assets/blog/voxel-psp-route-1.png" alt="Route 1 on the PSP: the player stands at the edge of tall encounter grass rendered as hundreds of extruded voxel tufts, with rows of carved round trees, a ledge, fences, and flowers." />

<p class="text-sm text-slate-500 -mt-4">Route 1, on device. The tall grass is the expensive way to render an encounter zone: every tuft is real extruded geometry, a decision you get to make when meshing costs nothing at runtime, and pay for below.</p>

## Where the milliseconds went

Indoors held 60 fps almost immediately. Outdoors, day one measured **84 ms a frame**, and the honest ledger said why: the worst story frame carried 110k triangles, over half of them carved trees, against a GPU that the first measurements said could feed ~18k per 60 fps frame. There was a cheap fix on the shelf, replacing carved trees with textured boxes (84 → 26 ms), and it was the wrong fix, because the carved trees *are* the product. The steer that reframed the endgame: this runtime will target many machines, so fidelity must be a **ladder**: named tiers in the spec, one cooked pak serving all of them, and the top rung pinned **bit-identical to the pre-ladder picture** by committed frame hashes, so no optimization for the PSP can quietly redraw the game everywhere else.

Then the PSP rung had to be *won* rather than configured, and the campaign ran on one instrument: an autopilot build that replays the story tape on the physical device and phase-logs every frame (guest, scene build, GPU wait, vblank, GC) over the PSPLINK cable. Fifteen lettered telemetry runs in one day, every change an A/B against the same scripted walk. Three findings decided it:

- **The CPU was the first beast, and it was death by a dozen cuts.** Re-staging grass and flower vertices against the camera each frame cost tens of milliseconds of software square roots; drawing in place under a constant depth bias, exact at the camera's focus, deleted the pass. The guest's map emitter re-ran a search every tick that an identity check made free (8.1 → **0.11 ms**), with the goldens proving the op stream stayed byte-identical. The JS engine's GC fired 175 ms collections mid-walk; now it runs on warp landings, hidden behind the screen cut. And the audio pump turned out to *self-aggravate*: below 60 fps each tick synthesizes catch-up PCM, making slow frames slower. Moving the pump after the GPU kick let synthesis run inside the wait bubble for free.
- **The GPU is fetch-bound, and it confessed through an accident.** Feeding it indices spliced through the per-frame pool was mysteriously faster than clean static buffers, because the spliced bytes had been CPU-written moments before and were still bus-warm. Cold, the GE pays **~0.7 µs per triangle** on vertex fetch whether the triangle faces you or not, which closed a whole category of standard advice: back-face culling and instancing buy nothing here (we measured both; one experiment got reverted the same hour). The only levers are *triangles that don't exist* and *bytes that are smaller*. So trees got a half-resolution carve whose UVs still span full-resolution art, low terrain got painted into a per-chunk oblique-projected ground bake, building facades folded into the same texture page, detail streams learned to draw a spatially uniform prefix, and the vertex slimmed from 20 to 16 bytes, a flat −20% on everything.
- **A boundary you can see is a bug.** The optimized rung shipped with distance thresholds (fine trees near, coarse far; live geometry near, baked far; grass fading at a ring), and a person walking the route reported all three within the hour: trees twinkling as the line swept them, the road popping baked↔live one step ahead, grass materializing at its radius. (The same pass surfaced a confession: the "uniform half-density" the code comments promised had never been implemented; half density was drawing the *north half of each chunk's grass*.) The fix is now the rung's governing rule, pinned in the spec: **no camera-relative representation change inside the visible field.** Every distance dial is unbounded or off; the budget is paid with uniform measures that cannot flicker because they never switch. It shipped faster than the artifact config it replaced.

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="Paired bar chart of mean frame times on the real PSP over the same scripted walk, before the campaign versus shipped. Pallet Town, worst window: 102.2 down to 34.2 milliseconds. The town-to-route seam: 128.6 down to 32.9. Route 1: 127.7 down to 27.8. Interiors: 33.3 down to 16.9. A dashed line marks the 33.3 millisecond budget of the 30 fps present lock. A footer notes logic stays at 60 hertz and every window presents exactly 150 frames per 300 ticks." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="300" rx="12" fill="#0b0f1a"/>
  <text x="24" y="30" fill="#94a3b8" font-size="12">mean frame, real PSP, same scripted walk</text>
  <rect x="460" y="20" width="10" height="10" fill="#e6a94b"/><text x="476" y="29" fill="#94a3b8" font-size="11">before the campaign</text>
  <rect x="620" y="20" width="10" height="10" fill="#38bdf8"/><text x="636" y="29" fill="#94a3b8" font-size="11">shipped</text>
  <line x1="316" y1="46" x2="316" y2="252" stroke="#475569" stroke-dasharray="4 4" stroke-width="1"/>
  <text x="24" y="66" fill="#e2e8f0" font-size="12">Pallet, worst</text>
  <rect x="170" y="54" width="450" height="12" rx="3" fill="#e6a94b"/><text x="628" y="64" fill="#e6a94b" font-size="11">102.2 ms</text>
  <rect x="170" y="70" width="150" height="12" rx="3" fill="#38bdf8"/><text x="328" y="80" fill="#38bdf8" font-size="11">34.2</text>
  <text x="24" y="120" fill="#e2e8f0" font-size="12">town↔route seam</text>
  <rect x="170" y="108" width="566" height="12" rx="3" fill="#e6a94b"/><text x="728" y="118" fill="#0b0f1a" font-size="11" font-weight="700" text-anchor="end">128.6</text>
  <rect x="170" y="124" width="145" height="12" rx="3" fill="#38bdf8"/><text x="309" y="134" fill="#0b0f1a" font-size="11" font-weight="700" text-anchor="end">32.9</text>
  <text x="24" y="174" fill="#e2e8f0" font-size="12">Route 1</text>
  <rect x="170" y="162" width="562" height="12" rx="3" fill="#e6a94b"/><text x="724" y="172" fill="#0b0f1a" font-size="11" font-weight="700" text-anchor="end">127.7</text>
  <rect x="170" y="178" width="122" height="12" rx="3" fill="#38bdf8"/><text x="286" y="188" fill="#0b0f1a" font-size="11" font-weight="700" text-anchor="end">27.8</text>
  <text x="24" y="228" fill="#e2e8f0" font-size="12">interiors</text>
  <rect x="170" y="216" width="147" height="12" rx="3" fill="#e6a94b"/><text x="325" y="226" fill="#e6a94b" font-size="11">33.3</text>
  <rect x="170" y="232" width="74" height="12" rx="3" fill="#38bdf8"/><text x="238" y="242" fill="#0b0f1a" font-size="11" font-weight="700" text-anchor="end">16.9</text>
  <text x="316" y="268" fill="#94a3b8" font-size="11" text-anchor="middle">33.3 ms · the 30 fps present lock</text>
  <text x="24" y="288" fill="#475569" font-size="11">logic stays 60 Hz; presentation locks to an even 2-vblank beat: 150 frames per 300 ticks</text>
</svg>

The last number is the one we argued about most. Outdoors landed at 28–43 fps (real 60 was another geometry diet away), and an uneven 28-to-43 *feels* worse than it sounds, because what reads as stutter is the alternation between two- and three-vblank frames. So the shipped rung locks presentation to an even 30 fps beat while **logic stays at 60 Hz**, two game ticks per presented frame, and the telemetry shows exactly 150 presented frames per 300 ticks in every window of the walk. An even beat is what "smooth" actually is. Interiors, meanwhile, run at 59–65 fps, and a desktop-class host asks for the top rung and gets the pre-ladder picture, pixel for pixel.

## What this actually proves

Pocket Voxel started as a homage to two Lua repos and ended as the family's strongest datapoint for a claim we hadn't tested: **the guest tier can own an entire game**, world, battles, scripts, saves and all, as long as the boundary is a retained scene and the traffic respects the measured budget. A couple of ops per tick is not a compromise; for this genre it is the natural shape. And the porting method generalizes past this pair of upstreams: if the program you are rewriting *runs*, it isn't documentation; it's an oracle. Run it headless, pin its answers, cite its lines, and the scariest question of any rewrite (*did we change the behavior?*) becomes a diff in CI.

<img class="w-full rounded-xl border border-line" src="/assets/blog/voxel-psp-bedroom.png" alt="The player's bedroom as a voxel diorama on the PSP: bed, bookshelf, an SNES on a table and a potted plant, each piece of furniture extruded from its Game Boy tile art." />

<p class="text-sm text-slate-500 -mt-4">Where every save file starts. The furniture is per-pixel extruded prop geometry: the cooker's work, consumed as bytes.</p>

The gaps, named, because that is house policy: wild battles are the shipped battle scope; trainer battles, move animations, and the box system are ports still owed. Boot takes about a minute (QuickJS parsing a megabyte of game data deserves a progress bar, and the data deserves a binary format; both were deliberately deferred, because the standing rule was that nothing may cost runtime frame rate). The pak outgrew a first-generation PSP's 24 MB of user RAM, so the fat-model rung needs mesh instancing before it is honest. And outdoor 60 is not a mystery, just unfinished: the per-kind triangle probe says exactly which geometry goes next.

## Try it

[pocket-nexus/pocket-voxel](https://github.com/pocket-nexus/pocket-voxel) is MIT, with the same vendored-runtime shape as OpenStrike (`vendor/pocketjs` pinned as a submodule). Bring your own ROM:

```sh
VOXELMON_ROM=path/to/red.gb bun tools/voxel.ts import   # SHA-1 gated decode
bun tools/voxel.ts cook                                 # voxelize → voxelmon.vxpak
bun tools/voxel.ts sim --shots                          # the story tape, rendered headless
bun tools/voxel.ts psp --release                        # the EBOOT, if you have the hardware
```

No PSP? The simulator renders the same trace the hardware replays, and PPSSPP runs the EBOOT. If you do have one: it is the opening of the game you remember, standing up in three dimensions on a machine from 2004, off a cartridge you dumped yourself.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
