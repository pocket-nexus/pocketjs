# MicroTS reference

**MicroTS compiles Vue templates or Solid TSX and TypeScript contracts into Rust.**
This page covers the Vue form. See [Solid TSX to Rust](/docs/microts-solid/)
for the Solid source subset.
Use [Getting started](/docs/microts/) for the build workflow and
[Components](/docs/microts-components/) for props, events, models,
slots, instance state, generics and shared context.
For the connection between template bindings and generated Rust methods,
read [How Vue becomes Rust](/docs/microts/#how-vue-becomes-rust).
The [TypeScript support reference](/docs/typescript-support/) defines the
source subsets. The [model guide](/docs/microts-model/) explains execution
of compiled model bodies, and [TypeScript and native code](/docs/microts-boundaries/)
defines the model and host contracts.

**The supported source language is TypeScript.** JavaScript mentioned in
runtime or formatting rules is generated output or engine behavior. It does
not imply an AOT support contract for `.js` models or untyped view scripts.

## Files and setup

An AOT component has one `<template>` and one `<script setup lang="ts">`.
Its view-model import uses the component's basename without an extension:
`Dial.vue` imports from `./Dial`. Other script blocks, `<style>` blocks and
custom SFC blocks are rejected.

| File | What you write |
|---|---|
| `Dial.vue` | Template, imports and component declarations |
| `Dial.ts` | TypeScript state and functions; compiled mode translates their bodies, while Rust mode uses their types as the native contract |
| `Dial.d.ts` | Contract declarations for Rust mode; use this instead of `Dial.ts` |
| Rust source | Connect the app to a native host; in Rust mode, also implement the generated view-model trait |

**A component cannot have both basename module forms.** A `.d.ts` browser
preview supplies default values, such as zero, empty strings and empty arrays;
it does not execute the Rust application logic.

`app.model` defaults to `"rust"`. Set `app.aot: true` and
`app.model: "compiled"` to compile the `.ts` model. This selection applies to
the root model and child factories. Unsupported compiled model source is an
error; model selection does not change after admission fails.

`<script setup>` accepts these declarations:

| Form | Example |
|---|---|
| PocketJS host imports | `import { View, Text } from "@pocketjs/framework/vue-vapor/components"` |
| Child imports | `import Row from "./Row.vue"` |
| View-model imports | `import { count, increment } from "./Dial"` |
| Standard functions and types | `import { len, type i32 } from "@pocketjs/framework/vue-vapor/std"` |
| Types | `import type { Item } from "./types"`, `interface`, `type` |
| Component macros | `defineProps`, `withDefaults`, `defineEmits`, `defineModel`, `defineSlots` |
| Instance state | `const { count, increment } = createRow()` from the basename module |
| Shared context | `provide` and `inject`, imported from `vue` |

Put `ref`, `computed`, functions and other application logic in the `.ts`
view-model module. Import `ref` and `computed` from `vue`. In compiled models,
import `watch` and `watchEffect` from
`@pocketjs/framework/vue-vapor/reactive`. Setup does not accept local
runtime variables or statements beyond the factory, macros, context and PocketJS lifecycle forms.

## Host elements and input

Import these elements from `@pocketjs/framework/vue-vapor/components`.

| Element | Accepted attributes | Event |
|---|---|---|
| `View` | `class`, `:class`, `:style`, bare `focusable`, static `debug-name`, `:ref` to a model node slot | `@press` requires `focusable` |
| `Text` | `class`, `:class` | — |
| `Image` | `class`, `:class`, static `src` asset name | — |
| `ActionHandler` | Static `:button="BTN.NAME"`, boolean `active`, static `latched` | `@press` |
| `AxisHandler` | Static `axis="primary"` or `"secondary"`, boolean `active` | `@delta` |

Put text and interpolation inside `Text`. `Image` has no children. Register
image names with the Rust host's `Ui::register_image` before mounting views
that use them; the host loads font atlases.

For example, a dial exposes a count, a reset action and incremental motion:

```vue
<!-- Dial.vue -->
<script setup lang="ts">
import { ActionHandler, AxisHandler, Text, View }
  from "@pocketjs/framework/vue-vapor/components";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
import { count, resetCount, adjustCount } from "./Dial";
</script>

<template>
  <View class="flex-col gap-2 p-4">
    <ActionHandler :button="BTN.CROSS" :active="count !== 0"
      latched @press="resetCount()" />
    <AxisHandler axis="primary" @delta="adjustCount($event)" />
    <Text>{{ count }}</Text>
    <View focusable @press="resetCount()"><Text>Reset</Text></View>
  </View>
</template>
```

```ts
// Dial.d.ts — implement these methods in the Rust view model.
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
export declare const count: i32;
export declare function resetCount(): void;
export declare function adjustCount(delta: i32): void;
```

**Axis events carry signed `i32` millidegrees: `1000` means one degree.**
The app chooses sensitivity and retains any remainder between steps. An
`AxisHandler` consumes the hardware-neutral relative-axis channel; device
adapters translate physical motion into this channel.

Each axis handler receives one nonzero accumulated delta per frame. Deltas
for an axis sum with `i32` saturation. `active` gates delivery. A `latched`
button handler waits for a release before accepting a press. Action and axis
handlers run in document order.

Rust hosts provide motion through `Input::default().with_axis(0, delta)`;
axis `0` is primary and axis `1` is secondary. A host needs
the generated app's `HasButton<MASK>` and `HasRelativeAxis<ID>` implementations
for the inputs the template uses.

## Template lookup

| Feature | Accepted form and requirement |
|---|---|
| Conditional branches | `v-if`, `v-else-if`, `v-else`; conditions must be `boolean` |
| Visibility | `v-show="visible"` on a host element keeps its subtree mounted |
| Text | `{{ value }}` or `<Text v-text="value" />`; `v-text` allows no children |
| Lists | `v-for="item in items"` or `v-for="(item, index) in items"`; `items` must be an array |
| Keys | Every `v-for` needs `:key`; use `i32`, `i64`, `string` or a string-literal enum |
| Child props | `:title="title"`; expression types must match the child's declarations |
| Child models | `v-model="value"`, `v-model:name="value"` |
| Slots | `<slot />`, named outlets and typed scoped slots; see [Components](/docs/microts-components/) |

**List keys must be unique and stable for each item.** A keyed child keeps
its instance state when its row moves. An unmounted child loses that state.
The loop index has type `i32`.

A handler accepts `save()`, `save(id)`, `save($event)`, `count = value`,
`count += 1`, `count -= 1`, `count++`, `count--`, or `emit('saved', id)`.
Assignments target view-model values or `defineModel` bindings. Statement
sequences and `if` branches combine these operations:
`@press="if (count < 10) count++; resetAxis();"`. An emission ends the
handler or a branch of its final `if`; loops, local variables and early returns
are rejected. Arguments are evaluated once per statement. Owned payloads used
by several calls are cloned before the last use.

Roots and children with a model factory can register `onMounted` and
`onUnmounted` from `@pocketjs/framework/vue-vapor/lifecycle`. Each hook calls
a zero-argument model method. Cleanup runs in reverse creation order, then
mount hooks run in creation order. Hook writes trigger another update before
the frame renders.

Model node references use `createNodeRef` from `@pocketjs/framework/animation`
in the basename module and `<View :ref="target" />` in the template. The
reference binds to a native UI node and is cleared on unmount. It supplies
an animation target; it does not expose DOM methods or a device SDK handle.

HTML elements, DOM events, directive modifiers, `v-html`, `v-once`, `v-memo`,
object `v-bind`, dynamic event names, arbitrary Vue template refs, dynamic components,
`Teleport`, `Transition`, `KeepAlive` and `Suspense` are outside the accepted
template language. Use `transition-*` classes for style transitions.

### Classes and styles

Static `class` values use the [PocketJS styling classes](/docs/styling/).
**Dynamic classes select complete class strings with a ternary.** Nested
ternaries are accepted; class objects, arrays and string construction are not.
A prop typed `StyleClass`, imported from `@pocketjs/framework/vue-vapor/std`,
forwards a compiled style ID through `:class="props.tone"`. Pass a class literal,
a ternary of class literals, or an unchanged `StyleClass` prop. A static class
cannot accompany a style-prop binding.

```vue
<View class="p-4"
  :class="selected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'"
  :style="{ width: 80 + count * 12, opacity: 0.8 }" />
```

`:style` belongs on `View` and takes an object literal with fixed property
names. Use PocketJS names such as `width`, `paddingT`, `bgColor` and `rotate`.
Values must match the property's numeric type or unit below.

## Types and Rust methods

The shared [TypeScript support reference](/docs/typescript-support/#data-types-and-rust-values)
contains the type-to-Rust table, rejected data shapes, tuple restrictions,
generic component rules and capacity semantics. The same data mapping is used
by Solid and Vue contracts.

This section describes how a view's use of a binding determines its Rust
method. Function arguments, results, setters and event payloads use owned
values; rendering getters can borrow storage.

| Template use | Generated view-model method |
|---|---|
| Read `count: i32` | `fn count(&self) -> i32` |
| Read `title: string` | `fn title(&self) -> &str` |
| Assign to `count`, or bind it with `v-model` | Additional `fn set_count(&mut self, value: i32)` |
| Call `label(): string` in a binding | `fn label(&self) -> String` |
| Call `reset(): void` in handlers | `fn reset(&mut self)` |
| Start compiled `async load(): Promise<T>` in a handler | `fn load(&mut self, cmds: &mut Vec<Cmd>)` |

A function used in both a binding and a handler receives `&self`. Bindings
can call a function on each view update. Expose a list through a value getter
when the template iterates it, to borrow its storage during rendering.
In compiled mode, a function used in a binding must be synchronous and cannot
write state or emit host commands. Async calls start compiled tasks; their
source results go to awaiting tasks, while the public Rust method returns
`()`. A native Promise object does not cross the trait boundary.

An exported literal declaration such as `export declare const LIMIT: 20`
supplies a compile-time constant. A numeric constant adopts its use's expected
numeric type. A distinct identifier type can use the `__newtype` form above.
A homogeneous literal tuple such as
`export declare const FILTERS: readonly ["ALL", "ACTIVE", "DONE"]`
becomes a fixed native constant array. Literal indices and `len(FILTERS)` fold
at compile time; a variable index produces an optional value.
For `string | undefined`, the getter returns `Option<&str>` and stored values
use `Option<String>`.

An optional function such as `export declare const refresh: (() => void) |
undefined` has an empty default Rust method. A browser call does nothing
when the function is absent. Optional functions must return `void`.

Function-valued callbacks and slots are designated view contracts, not general
model data. See [functions and callbacks](/docs/typescript-support/#functions-and-callbacks)
for the distinction and the rules for model function signatures.

## Numeric rules and units

The [numeric rules](/docs/typescript-support/#numbers) define annotations,
literal inference, integer widths, floating precision, units, division and
formatting for each execution path. **View and model arithmetic have different
admission rules.** For example, integer `/` is rejected in a view binding;
model `/` promotes integer operands to `f64`. Use `idiv` for integer division.

A host style property can supply an expected unit or width. A numeric width
binding may widen to the property's `f32` storage type. A dimensionless `f32`
value cannot substitute for a different declared unit.

## Expressions and standard functions

The [view/model expression table](/docs/typescript-support/#view-and-model-expressions)
is the source-language reference. A Vue template binding uses the view column;
its basename `.ts` model uses the model column when `app.model` is `"compiled"`.
The [collection rules](/docs/typescript-support/#collections-and-indexing)
list the standard functions and explain the different array-index results.

In Vue bindings, `value !== undefined` and string discriminant checks narrow
values inside `v-if`. Text accepts scalars and optional scalars, with empty
text for an absent optional value. Read a scalar field or call a read-only
model method to format an object or array.

Object/array literals in model bodies do not make them general template
expressions. `:style`, prop values and other designated template forms retain
their own rules above. Move admitted business computation into the model;
that does not remove the model's own restrictions.

## Command-line reference

Run from the repository root:

```sh
bun microts/compiler/cli.ts check vue-sfc-lab --strict
bun microts/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml
```

The input can be an app name under `apps/`, an app directory or a root `.vue`
or `.tsx` path. `check` analyzes the component tree and any selected compiled
models without writing generated code. `build` writes view Rust and
`styles.bin` to `gen/` beside the root component; compiled mode adds model Rust
modules. Demo `gen/` directories are ignored by Git. Run `build` before Cargo.

| Option | Effect |
|---|---|
| `--strict` | Reject unannotated `number` in contracts |
| `build --out <directory>` | Choose the generated output directory |
| `build --no-format` | Skip `rustfmt`; the default uses it when installed |
| `build/check --ir <file>` | Save View IR; compiled mode also writes a sibling `.model.json` with Model IR |
| `check --json` | Print analysis and requested board results as JSON |
| `check --boards` | Report input coverage for all existing board profiles |
| `--board <name>` | Require a board's input profile to cover the app; a build checks before writing output |

`bun microts/compiler/cli.ts run <app> --tape <file>` executes the compiled model
with the reference tape player. It does not launch a native display host.
See the [model guide](/docs/microts-model/) for tape fields and explicit
view targets.

**Board reports cover input mappings.** They do not establish a target
toolchain or display integration. Existing profiles have no relative-axis
adapter; an `AxisHandler` produces a missing-adapter error for those profiles.
An AOT build generates application source assets; a device host's build
compiles and packages the application.

## Common diagnostics

| Diagnostic | Fix |
|---|---|
| Cannot resolve root component | Supply its `.vue` path or an app directory containing `app.vue`, `App.vue` or the configured entry |
| View-model import must use the SFC basename | For `Dial.vue`, use `./Dial` and keep one `Dial.ts` or `Dial.d.ts` |
| Unannotated `number`, or numeric type mismatch | Annotate the contract with `i32`, `f32` or another numeric type; convert floats before integer use |
| `:class` must be a ternary | Select complete class literals with `condition ? '...' : '...'` |
| `@press` requires a focusable View | Add bare `focusable`, or use `ActionHandler` for a named button |
| Invalid `v-for` source or key | Supply an array and a unique key with a supported type |
| Text interpolation requires a scalar | Select a field, call `len`, or expose a formatting method |
| Missing prop, slot parameter or context provider | Match the child's declarations; see [Components](/docs/microts-components/) |
| Board has no relative-axis adapter | Use a host that implements the required axis capability, or change the app's input requirement |
| Rust view-model trait implementation is incomplete | Regenerate after contract changes, then implement the trait's required methods and associated child types |
| Compiled model source is outside the supported subset | Change the TypeScript body according to the source diagnostic, or select Rust mode and provide its native implementation |
