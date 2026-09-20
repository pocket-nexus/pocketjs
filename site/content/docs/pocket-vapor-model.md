# TypeScript models to Rust

**Model AOT compiles the basename TypeScript model into a Rust implementation
of the generated view-model trait.** Solid TSX and Vue views retain their
View IR boundary. Browser and QuickJS builds lower the same model to JavaScript
with the framework reaction scheduler and task state machines.

## Select a model implementation

```json
{
  "app": {
    "framework": "solid",
    "aot": true,
    "model": "compiled",
    "recursionLimit": 256
  }
}
```

`model` defaults to `"rust"`, which keeps the application's Rust model.
`"compiled"` requires a `.ts` basename module containing function bodies.
**A compiled model outside the supported subset fails with a
`file:line:column` diagnostic.** A `.d.ts` contract uses the Rust model mode.

```sh
bun vapor/compiler/cli.ts check solid-aot-lab --strict
bun vapor/compiler/cli.ts build solid-aot-lab --strict
cargo check --manifest-path apps/solid-aot-lab/Cargo.toml
bun vapor/compiler/cli.ts check solid-aot-lab --ir .pocket-build/model/view.json
bun vapor/compiler/cli.ts run my-app --tape input.json
```

The build writes `gen/app_model.rs` beside the generated view modules.
`AppModel` implements `AppViewModel` and `Default`. Factory modules produce
one model type per factory, with constructor parameters for mount-time values.
The application's Rust entry creates `AppApp<AppModel, Host>` and supplies host
integration. **The demos' `gen/` directories are ignored by Git.** Run the
AOT build before compiling the demo with Cargo.

**View IR format 4 and Model IR format 1 are separate files.** `--ir view.json`
writes the view contract and protocol metadata to `view.json`, and model bodies
to `view.model.json`. A serialized view produces the same Rust view without
loading model bodies. The default model trait methods keep handwritten models
compatible with the protocol.

The reference player accepts a tape array, or `{ "hz": 60, "frames": [...] }`.
Frames carry `buttons`, relative `axes`, service `deliveries`, or explicit
`dispatch` entries. `clock` overrides the frame's virtual time in milliseconds.
A focus or touch activation uses `target` with the view node's `debugName`;
the reference player does not compute directional focus from layout geometry.

## Declare state and methods

```ts
import { createSignal } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { frames, type i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
export const double = createMemo<i32>(() => count() * 2);

createEffect(on([count], () => {
  console.log(count());
}, { defer: true }));

export function increment(): void {
  setCount(previous => previous + 1);
}

export async function blink(): Promise<void> {
  setCount(1);
  await frames(2);
  setCount(0);
}
```

Import Solid signal primitives from `solid-js`; import compiled-model memos,
effects and `on` from `@pocketjs/framework/solid/reactive`. A compiled module
cannot import `createMemo` or `createEffect` from `solid-js`.
Vue models use `ref` and `computed` from `vue`, with `watch` and `watchEffect`
from `@pocketjs/framework/vue-vapor/reactive`.

The root module owns the app's state. Each mounted factory instance owns its
signals, fields, memos and tasks. **Unmounting a factory cancels its tasks and
drops its state; a remount constructs a new region.** Module imports may bring
functions and constants from pure modules. Another model's state is reached
through props, events or context. Every reachable module's top level is checked,
including a module imported for one constant.

Pure functions receive their inputs as parameters. They cannot read model
state, start tasks or access the host. Module constants and signal seeds are
literals, constants, or object and array literals containing those values.
Factory parameters can seed the factory's state.

## Reactions and cached values

**One reaction visits each scheduled memo and effect once.** The compiler
records reads, writes, subscriptions and external commands for each body.
Writes and subscriptions determine the schedule; a cycle is a compile error.

`on([count], callback)` declares subscriptions. An inferred effect is admitted
when every execution path subscribes to the same signals and memos. A conditional
read or a read inside a collection callback can require `on`, since a branch
may be skipped or the collection may be empty. `untrack` records the read for
analysis without subscribing; it is admitted inside effects. A functional
setter's parameter reads the previous value without subscribing.

