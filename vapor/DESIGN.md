# Pocket Vapor — design

**Pocket Vapor** (`@pocketjs/vapor`) is the ahead-of-time Vue compiler of the
Pocket family: you write a component in a **strict TypeScript subset of Vue
Vapor** — real `ref`/`computed` reactivity, real JSX templates — and the
compiler emits native code for machines that could never host a JavaScript
engine. The original proof target is the Game Boy Advance: 16.8 MHz
ARM7TDMI, 256 KB of work RAM, no OS, no allocator, no GC. The same compiler
now also targets the Game Boy, NES, an ESP32 MeowBit profile, and Playdate;
all builds remain native C with a fixed memory plan, not an embedded
JavaScript runtime.

Vue Vapor's thesis is *compile the virtual DOM away*. Pocket Vapor extends
it one machine layer down: **compile the JavaScript engine away.** The
component keeps Vue's authoring model and update semantics; the runtime that
ships is a few kilobytes of C — a dirty-bit scheduler, an arena, and a block
tree — not an interpreter.

## 1. Why not another DSL

Two prior Pocket experiments (`@pocketjs/aot`, then Pocket Static) compiled
games for retro consoles by carving TypeScript down to a bespoke DSL:
declaration builders plus generator scripts lowered to bytecode for a ~600
line stack VM. They work, but the author is always aware they are writing
the DSL, not the framework: no shared reactivity model, no component tree,
nothing transfers to or from real app code.

Pocket Vapor inverts the contract. The input is not a DSL that resembles
TypeScript; it is **Vue Vapor code that happens to obey a subset**. The
subset is enforced by the compiler with file:line errors, and membership has
an operational definition:

> Every Pocket Vapor component must also run, unmodified, under the real
> `@vue/runtime-vapor` on a JS host. The E2E suite executes both — the real
> Vue build as the oracle, the compiled ROM in an emulator — drives the same
> input script into each, and asserts the same rendered screen.

That is the MicroPython positioning: MicroPython is not a Python-flavored
DSL, it is a subset of Python with an implementation sized for
microcontrollers. Pocket Vapor is that, for Vue.

## 2. The one idea: reactivity as a compile-time artifact

A Vue component's reactive graph — which bindings read which refs — is
almost always statically evident in the source. Vapor already exploits this
shape at the template level; Pocket Vapor exploits it at the memory level.

The compiler builds the whole graph at build time:

- every `ref()` / `computed()` in setup becomes a **slot** in one statically
  sized state struct (no boxing, no heap);
- every dynamic template binding becomes an **effect function** in ROM;
- every dependency edge becomes a bit in a **subscriber bitmask** in ROM.

At runtime, writing `count.value = n` through a generated setter marks a
dirty bit and clears the validity bits of every computed whose (compile-time)
dependency mask includes that ref. Once per frame (Vue's batched-scheduler
semantics, with vblank as the microtask boundary) the flush runs each effect
whose mask intersects the dirty word; computeds recompute lazily through
generated accessors, exactly like Vue's `computed` — including inside event
handlers that read a computed between two mutations. Dependency *tracking* —
the expensive, allocating part of any reactive runtime — has no runtime
existence at all.

Where a dependency is conditional (`flag.value ? a.value : b.value`), the
compiler over-approximates: the effect subscribes to all refs it *may* read.
An over-approximated effect can only re-run redundantly — it renders the
same value it would have — so Vue's observable semantics are preserved; the
graph is a superset, never a subset. This is the one deliberate divergence
from Vue's dynamic dependency collection, and the E2E oracle keeps it
honest.

