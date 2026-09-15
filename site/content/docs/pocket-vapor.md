# Pocket Vapor

Pocket Vapor builds a native UI from a Vue single-file component and a Rust
view model. Write the layout and bindings in Vue; implement state and actions
in Rust. The template is compiled before the application runs: ahead-of-time
(AOT) compilation. **The generated view calls the Rust UI core without a JavaScript
engine.**

This guide uses a PocketJS source checkout. It takes you through an existing
example, a counter you can build, and a browser preview of its Vue
implementation.

| What you want to do | Where to start |
|---|---|
| Understand how a Vue template becomes native code | [How Vue becomes Rust](#how-vue-becomes-rust) |
| Build an example or create an application | [Build the supplied example](#1-build-the-supplied-example) |
| Pass props, add instance state, or use slots and context | [Components and state](/docs/pocket-vapor-components/) |
| Look up template syntax, input, types, or compiler flags | [API and commands](/docs/pocket-vapor-reference/) |

## How Vue becomes Rust

A template describes nodes, the values they display, and the actions that
change them. The compiler turns those declarations into Rust operations on
the UI tree:

```text
Counter.vue + types exported by Counter.ts
                 │  Pocket Vapor compiler
                 ▼
gen/counter.rs + gen/styles.bin
                 │  Cargo, with your Rust model and pocket_vapor
                 ▼
         Native application
```

At build time, Vue's template parser and Vapor transforms identify the
elements, bindings, conditions and loops. The TypeScript checker supplies
their types: `ref<i32>(0)` exposes an `i32` value named `count`. The compiler
checks the supported syntax and records a typed description of the view.
It converts that description into a Rust syntax tree and prints Rust source.
Cargo compiles the generated source together with your model and the runtime.

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

**Template expressions become Rust operations; application function bodies
remain your Rust implementation.** For `@press="increment()"`, the
compiler emits a call to `vm.increment()`. It does not translate the
`increment` body from `Counter.ts`. The same rule applies to a Vue
`computed` value: implement its calculation in the corresponding Rust getter.
The `0` in `ref<i32>(0)` initializes the Vue implementation; the native
initial value comes from the Rust model passed to `CounterApp::new`.

### What happens after a press

**The native view stores node IDs and previous binding values.** It runs
without Vue refs, effects or a JavaScript render function. When the host
calls `frame(input)`, generated Rust dispatches input to the model, then
updates the view if a handler ran or the app was invalidated. The first
frame performs the initial binding updates. In this counter, changing `count` from `0` to
`1` changes the existing text node to `Count: 1`; the button stays mounted.
The Rust core handles layout and produces the draw list for the host.

Generated files contain the node and block code for mounting, updating,
input dispatch and unmounting, including child components. **You maintain
the Vue source and the Rust model; the compiler maintains `gen/`.**

## 1. Build the supplied example

Install Bun and a Rust toolchain with Cargo. Run these commands from the
repository root:

```sh
bun install
bun vapor/compiler/cli.ts build vue-sfc-lab --strict
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

**The browser preview runs `app.ts`; the native application runs
`src/lib.rs`.** The template and types are shared. An edit to Rust business
logic needs a native build to exercise that behavior.

## 2. Create a counter

Create `apps/vapor-counter/` and its `src/` directory. The files below form
one application:

```text
apps/vapor-counter/
├── Counter.vue      layout and event bindings
├── Counter.ts       Vue state and the shared type contract
├── main.ts          browser/guest entry
├── Cargo.toml       Rust package
├── src/main.rs      Rust state and a frame-loop example
└── gen/             compiler output
```

### Write the template

`apps/vapor-counter/Counter.vue`:

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

`apps/vapor-counter/Counter.ts`:

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
bun vapor/compiler/cli.ts build apps/vapor-counter/Counter.vue --strict
```

This creates `gen/counter.rs`, `gen/mod.rs` and `gen/styles.bin`. The
`Counter.vue` name determines the generated `CounterViewModel`,
`CounterProps` and `CounterApp` types. Because the template assigns to
`count`, the view-model trait requires both `count()` and `set_count()`.

**Every file in `gen/` is generated.** Make changes in the template or state
contract and rerun the compiler. Keep the generated files in Git so native
builds can consume them through Cargo without running Bun.

### Implement the Rust state

`apps/vapor-counter/Cargo.toml`:

```toml
[package]
name = "pocket-vapor-counter"
version = "0.1.0"
edition = "2021"

[workspace]

[dependencies]
pocket_vapor = { path = "../../engine/crates/pocket-vapor" }

[profile.dev]
overflow-checks = false

[profile.release]
overflow-checks = false
```

The dependency path assumes this directory is under the checkout's `apps/`.
The application uses its own Cargo workspace. The overflow settings match
the AOT integer arithmetic contract.

`apps/vapor-counter/src/main.rs`:

```rust
#[path = "../gen/mod.rs"]
mod generated;

use generated::{CounterApp, CounterProps, CounterViewModel};
use pocket_vapor::{Input, Ui};

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
cargo run --manifest-path apps/vapor-counter/Cargo.toml
```

This executable creates the native UI, advances two frames and prints
`count = 1`. It has no window or display backend. The next section opens a
browser preview; a native host supplies the presentation described below.

**Rust implements the generated trait; TypeScript functions are not
translated into Rust.** Adding a state binding or action can add a required
trait method. Cargo reports the missing method until the Rust implementation
is updated.

## 3. Preview the counter in the browser

Use the `Counter.ts` form for the interactive preview. Add
`apps/vapor-counter/main.ts`:

```ts
import { mount } from "@pocketjs/framework/vue-vapor";
import Counter from "./Counter.vue";

mount(Counter);
```

```sh
bun tools/dev.ts vapor-counter-main --framework=vue-vapor --no-config
```

Open
[the counter at localhost:8130](http://127.0.0.1:8130/?demo=vapor-counter-main.vue-vapor).
After editing the Vue or TypeScript source, rebuild and reload the page:

```sh
bun tools/build.ts vapor-counter-main --framework=vue-vapor --no-config
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

**The AOT build command generates source and styles.** Packaging a native
application requires a host that builds `pocketjs-core` and `pocket_vapor`
for its target. `--board` checks an input profile; it does not build or flash
firmware. Runtime storage uses `alloc`. The retained C cartridge compiler
has its own workflow for GB, NES and GBA.

## Where to go next

- [Components and state](/docs/pocket-vapor-components/): child props,
  events, instance state, lists, slots, generics and context.
- [API and commands](/docs/pocket-vapor-reference/): supported syntax,
  types, input handlers, compiler flags and error fixes.
- [Styling](/docs/styling/): class utilities shared with PocketJS apps.