Memos may read signals, memos, constants and pure functions. Reading a private
mutable field from a memo is a compile error. A handler or resumed task reads
stale memos through an on-demand computation. Settle recomputes stale memos
before rendering; render getters read the cache through `&self`.

At a frame boundary, the host takes one readiness snapshot. Ready tasks resume
in region creation order and task start order, before input dispatch. Reaction
and settle follow dispatch; the view then updates and lifecycle hooks run.
Animation, service and log commands drain in emission order after the update.

## Values and bounds

**Reading a non-primitive signal produces an immutable view.** Use `copy` to
make a value that a local may mutate. Passing or storing an owned value copies
its contents. `equals` compares arrays and contract objects by contents;
`===` and `!==` are restricted to primitives.

A primitive signal changes when its value differs. A non-primitive write counts
as a change, including two writes of the same owned local. Writing back the
current unmodified view of that signal is unchanged. A local retained across
`await` becomes an owned snapshot at suspension.

Integer source tokens such as `1` infer `i32`; `1.0`, `1e3` and `.5` infer
`f64`. A fractional token cannot adopt an integer annotation. A local retains
one numeric type through assignments. Integer division uses `idiv` and remainder uses `imod`. `/` promotes integer
operands to `f64`; floating operands retain their declared precision.

`for` and `for ... of` have a bound evaluated before entering the loop.
`while` and `do` are compile errors. Development builds count function call
depth and stop at `recursionLimit`, default 256, reporting the function name.
Release builds omit that check.

`Cap<string, N>` maps to `heapless::String<N>` in UTF-8 bytes.
`Cap<T[], N>` maps to `heapless::Vec<T, N>` in elements. Overflow reports the
field name in development builds; release builds truncate at the capacity,
preserving a UTF-8 character boundary. A tagged collection can contain values
that allocate, such as untagged strings.

## Tasks and host services

**An async model function becomes a state machine whose segments run at frame
boundaries.** Starting a task executes its first segment in the caller's phase.
Starting the same function again cancels its prior call in that region. Earlier
writes and commands remain applied. Cancellation runs no later segment or
user cleanup code.

The generated public method takes a `&mut Vec<Cmd>` command sink and returns
`()`. A source `Promise<T>` result is delivered to a task awaiting that call.

| Awaitable | Boundary condition |
|---|---|
| `frames(n)` | Target frame reached |
| `after(ms)` | Virtual clock deadline reached |
| `until(() => condition)` | Predicate true in the boundary snapshot |
| `net.get(url)` | Typed service result delivered |
| `load()` | Started child task completed; cancellation cancels the awaiter |
| `join(load())` | Result is `done` with a value, or `cancelled` |
| `all([a, b])` | Every member completed; results retain member order |
| `any([a, b])` | First ready member; a boundary tie chooses the lower member |
| `animate(ref, property, value, options)` | Track ended, was replaced, or was dropped |

Import the task primitives from `@pocketjs/framework/solid/std` or
`@pocketjs/framework/vue-vapor/std`; import `net` from
`@pocketjs/framework/net/model`. Native `fetch`, `.then`, `try`, `catch` and
`setTimeout` are outside the subset.

Every wait has a `RequestId` containing the region instance, function, call
generation, wait generation and member number. Late deliveries cannot resume
a different call or mount. Service results include `unavailable`, `busy` and
`malformed` variants. The adapter validates a delivery against its result
contract before exposing it to the task.

Native hosts provide `Host::model_ready` and `Host::model_command`.
`Ready` contains the frame, virtual time, declared service modules and deliveries.
`Host::model_initial_ready` supplies capabilities and time for construction
without consuming deliveries or advancing the frame. Initial effects and mount
hooks finish before the first input dispatch.
`Ui::set_model_services` declares services implemented by a host command handler;
`Ui::queue_model_delivery` queues results for the next boundary. The default
`Ui` declares no services and reports `unavailable` for requests.
Core animation reports retain the track's ID and an `ended`, `replaced` or
`dropped` reason; node slots are cleared at unmount.
