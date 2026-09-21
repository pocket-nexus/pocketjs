# MicroTS

MicroTS compiles Vue single-file components or Solid TSX views into Rust.
State and actions come from a handwritten Rust model or a TypeScript model
compiled into Rust. **The native AOT application executes its view and model
without a JavaScript engine.**

The Vue frontend uses Vue Vapor, Vue's upstream compilation mode. PocketJS
exposes its Vue adapters through `@pocketjs/framework/vue-vapor/*`.

**The application source-language contract is TypeScript.** Vue scripts use
`lang="ts"`, Solid views use `.tsx`, and model modules use `.ts`. Browser and
QuickJS builds execute JavaScript emitted from that source. The emitted
language does not extend AOT admission to arbitrary JavaScript source.

This guide uses a PocketJS source checkout. It takes you through an existing
example, a counter you can build, and a browser preview of its Vue
implementation.

| What you want to do | Where to start |
|---|---|
| Understand how a Vue template becomes native code | [How Vue becomes Rust](#how-vue-becomes-rust) |
| Compare ordinary TypeScript apps, AOT views and compiled models | [TypeScript support](/docs/typescript-support/) |
| Compile TypeScript state, reactions and tasks | [TypeScript models to Rust](/docs/microts-model/) |
| Understand which code runs in TypeScript builds, Rust and the host | [TypeScript and native boundaries](/docs/microts-boundaries/) |
| Use Solid TSX | [Solid TSX to Rust](/docs/microts-solid/) |
| Build an example or create an application | [Build the supplied example](#1-build-the-supplied-example) |
| Pass props, add instance state, or use slots and context | [Components and state](/docs/microts-components/) |
| Look up template syntax, input or compiler flags | [API and commands](/docs/microts-reference/) |

## How Vue becomes Rust

The `app.model` setting in `pocket.json` chooses the model implementation.
The default `"rust"` mode uses a handwritten Rust model. With `app.aot: true`,
`"compiled"` generates that model from its `.ts` implementation. The
[execution-mode comparison](/docs/typescript-support/#execution-modes) describes
the source checks and browser, QuickJS and native behavior for each setting.

**Compiled mode requires model bodies in `.ts`.** Admission failures do not
fall back to the Rust mode or interpret the rejected body on a native target.
[TypeScript support](/docs/typescript-support/)
defines the view and model subsets; the [model guide](/docs/microts-model/)
describes state, reactions and tasks. The counter below demonstrates the
default Rust mode.

A template describes nodes, the values they display, and the actions that
change them. The compiler turns those declarations into Rust operations on
the UI tree:

```text
Counter.vue + types exported by Counter.ts
                 │  MicroTS compiler
                 ▼
gen/counter.rs + gen/styles.bin
                 │  Cargo, with your Rust model and microts
                 ▼
         Native application
```

At build time, Vue's template parser and Vapor transforms identify the
elements, bindings, conditions and loops. The TypeScript checker supplies
their types: `ref<i32>(0)` exposes an `i32` value named `count`. The compiler
checks the supported syntax and records a typed description of the view.
It converts that description into a Rust syntax tree and prints Rust source.
Cargo compiles the generated source together with the selected model and the
runtime. In compiled mode, a separate Model IR records state and function
bodies; its Rust output implements the same view-model trait.

### Follow one binding

The counter in this guide contains these bindings:

```vue
<Text>Count: {{ count }}</Text>
<View focusable @press="count++"><Text>ADD ONE</Text></View>
```

The imported `count` type and its use determine the generated interface:

```rust
pub trait CounterViewModel {
    fn count(&self) -> i32;
    fn set_count(&mut self, value: i32);
}
```

A Rust trait lists the methods your model must implement. The generated
view uses those methods to read or change application data:

| Template | Generated Rust behavior |
|---|---|
| `<View>` and `<Text>` | Create nodes with `ui.create_node(...)` and attach them with `ui.insert_before(...)` |
| `class="p-4 ..."` | Use a compiled style table entry through `ui.set_style(...)` |
| `{{ count }}` | Read `vm.count()`; format the text when the value changes and send changed text through `ui.set_text(...)` |
| `@press="count++"` | On a matching press, call `vm.set_count(vm.count().wrapping_add(1i32))` |
| `v-if` and `v-for` | Choose mounted branches and reconcile list rows by key |

**The generated view calls the selected model through a Rust trait.** For
`@press="increment()"`, the view emits `vm.increment()`. In Rust mode, you
implement that method and each `computed` getter; the native initial value
comes from the model passed to `CounterApp::new`. In compiled mode, Model AOT
translates `increment`, state seeds and computed values from `Counter.ts`.
The view compiler does not need the model's function bodies to emit the call.

### What happens after a press

**The native view stores node IDs and previous binding values.** It runs
without Vue refs, effects or a JavaScript render function. When the host
calls `frame(input)`, generated Rust dispatches input to the model, then
updates the view if a handler ran or the app was invalidated. In the default
Rust mode, the first frame performs the initial binding updates. Compiled mode
finishes initial reactions and mount hooks during construction, before the
first input dispatch. In this counter, changing `count` from `0` to
`1` changes the existing text node to `Count: 1`; the button stays mounted.
The Rust core handles layout and produces the draw list for the host.

Generated files contain the node and block code for mounting, updating,
input dispatch and unmounting, including child components. **You maintain
the TypeScript source and any handwritten Rust model or host code; the compiler
maintains `gen/`.**

## 1. Build the supplied example

Install Bun and a Rust toolchain with Cargo. Run these commands from the
repository root:

```sh
bun install
bun microts/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml
```

The first build reads the lab's Vue components and TypeScript declarations,
then writes `apps/vue-sfc-lab/gen/`. Cargo compiles that output together with
the application's Rust implementation.

**`cargo check` checks native compilation; it does not open a window.** To
view the lab through the browser host, install the Rust WebAssembly target
and start the Vue development build:

```sh
rustup target add wasm32-unknown-unknown
bun tools/dev.ts vue-sfc-lab-main --framework=vue-vapor --no-config
```

Open
[the lab at localhost:8130](http://127.0.0.1:8130/?demo=vue-sfc-lab-main.vue-vapor).
Use the directional controls to focus a button and the confirm control to
activate it.

**The Vue lab uses the default Rust model mode.** Its browser preview executes
the output of `app.ts`; its native model lives in `src/lib.rs`. The template
and types are shared. An edit to the Rust business logic needs a native build
to exercise that behavior. The [Solid lab](/docs/microts-solid/) uses
compiled mode, with TypeScript model bodies shared across both build paths.

## 2. Create a counter

Create `apps/microts-counter/` and its `src/` directory. The files below form
one application:

```text
apps/microts-counter/
├── Counter.vue      layout and event bindings
├── Counter.ts       Vue state and the shared type contract
├── main.ts          browser/guest entry
├── Cargo.toml       Rust package
├── src/main.rs      Rust state and a frame-loop example
└── gen/             compiler output
```

### Write the template

`apps/microts-counter/Counter.vue`:

```vue
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { count } from "./Counter";
</script>

<template>
  <View class="w-full h-full flex-col gap-4 p-4 bg-slate-50">
    <Text class="text-lg text-slate-950">Count: {{ count }}</Text>
    <View class="p-2 rounded-lg bg-blue-600 focus:bg-blue-500"
          focusable @press="count++">
      <Text class="text-white">ADD ONE</Text>
    </View>
  </View>
</template>
```

### Declare the state

`apps/microts-counter/Counter.ts`:

```ts
import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

export const count = ref<i32>(0);
```

**The state module has the same basename as its component.** `Counter.vue`
imports `./Counter`; `ref<i32>` tells the AOT compiler that `count` is a Rust
`i32`. Put Vue state and business functions in this module. The component's
`<script setup>` contains imports and the supported component declarations.

For a Rust-only application, use `Counter.d.ts` in place of `Counter.ts`:

```ts
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
export declare const count: i32;
```

Choose one module form. A declaration-only browser preview starts with
generated default values and no-op functions; it does not run your Rust
business logic.

### Generate the Rust view

```sh
bun microts/compiler/cli.ts build apps/microts-counter/Counter.vue --strict
```

This creates `gen/counter.rs`, `gen/mod.rs` and `gen/styles.bin`. The
`Counter.vue` name determines the generated `CounterViewModel`,
`CounterProps` and `CounterApp` types. Because the template assigns to
`count`, the view-model trait requires both `count()` and `set_count()`.

**Every file in `gen/` is generated.** Make changes in the template or state
contract and rerun the compiler. The demos' `gen/` directories are ignored by
Git; run the AOT build before compiling them with Cargo.

### Implement the Rust state

`apps/microts-counter/Cargo.toml`:

```toml
[package]
name = "microts-counter"
version = "0.1.0"
edition = "2021"

[workspace]

[dependencies]
microts = { path = "../../engine/crates/microts" }

[profile.dev]
overflow-checks = false

[profile.release]
overflow-checks = false
```

The dependency path assumes this directory is under the checkout's `apps/`.
The application uses its own Cargo workspace. The overflow settings match
the AOT integer arithmetic contract.

`apps/microts-counter/src/main.rs`:

```rust
#[path = "../gen/mod.rs"]
mod generated;

use generated::{CounterApp, CounterProps, CounterViewModel};
use microts::{Input, Ui};

#[derive(Default)]
struct Model {
    count: i32,
}

impl CounterViewModel for Model {
    fn count(&self) -> i32 { self.count }
    fn set_count(&mut self, value: i32) { self.count = value; }
}

fn main() {
    let mut ui = Ui::new();
    assert!(ui.load_styles(include_bytes!("../gen/styles.bin")));
    ui.core_mut().set_viewport(480.0, 272.0);

    let mut app = CounterApp::new(ui, CounterProps {}, Model::default());
    app.frame(&Input::default());

    app.model.count = 1;
    app.invalidate();
    app.frame(&Input::default());
    println!("count = {}", app.model.count);
}
```

```sh
cargo run --manifest-path apps/microts-counter/Cargo.toml
```

This executable creates the native UI, advances two frames and prints
`count = 1`. It has no window or display backend. The next section opens a
browser preview; a native host supplies the presentation described below.

**This counter uses the default Rust model mode.** Adding a state binding or
action can add a required trait method. Cargo reports the missing method
until the Rust implementation is updated. To generate the implementation
from `Counter.ts`, opt into compiled mode and follow the
[model guide](/docs/microts-model/).

## 3. Preview the counter in the browser

Use the `Counter.ts` form for the interactive preview. Add
`apps/microts-counter/main.ts`:

```ts
import { mount } from "@pocketjs/framework/vue-vapor";
import Counter from "./Counter.vue";

mount(Counter);
```

```sh
bun tools/dev.ts microts-counter-main --framework=vue-vapor --no-config
```

Open
[the counter at localhost:8130](http://127.0.0.1:8130/?demo=microts-counter-main.vue-vapor).
After editing the Vue or TypeScript source, rebuild and reload the page:

```sh
bun tools/build.ts microts-counter-main --framework=vue-vapor --no-config
```

Regenerate the Rust files after changing the template or contract, then run
Cargo again. Changes confined to `src/main.rs` need a Cargo build.

## 4. Connect a native host

The host owns input sampling, fonts, image resources and presentation.
To embed the generated application:

1. Create a `Ui`, set its viewport, load `gen/styles.bin`, and load the font
   atlases and image resources your screen uses.
2. Construct `CounterApp` with that UI, its root props and your model.
3. Call `app.frame(&input)` once per tick with a hardware-neutral `Input`.
   The generated frame handles input, updates bindings and ticks the core.
4. Render the core's draw list through the host's existing backend. The
   core is available through `app.ui_mut().core_mut()`.
5. Call `app.invalidate()` after the host changes model data between frames.
   Input handlers schedule their own update. Call `set_props()` to replace
   root props, and `unmount()` to release the view and recover the `Ui`.

Start from the lab's
[Rust application wrapper](https://github.com/pocket-stack/pocketjs/blob/main/apps/vue-sfc-lab/src/lib.rs)
when your host needs button or relative-axis capability bounds.

In compiled mode, the host also supplies a readiness snapshot at each frame
boundary and handles emitted commands through `Host::model_ready` and
`Host::model_command`. TypeScript model code uses typed service and animation
APIs; Rust host code owns device SDK calls, service delivery and presentation.
See [TypeScript and native boundaries](/docs/microts-boundaries/) for
the value, scheduling and service contracts.

**The AOT build command generates source and styles.** Packaging a native
application requires a host that builds `pocketjs-core` and `microts`
for its target. `--board` checks an input profile; it does not build or flash
firmware. Runtime storage uses `alloc`. The earlier
[C cartridge compiler](https://github.com/pocket-stack/pocket-vapor) has its
own repository and workflow for GB, NES and GBA.

## Where to go next

- [Components and state](/docs/microts-components/): child props,
  events, instance state, lists, slots, generics and context.
- [TypeScript support](/docs/typescript-support/): execution modes, types,
  expressions, functions and the differences between view and model code.
- [API and commands](/docs/microts-reference/): Vue template syntax,
  input handlers, compiler flags and error fixes.
- [TypeScript and native boundaries](/docs/microts-boundaries/): model
  selection, generated traits, host commands and cross-backend guarantees.
- [Styling](/docs/styling/): class utilities shared with PocketJS apps.