Before setup analysis, a sparse conditional constant propagation pass
(`vapor/compiler/sccp.ts`) tightens that superset. Every ref starts at
its seed constant; write sites collected across the component body lower
it, except writes behind a guard that is decidably false under the current
environment. The pass is optimistic and iterates to a fixpoint, so
mutually-gated refs converge (`if (a.value) b.value = true;
if (b.value) a.value = true;` with both seeded `false` keeps both
constant). A ref proven constant folds at every read: it registers no
dependencies, decidable ternaries and `if`s compile only the taken arm,
and the dead arm's refs leave the effect mask — and the ROM — entirely.
Folded refs keep their state slot, seed, and debug-block entry, so the
oracle and device grids stay comparable. Soundness rests on two subset
rules the compiler already enforces: assignments occur only in statement
position (if/ternary conditions are the complete guard vocabulary), and
no closure escapes setup (every function in the component body is assumed
callable). Locals are not tracked — a write whose right side reads a
local lowers the ref to not-a-constant.

## 3. Memory: arenas, not GC

The runtime never calls `malloc` and never frees:

- **Static plan** — refs, computed caches, effect tables: fixed-size, laid
  out by the compiler. The compiler prints the memory plan (bytes of state,
  bytes of ROM tables) as part of the build.
- **Typed pools as arenas** — a `ref<T[]>` compiles to a fixed-capacity
  contiguous pool of inline `T` records; `push`/`splice` become pool ops
  (append / shift-down), and string fields are bounded byte arrays living
  inside their record. Exceeding a budget drops the operation and raises a
  tripwire flag the debug block exposes — never UB.
