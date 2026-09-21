# TypeScript models to Rust

**Model AOT compiles the basename TypeScript model into a Rust implementation
of the generated view-model trait.** Solid TSX and Vue views retain their
View IR boundary. **The supported application source is TypeScript.** Browser
and QuickJS builds lower that source into an engine bundle with the framework
reaction scheduler and task state machines. JavaScript is the bundle format.

The [TypeScript support reference](/docs/typescript-support/) defines the
compiled model syntax, its differences from view expressions, and current
implementation limits. This page describes the model execution rules.

The [TypeScript and native code guide](/docs/microts-boundaries/) explains
which code the compiler generates, which code a native host must supply, and
how values and service results pass between them.

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
**Model admission errors include a `file:line:column` location.** Follow the
frontend check with native compilation as described in the
[support reference](/docs/typescript-support/#checking-an-application).
A `.d.ts` contract uses the Rust model mode.
There is no fallback to a guest interpreter or a handwritten Rust method when
compiled admission fails. The manifest selects one native model implementation
for the application.

```sh
bun microts/compiler/cli.ts check solid-aot-lab --strict
bun microts/compiler/cli.ts build solid-aot-lab --strict
cargo check --manifest-path apps/solid-aot-lab/Cargo.toml
bun microts/compiler/cli.ts check solid-aot-lab --ir .pocket-build/model/view.json
bun microts/compiler/cli.ts run my-app --tape input.json
```

The build writes `gen/app_model.rs` beside the generated view modules.
`AppModel` implements `AppViewModel` and `Default`. Factory modules produce
one model type per factory, with constructor parameters for mount-time values.
The application's Rust entry creates `AppApp<AppModel, Host>` and supplies host
integration. **The demos' `gen/` directories are ignored by Git.** Run the
AOT build before compiling the demo with Cargo.

**View IR format 1 and Model IR format 1 are separate files.** `--ir view.json`
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

Use the [model import table](/docs/typescript-support/#model-modules-and-imports)
for API ownership and the [function rules](/docs/typescript-support/#functions-and-callbacks)
for signatures and admitted callbacks. Vue models use the same Model IR and
frame contract with their documented reactive forms.

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

The shared [numeric rules](/docs/typescript-support/#numbers) define literal
inference, fixed-width arithmetic and conversions. [Model statements](/docs/typescript-support/#model-statements)
define the admitted loops and assignments; [data types](/docs/typescript-support/#data-types-and-rust-values)
define capacity storage and overflow behavior. These source rules apply before
the model's reaction schedule is generated.

## Tasks and host services

**An async model function becomes a state machine whose segments run at frame
boundaries.** Starting a task executes its first segment in the caller's phase.
Starting the same function again cancels its prior call in that region. Earlier
writes and commands remain applied. Cancellation runs no later segment or
user cleanup code.

The generated public method takes a `&mut Vec<Cmd>` command sink and returns
`()`. A source `Promise<T>` result is delivered to a task awaiting that call.

The [task source reference](/docs/typescript-support/#async-tasks-and-host-services)
lists every admitted awaitable and its result, argument restrictions and API
imports. Native promises and arbitrary host calls do not become model tasks.

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
The `net.get` TypeScript contract does not install a network implementation in
a native AOT host. The host must advertise the service, handle its commands and
queue typed results. A board's network capability does not perform that setup.
Core animation reports retain the track's ID and an `ended`, `replaced` or
`dropped` reason; node slots are cleared at unmount.
