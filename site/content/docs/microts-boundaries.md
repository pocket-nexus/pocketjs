# TypeScript and native code

**PocketJS supports TypeScript application sources.** Solid views use `.tsx`;
Vue views use `.vue` with a TypeScript model or declaration module. The guest
build emits JavaScript for an execution engine. That output format does not
define a separate JavaScript application contract or promise compatibility
with every browser, Node.js API, or package.

MicroTS adds a Rust compilation path for supported views and models.
TypeScript describes application state, decisions and commands. The native
host supplies input, clocks, service adapters and presentation; the Rust UI
core owns layout, text and animation. The compiler checks the boundary between
these parts before generating code.

The [TypeScript support reference](/docs/typescript-support/) compares ordinary
applications, AOT views and compiled model bodies, with the supported types,
expressions, statements and APIs. This page describes ownership and execution
across the application, generated Rust and host.

## Choose where the model executes

The [execution-mode comparison](/docs/typescript-support/#execution-modes)
defines what each manifest setting checks and emits. Ordinary applications
execute an engine bundle. A native AOT application uses the generated view
with either a handwritten Rust model or a compiled TypeScript model.

**`"compiled"` requires a `.ts` implementation and has no fallback to a
handwritten model.** Admission errors identify the source location; the
[support reference](/docs/typescript-support/#current-implementation-limits)
also records combinations that require native compilation or cannot be replayed.
`"rust"` keeps the implementation decision with the
application: native code implements the generated trait, and guest behavior
comes from the TypeScript module. Declaration-only previews contain no
business implementation.

The Rust model and a running guest do not share signal storage. They are
implementations used in different execution paths. A native AOT application
does not call into a guest to evaluate an unsupported expression. Selecting
`"compiled"` also does not make the ordinary framework runtime an oracle for
the model: all execution paths follow the Model AOT frame semantics.

View AOT and Model AOT support the documented Solid and Vue forms. Octane's
guest adapter remains part of the ordinary framework build; it is not a Model
AOT frontend. The earlier [C cartridge compiler](https://github.com/pocket-stack/pocket-vapor)
lives in a separate repository with its own subset and target contracts;
its storage rules do not describe the Rust AOT runtime.

## Source and generated code

| Owner | Source | Responsibility |
|---|---|---|
| Application | `App.tsx` or `App.vue`, child views | Nodes, bindings, events, props, slots, context and mounting |
| Application | `App.ts` and factory `.ts` modules | Region state, derived values, effects, methods and tasks |
| Application | Pure `.ts` modules | Computation over parameters, with no model state or host access |
| Compiler | View IR format 1 | Typed view contract, structure, expressions and dispatch |
| Compiler | Model IR format 1 | Bound model bodies, dependencies, schedules and task states |
| Compiler | `gen/app.rs`, `gen/app_model.rs`, `gen/mod.rs`, `gen/styles.bin` | Rust view, compiled model and style output |
| Native integration | Rust entry and `Host` implementation | Core construction, input delivery, service execution and drawing |

The model and view analyses share TypeScript type information. Their IR files
remain separate: a serialized View IR can regenerate a view without loading
model bodies. The generated view consumes the same trait shape for a compiled
model and a handwritten model.

**The view-model trait is a Rust call boundary within the native program.**
It is not an FFI bridge that reflects over TypeScript objects at runtime.
For example, a signal exposed as `Accessor<i32>` becomes a typed getter;
a view write adds a setter. The compiler supplies those methods when the
model is compiled. The application supplies them in `"rust"` mode.

Rust getters used by rendering take `&self`. Memos also have an on-demand
entry point for dispatch-time reads, so a handler can read a value after an
earlier handler changed its inputs. Mutable methods, reactions and task
segments run before rendering reads the settled caches.

Demo `gen/` directories are ignored by Git. Regenerate them before Cargo:

```sh
bun microts/compiler/cli.ts build solid-aot-lab --strict
cargo check --locked --manifest-path apps/solid-aot-lab/Cargo.toml
```

The demo's `src/lib.rs` constructs `AppApp<AppModel, LabHost>`. It loads the
style table and passes input to `frame`; it contains no replacement
implementation of the compiled TypeScript business methods.

## The host boundary depends on the execution path

| Boundary | Guest or browser execution | Native AOT execution |
|---|---|---|
| Application state | Transformed TypeScript in the engine; framework-owned model schedule | Fields and methods of the generated Rust model |
| View operations | Framework renderer emits `HostOps` through `ui.*`; it maintains a mirror tree | Generated Rust view calls `microts::Ui` |
| Input | Host frame samples enter the framework input bridge | Host samples become `microts::Input` |
| Model service request | Framework task adapter calls the available host transport | A `Cmd::Request` reaches `Host::model_command` |
| Completion | Host polling queues a typed task delivery | Host queues a delivery for the next `Ready` snapshot |
| Layout and animation | Rust core, accessed through the host adapter | Rust core, called by the native application |

The [native op contract](/docs/native-contract/) describes the guest `HostOps`
surface. Native AOT uses Rust calls for its view and model. Both paths retain
the core's node, style, layout and animation contracts.

The application imports PocketJS host components, lifecycle, input and
animation APIs from `@pocketjs/framework/*`. Solid primitives and control flow
come from `solid-js`. A compiled model's `createMemo`, `createEffect` and `on`
come from the framework reactive module so every backend uses the model
schedule; the [model guide](/docs/microts-model/) lists the Vue forms.

## A task requests work; the host performs it

This compiled model requests a network response and publishes its result:

```ts
import { createSignal } from "solid-js";
import { net } from "@pocketjs/framework/net/model";

export const [status, setStatus] = createSignal("idle");

export async function load(): Promise<void> {
  setStatus("loading");
  const result = await net.get("https://example.org/status");
  if (result.kind === "ok") {
    setStatus(result.body);
  } else {
    setStatus(result.kind);
  }
}
```

The generated public Rust entry has the command-sink form
`fn load(&mut self, cmds: &mut Vec<Cmd>) -> ()`. Calling it runs segment zero
and records the request. A later segment runs when its wait is ready. A source
`Promise<T>` result is delivered to a task awaiting that call; it does not
become a Rust `Future` or require an async executor.

1. The model records a request with owned arguments and a `RequestId`.
2. After reaction, view update and lifecycle rounds, the command queue drains
   in emission order. The host or framework adapter submits the operation.
3. The host queues its completion. The next frame boundary freezes readiness
   for all task regions before any resumed segment runs.
4. The model adapter checks the delivery's identity and result shape. A valid
   current wait receives the value; a stale delivery cannot resume a restarted
   task or a different mount.

For native AOT, a service-capable host overrides `Host::model_command`,
advertises its service modules through `Ready.services`, and supplies
completions through `Ready.deliveries`. `Ui::set_model_services` and
`Ui::queue_model_delivery` support the default `Host::model_ready` path.
Advertising a service does not implement it. **The default `Ui` provides no
network transport and declares no model services.**

The current model service adapter exposes `net.get`. Its results distinguish
`ok`, `failed`, `unavailable`, `busy` and `malformed`. The guest adapter uses
the existing PocketJS network transport. A native host must implement the
request and cancellation path. Other framework SDKs are not admitted as
model awaitables by the presence of TypeScript declarations alone.

An imported API's TypeScript type, the compiler's admission rule and the
host's capability are separate checks. Passing the first two does not provide
a device driver, network stack, permission or transport.

## Frames, ownership and cancellation

**One boundary snapshot determines which tasks may resume in an instant.**
Ready segments run in region creation order and task start order. Input
dispatch follows, then reaction and memo settle, view updates, lifecycle
rounds and command drain. A write from one resumed segment cannot make another
task ready in the same snapshot. `Host::model_initial_ready` initializes
capabilities without consuming a delivery or advancing the frame.

The root module owns the application region. Each mounted factory instance
owns a child region. Props, events and context carry values between regions;
importing another model's mutable state is rejected. A child remount gets new
state and task identity. Unmounting a child cancels its tasks while root tasks
remain owned by the root.

Non-primitive signal reads are immutable views. `copy` creates an owned value
for mutation; values retained across `await` become owned snapshots. Node refs
are mount-owned slots, cleared on unmount. They are not device pointers.

Starting the same task function again cancels its previous call in that region.
Writes and commands from completed segments remain applied. Cancellation
prevents later segments and removes interest in their results; it cannot
roll back an external side effect. Cancelling an animation wait detaches its
completion listener and leaves the native track's motion intact.

## Limits that remain with the application and host

| Area | Contract |
|---|---|
| Source admission | The [TypeScript support rules](/docs/typescript-support/) apply to each AOT view and reachable compiled model module; ordinary applications have separate framework and host constraints |
| Arithmetic | The transforms normalize 8/16/32-bit integer operations and `f32` values; 64-bit integers retain the [guest precision limits](/docs/typescript-support/#numbers) |
| Memory | Rust AOT uses `no_std` with `alloc`; it does not promise an allocation-free application |
| Capacities | `Cap<string, N>` bounds UTF-8 bytes and `Cap<T[], N>` bounds elements; contained untagged values can still allocate |
| Recursion | Development builds enforce `app.recursionLimit`; that guard is omitted in release builds |
| Input | Generated trait bounds check declared channels; the host still maps physical hardware into `Input` and `RelativeAxis` |
| Board admission | `--board` checks the declared input profile; it does not establish a native port, rendering backend or device toolchain |
| Packaging | Native builds need the generated Rust, asset loading, a host and its target toolchain; guest `.pocket` packaging does not compile a Rust AOT binary |

Testing compares the reference interpreter, the transformed TypeScript model
and generated Rust on recorded frames, including state and commands. Selected
bounded fixtures verify zero allocations after mount; this result applies to
those fixtures. The Solid lab also runs under a 24 MiB allocation cap.
ESP32 compile/link validation establishes a build result; it does not establish
on-device latency, pixels or input behavior. Fuzz runs remain a local command.

See [TypeScript support](/docs/typescript-support/) for the language comparison,
[TypeScript models to Rust](/docs/microts-model/) for the model runtime,
[Solid TSX](/docs/microts-solid/) and [Vue views](/docs/microts/) for
view authoring, and [API and commands](/docs/microts-reference/) for
template syntax and compiler options.