- **Bounded strings** — a `ref<string>` is a `{len, bytes[24]}` slot;
  string expressions build into overlay scratch and assign through a
  change-compare (Vue's `Object.is` set gate, by value).
- **Overlay slots for frame-local temporaries** — materialized view
  chains and string scratch compile to shared static slots, not
  per-site statics or C-stack frames. Every temporary is tagged with the
  generated function that owns it; two temporaries share a slot unless
  their owners can be live at the same time — same function, or one
  reachable from the other in the static call graph (helpers, computed
  accessors, keymap dispatch). The subset forbids recursion and nothing
  runs from interrupts, so reachability is the whole liveness story. On
  the 6502 and SM83 this also converts stack-relative addressing into
  absolute addressing, which is smaller and faster; the compiler prints
  the overlay plan (slots, bytes, temps served) with the memory plan.

Nothing is ever collected because nothing is ever untracked: object shapes
are closed (the TS subset forbids dynamic keys), so lifetime is the pool
slot's lifetime. This is the "arena instead of GC" bet: for the UI workloads
these devices run, *ownership is structural* — state lives exactly as long
as the component or the collection entry that declares it.

## 4. The subset (v1)

Enforced with diagnostics, not documentation. In:

- `ref<number>`, `ref<boolean>`, `ref<string>`, `ref<T[]>` of a closed
  interface `T` with number/boolean/string fields; `computed<...>` of pure
  expressions over those — yielding a number, a **list view**
  (filter/slice chains), or a **record reference** (`filtered.value[i]`,
  compiled to a cached nullable pointer).
- **UI components**: module-level `function Name(props: {...}) { return
  <row .../> }` — genuine vapor functional components under the oracle,
  **inlined at compile time** by Pocket Vapor: each use site substitutes
  `props.<name>` with the use-site expression at the AST level, so const
  folding, dependency masks and row-span analysis all see through — six
  components in the demo add zero effects, zero RAM and zero calls. One
  root `<row>` per component, no nesting (v1), and prop names must not
  collide with row attributes (`y`/`x`/`pal`): vue's functional-component
  fallthrough only forwards class/style/on* while suppressing the
  template's own root binding of a same-named key, so a colliding prop
  would be written by nobody — the compiler rejects it with that
  explanation (use `line` for the row position).
- **Keymaps**: a setup const of shape `{ [Button.X]: action, ... }` where
  actions are zero-arg arrows or setup functions. Compiles to a 10-entry
  function-pointer table in ROM; dispatch is the one-liner
  `(cond ? mapA : mapB)[b]?.()` (missing entries are null pointers, `?.()`
  is the null check).
- **Setup helpers with parameters**: `function moveCursor(d: number)` —
  compiled to real C functions with `s32` params (annotation required);
  callable from actions, handlers, and each other.
- **Const objects** (`const PAL = { title: 1, ... }`) fold at member
  access; const string/string[] fold `.length` and index.
- **Whole-list assignment**: `todos.value = todos.value.filter(...)` —
  views over one list always carry increasing pool indices, so the
  compiler emits an in-place compaction; new-array identity always
  triggers, matching Vue.
- Sugar: `+=`-family compound assignment (numbers and strings), `++`/`--`
  statements, negative `slice` ends.
- Component = `setup()` returning a JSX render closure. One root component
  (v1: no props, no child components — the block machinery supports them,
  the demo doesn't need them).
- JSX: the Pocket host vocabulary (§5) with text interpolation
  `{expr}`, conditional attributes, list rendering via `.map()` over a
  `ref<T[]>` (compiled to a keyed list block), event handlers referencing
  setup-scope functions.
- Statements in setup functions: `let/const`, assignment and compound
  assignment, `if/else`, `for`/`while`, early `return`; expressions:
  arithmetic/comparison/logical ops, template literals, method subset on
  arrays (`push`, `splice`, `filter`, `map`, `find`, `length`) and strings
  (`slice`, `length`, concatenation).
- Numbers are 32-bit signed integers on the device. Fractional literals and
  `/` results are a compile error unless annotated — the demo needs none.

Out (compile errors): closures escaping setup, dynamic property access,
`any`, exceptions, async, classes, prototype anything, recursion in render,
`reactive()` deep proxies (v1 is `ref`-first; `reactive` is sugar the
compiler can add later).

## 4.5 Styling: the class DSL and the target style contract

Rows declare their look with the same Tailwind vocabulary the interpreted
framework compiles — `framework/compiler/tailwind.ts` owns the color table,
Pocket Vapor imports it, so `text-emerald-500` is one name across the whole
platform. The cell-grid subset:

    bg-<color>   text-<color>   align-left|center|right
    (colors: any tailwind name or bg-[#hex]; dynamic looks are ternaries
     of full class literals — the framework's constitution, reused)

Like everything in Pocket Vapor, styling compiles to data. Every distinct
(ink, paper) pair the app uses becomes an entry in the app's PAIR TABLE;
the pal byte in the cell grid is the pair id on every target. What an id
MEANS is the target's style contract:

| target | contract | lowering |
|---|---|---|
| web (oracle/dev host) | `web` | full color, CSS |
| gba | `rgb555`, <= 15 pairs | pair id = BG palette bank (BGR555 ink/paper) |
| gb, nes, playdate | `styles2` | pair -> glyph style by luminance polarity (dark-on-light / light-on-dark) |
| esp32 | `rgb565` | pair id -> RGB565 ink/paper values rasterized into the LCD cell |

Diagnostics are compile-time and structured (`bun vapor/compiler/cli.ts
check <file>` prints the whole matrix in one run, no toolchains needed):

    VS101 unknown class            error
    VS102 unknown color            error
    VS103 palette budget exceeded  error (rgb555 targets)
    VS104 pairs collapse to one glyph style   warn -> error with --strict
    VS105 dynamic class not a ternary of literals   error

On oxc: considered and not adopted for the compiler. The checker needs the
reactive graph and the type environment the compiler already builds on the
TypeScript API — a second AST would buy parse speed we don't need (one
file, ~50 ms) at the cost of divergence. Where oxc could earn a place
later is editor-time linting: publishing the subset + class rules as an
oxlint plugin would give red squiggles without booting the compiler. The
`check` subcommand is the contract such a plugin would mirror.

## 5. Host vocabulary and rendering

Each target presents a fixed logical cell screen: 30×20 on GBA, 20×18 on
GB and ESP32, 22×18 on NES, and 50×30 on Playdate. The ESP32 MeowBit profile rasterizes its
20×18 grid as 8×7 cells into a 160×126 content area on the 160×128 ST7735
panel. The portable, cross-target cell vocabulary is deliberately one
intrinsic with two interpreters — the C cell grid on device, and a ~60-line
tree walker over the oracle's micro-DOM:

- `<row y={n} x={n} pal={p}>` — paints its text children at (x, y) in
  palette `p`, padded with spaces to the right edge; later rows overwrite
  earlier ones (document order).
- Children are string literals and `{expr}` interpolations (numbers,
  strings, chars, ternaries of literals).
- Lists are plain Vue: `{view.value.map((t, i) => <row y={BASE + i} …/>)}`.
  The compiler turns the whole map into one paint loop; the oracle lets
  vapor's own reactive block machinery re-render it.
- Conditional rows are plain Vue too: `{cond ? <row …/> : null}`.
- Looks come from the class DSL (§4.5); the painter and every runtime
  agree on pair ids, and the oracle asserts them as a per-cell grid.

There is one deliberately target-specific exception to that portable cell
vocabulary: the experimental GBA RPG host. It is a narrow vertical slice,
not a new general-purpose JSX renderer, and non-GBA target admission rejects
it. Its responsibilities are split four ways:

1. **Static assets — `defineRpgMap(...)`.** Map rows, solid characters,
   event-character ids, and dialogue records are build-time declarations.
   The compiler validates the 30×20 bound, equal row widths and byte-oriented
   ids, then emits flat tile/collision data plus event and dialogue tables in
   ROM. None of this is mutable gameplay state.
2. **Pure world queries — `rpgBlocked(...)` / `rpgEventAt(...)`.** The host
   module provides real, deterministic JS lookup semantics; AOT recognizes
   the same calls and emits calls to fixed C helpers over the generated map.
   Out-of-bounds movement fails closed.
3. **Reactive gameplay — ordinary Vue Vapor.** Mode, integer player position,
   facing, in-flight pixel progress, quest state, current dialogue/choice, HP
   and battle selection are ordinary `ref` slots; gates are `computed` and
   screen offsets are derived expressions. `onButton` keymaps, the standard
   Vue Vapor `onFrame(buttons)` lifecycle, and setup functions implement movement,
   interaction, dialogue and battle. A step advances by a deterministic 2px
   per 60 Hz tick; the destination cell and its event commit only on arrival.
   They use the same dirty-bit graph and direct C lowering as Todo. There is
   no residual script bytecode, stack machine, hidden controller state, or
   second gameplay VM.
4. **Fixed presentation — `<RpgScreen .../>`.** The component is stateless:
   every dynamic input, including the signed player pixel offsets and walk
   frame, arrives as a prop and therefore participates in the normal
   dependency mask. The GBA runtime derives a fractional camera from those
   props, renders a 16×11 overscan tile window on BG1 and characters through
   OBJ, then commits tile/OAM/scroll/window shadows during VBlank. It does not
   own a hidden motion timeline or expose GBA registers or SDK concepts to
   application code.

The RPG movement contract consumes the standard hardware-neutral button mask
through `@pocketjs/framework/vue-vapor/lifecycle`'s `onFrame`. The GBA adapter
maps its physical held keys to the shared `BTN` ABI; app code never reads GBA
key bits. Direction priority is deterministic, a current step finishes after
release, and turning, collision and arrival events remain gameplay state that
the compiler/debug tape can observe. Dialogue and battle still use
`onButton` press edges, so choices advance once per physical press.
The JS `RpgScreen` currently returns no pixels, so collision/event behavior
can run in the JS/oracle path but pixel-frame acceptance is mGBA-only for
this POC. A browser pixel renderer, saves, audio and CJK text are follow-ups,
not implied capabilities.

Input is not DOM events. Pocket Vapor exposes four explicit capabilities:

- `onButton((b: Button) => void)` for frame-latched press edges;
- `onButtonRepeat((b: Button) => void)` for normalized held-D-pad repeats
  (currently supplied by the GBA target);
- `onFrame((buttons) => void)` from the public Vue Vapor lifecycle for the
  shared held `BTN` mask (currently lowered by the GBA target);
- `onAxisDelta(RelativeAxis.Primary, (delta) => void)` for signed,
  hardware-neutral incremental movement in canonical units.

Under the oracle the module executes and the test tape feeds it; under the
compiler registrations become `app_on_button()`, `app_on_button_repeat()`,
`app_on_frame(buttons)`, and `app_on_axis_delta(axis, delta)`. Physical hosts
own normalization:
rotary adapters preserve signed motion as millidegrees, while applications
own detents, acceleration, and sensitivity. Playdate forwards crank motion
to Primary; a future ESP32 board can adapt an encoder without exposing pins
to the app. Axis demands are derived from registrations, and a target
without an adapter fails admission with `VT102`.

## 6. Pipeline

```
todo.tsx ─┬─ framework/compiler/jsx-plugin.ts + vue-jsx-vapor ──► real Vue Vapor app (oracle)
          │
          └─ vapor/compiler/compile.ts (Bun, TS compiler API)
               1 subset check      diagnostics with file:line
               2 setup analysis    refs/computeds/functions/handler → slots + C fns
               3 template analysis JSX → static rows + effects + map loops
               4 graph build       reads → transitive ref deps → bitmasks
               5 span merge        overlapping row spans fuse into one effect
               6 memory plan       slots, pools, budgets (printed with the graph)
               7 emit C            gen_app.c (state, computeds, effects, handler)
               8 cc + link         target toolchain + vapor/runtime/<target>/*
                                   → ROM, firmware, or Playdate .pdx
```

The fixed C contract (`vapor/runtime/vapor.h` plus `vapor_core.c`) is shared
by all apps. Each target supplies its hardware half: the console runtimes
own startup, video commit, input edges and a fixed debug block; the ESP32
runtime owns the ESP-IDF frame loop, ST7735 RGB565 raster, MeowBit GPIO
input and the UART receipt protocol. The Playdate runtime owns the SDK event
handler, pushed-button snapshots, and direct 52-byte-stride 1bpp framebuffer.

## 7. E2E: the oracle is real Vue

`vapor/tests/`:

1. **Compiler unit tests** (`compiler.test.ts`) — subset diagnostics with
   file:line, deterministic C output, dependency-mask assertions on the
   reactive graph.
2. **Oracle tests** (`oracle.test.ts`) — the app's behavior pinned on real
   `vue@3.6` runtime-with-vapor over the micro-DOM: filters, toggles,
   editing, clamping, the empty state.
3. **Oracle ↔ ROM parity** (`parity.test.ts`) — one tape of button presses
   drives both the oracle and each console ROM; after every press the
   target's logical grid (chars *and* palettes) is compared cell-for-cell,
   read from the console runtime's fixed debug block.
4. **Oracle ↔ physical ESP32 parity** (`bun run vapor:esp32:verify`) — the
   verifier replays that interaction tape at 115200 baud and requests a
   logical-grid receipt after every press. This is an explicit opt-in
   hardware contract: `H` identifies the firmware, `R` resets in-process,
   `P <0..9>` dispatches a Pocket button, and `D` dumps character and
   palette grids. The source-derived build ID prevents an older compatible
   firmware from being mistaken for the current build. The receipt proves
   logical-grid parity and exercises LCD commits, but does not read panel
   pixels or electrically actuate GPIO buttons; those remain manual checks.
   Physical hardware is not part of the default emulator-only test suite.
5. **Playdate native boundary** (`playdate.test.ts`) — compiled C tests
   exercise exact framebuffer bytes and a fake SDK table drives lifecycle,
   pushed-button batches, crank accumulation/docking, redraws, receipts, and
   fatal render behavior. The Playdate Todo is also replayed through the real
   Vue Vapor oracle with signed Primary-axis deltas.
   Separate SDK smoke builds validate Simulator and ARM device packages;
   physical display/input verification remains manual.

Layers 3 and 4 state the claim of the whole project: same file, real Vue on
a JS engine, and native code on devices, compared for every step of the
interaction rather than only the final frame. The three console targets run
under automated emulators; ESP32 uses the same grid-receipt assertion when
a board is connected. Playdate's first implementation has deterministic
native-boundary tests and package smoke builds, not a claimed hardware
parity transport.

## 7.5 Targets

| | GBA | GB (DMG) | NES | ESP32 MeowBit | Playdate |
|---|---|---|---|---|---|
| CPU | ARM7TDMI 16.8MHz | SM83 4.19MHz | 6502 1.79MHz | Xtensa LX6, up to 240MHz | Cortex-M7 |
| Toolchain | arm-none-eabi-gcc | sdcc + sdasgb + makebin + rgbfix | cc65/ca65/ld65 | ESP-IDF v6.0.2 | Playdate SDK CMake + pdc |
| Grid | 30x20 | 20x18 | 22x18 (centered) | 20x18 on ST7735 160x128 | 50x30 on 400x240 1bpp |
| Palettes | 6 real BG banks | 2 glyph styles (BGP is global) | 2 glyph styles in CHR-ROM | RGB565 ink/paper pairs | 2 glyph styles |
| Pool / str caps | 32 / 24 | 32 / 24 | 8 / 20 (2 KB CPU RAM) | 32 / 24 | 32 / 24 |
| Image | flat ROM + header patch | ROM-only 32 KB | NROM-256 + CHR-ROM | ESP-IDF flash image | independent Simulator/device `.pdx` |
| Debug receipt | EWRAM 0x2000000 | WRAM 0xD800 (grid IS the block) | $0200 fixed segment | UART 115200 (`H/R/P/D`) | SDK console `PVREADY/PVFRAME/PVERROR` |
| E2E transport | libmgba | libmgba | jsnes | physical USB serial (opt-in) | fake SDK unit; Simulator/device smoke |
| Relative axes | none | none | none | board adapter (not yet configured) | Primary = crank, signed millidegrees |

The generated C is target-independent; geometry and budgets arrive as
`#define`s, `SCREEN.*` folds in the compiler, and each hardware runtime
implements the same `vapor.h` contract. 8-bit portability rules baked into
codegen: `s32`/`u32` are `long` (16-bit `int` consoles),
declarations hoist to function tops (cc65 is C89), variable-index record
access is u16 pointer arithmetic and bit masks come from a ROM table
(sdcc 4.6 SM83 miscompiles some u8-by-u8 multiplies — the __muluchar
lesson inherited from Pocket Static).

## 8. The demo — VAPOR TODO

`vapor/examples/todo/todo.tsx` — TodoMVC, Pocket-pad-idiomatic:

- List mode: ↑/↓ cursor, A toggle done, B delete, R cycles filter
  (ALL/ACTIVE/DONE — a `computed` filtered view), SELECT clears completed,
  START opens the editor.
- Edit mode: ←/→ scrub the glyph picker, A commits a glyph, B backspaces,
  START commits the todo (`todos.value.push(...)` into the pool).
- Header shows `{remaining.value} LEFT` (a `computed`); footer shows mode
  keys. Done rows render dim with a filled checkbox.

The ESP32 MeowBit exposes the six direct directions/action inputs used by
the app. Release-latched pairs provide the remaining Pocket buttons:
A+B = START, Left+Right = SELECT, and Up+Down = R.

Playdate exposes A, B and the D-pad directly. It has no ordinary
Select/Start/R/L inputs, so target admission rejects those demands with
`VT101`. `vapor/examples/todo/todo.playdate.tsx` keeps the same model and
view but consumes `RelativeAxis.Primary` for list movement. This frees
Up/Down for new/clear in list mode and save/cancel in edit mode. The
six-button example remains a minimal regression fixture.

State: 6 refs, 5 computeds (two of them list views), 4 span-merged paint
effects, a 32-entry todo pool. The compiler's memory plan for the whole app
is ~940 bytes of RAM; the GBA cartridge is under 9 KB, while the ESP32
artifact also includes the ESP-IDF platform image — which is the point of
keeping app state and generated C independent of the hardware envelope.

## 9. Out of scope v1 (explicit)

Components-with-props and slots (block machinery is shaped for them; not
demoed), `reactive()`/`watch()` sugar, floats/fixed-point, CJK text, sound,
saves, and unattended physical-device CI. Console parity remains
emulator-driven; ESP32 parity is available through the explicit
USB-connected verifier.
