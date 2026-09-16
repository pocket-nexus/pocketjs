# Pocket Vapor reference

**Pocket Vapor compiles Vue templates or Solid TSX and TypeScript contracts into Rust.**
This page covers the Vue form. See [Solid TSX to Rust](/docs/pocket-vapor-solid/)
for the Solid source subset.
Use [Getting started](/docs/pocket-vapor/) for the build workflow and
[Components](/docs/pocket-vapor-components/) for props, events, models,
slots, instance state, generics and shared context.
For the connection between template bindings and generated Rust methods,
read [How Vue becomes Rust](/docs/pocket-vapor/#how-vue-becomes-rust).

## Files and setup

An AOT component has one `<template>` and one `<script setup lang="ts">`.
Its view-model import uses the component's basename without an extension:
`Dial.vue` imports from `./Dial`. Other script blocks, `<style>` blocks and
custom SFC blocks are rejected.

| File | What you write |
|---|---|
| `Dial.vue` | Template, imports and component declarations |
| `Dial.ts` | Vue state and functions for browser or guest execution; exported types define the Rust contract |
| `Dial.d.ts` | Declarations for a Rust application; use this instead of `Dial.ts` |
| Rust source | Implement the generated view-model trait and connect the app to a host |

**A component cannot have both basename module forms.** A `.d.ts` browser
preview supplies default values, such as zero, empty strings and empty arrays;
it does not execute the Rust application logic.

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
view-model module. Import Vue APIs from `vue`. Setup does not accept local
runtime variables or statements beyond the factory, macros, context and PocketJS lifecycle forms.

## Host elements and input

Import these elements from `@pocketjs/framework/vue-vapor/components`.

| Element | Accepted attributes | Event |
|---|---|---|
| `View` | `class`, `:class`, `:style`, bare `focusable`, static `debug-name` | `@press` requires `focusable` |
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
| Slots | `<slot />`, named outlets and typed scoped slots; see [Components](/docs/pocket-vapor-components/) |

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

HTML elements, DOM events, directive modifiers, `v-html`, `v-once`, `v-memo`,
object `v-bind`, dynamic event names, template refs, dynamic components,
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

Import numeric types and units from `@pocketjs/framework/vue-vapor/std`.

| TypeScript contract | Rust getter or prop | Rust owned value |
|---|---|---|
| `string` | `&str` | `String` |
| `boolean` | `bool` | `bool` |
| `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `usize`, `f32`, `f64` | Same Rust type | Same Rust type |
| `number` | `f64`; rejected with `--strict` | `f64` |
| `Item[]`, `Array<Item>` | `&[Item]` | `Vec<Item>` |
| Interface or object type | `&Item` | Generated `Item` struct |
| `"idle" \| "ready"` | Generated enum | Same enum |
| `[A, B]` | Tuple with the getter form of each field | Tuple |
| `[T, T, T]` | `&[T; 3]` | `[T; 3]` |
| Optional property or `T \| undefined` | Optional form of the getter or prop | `Option<T>` |
| Discriminated object union | Reference to the generated enum | Enum variants with fields |
| `i32 & { readonly __newtype?: "ItemId" }` | Generated `ItemId` value | `ItemId(pub i32)` |

`Ref<T>`, `ShallowRef<T>` and `ComputedRef<T>` expose `T` in the contract.
Function arguments and returns, setter arguments and event payloads use owned values.
**String and array storage use `alloc`: `String` and `Vec<T>`.**

| Template use | Generated view-model method |
|---|---|
| Read `count: i32` | `fn count(&self) -> i32` |
| Read `title: string` | `fn title(&self) -> &str` |
| Assign to `count`, or bind it with `v-model` | Additional `fn set_count(&mut self, value: i32)` |
| Call `label(): string` in a binding | `fn label(&self) -> String` |
| Call `reset(): void` in handlers | `fn reset(&mut self)` |

A function used in both a binding and a handler receives `&self`. Bindings
can call a function on each view update. Expose a list through a value getter
when the template iterates it, to borrow its storage during rendering.

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

Unsupported data and view-model contract types include `null`, `any`, `unknown`, classes,
function-valued data, `Record`, `Map`, `Set`, index signatures and unresolved
type parameters. Use named object types, arrays, optional values and string
or discriminated unions. [Generic components](/docs/pocket-vapor-components/)
resolve their parameters from props or type defaults.
The `any` return placeholder in `defineSlots` is accepted; slot parameter
types determine the values passed to the parent template.

## Numeric rules and units

**Use an explicit numeric type for each exported contract value and signature.**
For example, `ref<i32>(0)` describes an integer counter and `ref<f32>(0)`
describes a floating-point value.

Arithmetic and comparisons require matching numeric types. Literals adopt
the expected type. For a host style property with `f32` storage, an integer
expression can widen to the property's type, as in the width example above.
Use `trunc`, `round`, `floor` or `ceil` to convert a float to `i32`.

| Unit | Use |
|---|---|
| `Px` | Dimensions, spacing, insets, radii, border widths and translations |
| `Deg` | Rotation and arc angles |
| `Color` | Color properties, such as `bgColor` and `textColor` |
| `Ms` | Duration values in application signatures |
| `f32` | Dimensionless values, such as opacity, scale, grow and shrink |

Literals adopt units: `width: 80` supplies pixels. A value with a different
unit is rejected. `Color` accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`.
**Color text uses lowercase `#rrggbbaa`, and equality compares color values.**
For example, `#f00` and `#ff0000` are equal when their contract type is `Color`.
Color has no arithmetic or ordering operations.

Rust `f32` uses single precision; browser and guest numbers use double
precision. Values and displayed digits can differ. Browser and guest `i64`
and `u64` lose integer precision above `2^53`. Avoid overflow when comparing
execution results: Rust integer arithmetic wraps, while JavaScript arithmetic
does not wrap at the declared integer width.

## Expressions and standard functions

Expressions support numeric arithmetic, `===`, `!==`, ordered numeric or
string comparisons, boolean `&&`, `||`, `!`, ternaries, field access, `??`
and optional object access. Conditions require booleans; there is no truthiness.

`items[index]` returns an optional value. Guard it or provide a fallback.
`value !== undefined` and discriminant checks such as `state.kind === 'ready'`
narrow values inside `v-if` branches. Use template strings for string
concatenation; `+` is numeric.

Text accepts scalars and optional scalars. An absent optional value in
`{{ value }}` renders empty text. Objects and arrays need a scalar field or a
view-model formatting function. Numbers use JavaScript's `String(n)` format.
Object and array equality is unsupported; compare scalar fields or keys.

Import these functions by name from `@pocketjs/framework/vue-vapor/std`:

| Function | Result and behavior |
|---|---|
| `len(value)` | `i32`; array elements or Unicode scalar values in a string |
| `trunc(x)`, `floor(x)`, `ceil(x)` | `i32`; truncate, round down or round up |
| `round(x)` | `i32`; halves round toward positive infinity, so `round(-2.5)` is `-2` |
| `idiv(a, b)`, `imod(a, b)` | Matching integer type; division truncates toward zero; a zero divisor yields zero |
| `min(a, b)`, `max(a, b)`, `abs(x)`, `clamp(x, lo, hi)` | Matching numeric type |
| `fixed(x, digits)` | `string`; JavaScript `toFixed` formatting for a float |

Float-to-`i32` conversions saturate at the `i32` limits; NaN becomes zero.
Integer `/` and `%` are rejected; use `idiv` and `imod`. Template expressions
cannot use `.length`, prototype methods, `Math.*`, global functions, closures,
bitwise operators or general object and array literals. Move that work into
the view model.

## Command-line reference

Run from the repository root:

```sh
bun vapor/compiler/cli.ts check vue-sfc-lab --strict
bun vapor/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml
```

The input can be an app name under `apps/`, an app directory or a root `.vue`
path. `check` analyzes the component tree without writing generated files.
`build` writes Rust and `styles.bin` to `gen/` beside the root SFC.

| Option | Effect |
|---|---|
| `--strict` | Reject unannotated `number` in contracts |
| `build --out <directory>` | Choose the generated output directory |
| `build --no-format` | Skip `rustfmt`; the default uses it when installed |
| `build --ir <file>` | Save the compiler's analyzed representation for debugging |
| `check --json` | Print analysis and requested board results as JSON |
| `check --boards` | Report input coverage for all existing board profiles |
| `--board <name>` | Require a board's input profile to cover the app; a build checks before writing output |

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
| Missing prop, slot parameter or context provider | Match the child's declarations; see [Components](/docs/pocket-vapor-components/) |
| Board has no relative-axis adapter | Use a host that implements the required axis capability, or change the app's input requirement |
| Rust view-model trait implementation is incomplete | Regenerate after contract changes, then implement the trait's required methods and associated child types |
