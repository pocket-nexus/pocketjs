# MicroTS components

Use components to pass data, handle actions, and keep state for each mounted
instance. Start with [MicroTS](/docs/microts/) for the app files,
Rust entry point, and build commands. The examples below use the
[`vue-sfc-lab` app](https://github.com/pocket-stack/pocketjs/tree/main/apps/vue-sfc-lab).

## Choose who owns the state

| State | Declare it in | Change it through |
|---|---|---|
| App data shared by rows | The root's basename module, such as `app.ts` | Root model methods and child events |
| State belonging to one mounted child | A factory in the child's basename module | The child's model methods |
| A value controlled by the parent | `defineProps` or `defineModel` in the child | An event or a model assignment |
| Read access across several component levels | Root `provide` and child `inject` | The root model's methods |

**TypeScript defines the component contract in both model modes.** With the
default `app.model: "rust"`, you implement the generated trait in Rust.
With `app.model: "compiled"` and `app.aot: true`, Model AOT generates the
implementation from `.ts` bodies. See the
[execution-mode comparison](/docs/typescript-support/#execution-modes) for
source admission and browser, QuickJS and native behavior.

The examples below show the Vue lab's handwritten Rust model. Component
props, events, slots and context keep the same view contract with compiled
models. See [TypeScript and native boundaries](/docs/microts-boundaries/)
for model ownership and [TypeScript support](/docs/typescript-support/)
for the view and model language rules.

## Pass props and emit events

`FeatureToggle.vue` declares its input data with `defineProps` and its output
with `defineEmits`. Event declarations use named tuples; `toggle: []` would
declare an event with no payload.

```vue
<!-- FeatureToggle.vue -->
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
import { createFeatureToggle } from "./FeatureToggle";

const { presses, press } = createFeatureToggle();
const props = defineProps<{ label: string; enabled: boolean }>();
const emit = defineEmits<{ toggle: [presses: i32] }>();
</script>

<template>
  <View focusable @press="emit('toggle', press())">
    <Text>{{ props.label }}: {{ props.enabled ? 'ON' : 'OFF' }}</Text>
    <Text>Pressed {{ presses }} times</Text>
  </View>
</template>
```

**Props are read-only inputs.** String, array, and object props borrow the
parent's Rust data during rendering. An emitted payload owns its data, so
the parent listener can mutate the model while handling the event.

In the parent template, pass values with `:prop` and handle an event with
`@event`. `$event` refers to the payload for a single-argument event. A
listener can read parent state, as the keyed-list example below does.

## Give each child its own state

Put the factory in `FeatureToggle.ts`, matching the component's basename.
This factory takes no arguments and returns the bindings destructured by the
SFC:

```ts
// FeatureToggle.ts
import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

export function createFeatureToggle() {
  const presses = ref<i32>(0);
  function press(): i32 {
    presses.value += 1;
    return presses.value;
  }
  return { presses, press };
}
```

In the default Rust mode, generate the app and implement
`FeatureToggleViewModel` in its Rust source:

```rust
use crate::generated::FeatureToggleViewModel;

#[derive(Default)]
pub struct ToggleState {
    presses: i32,
}

impl FeatureToggleViewModel for ToggleState {
    fn presses(&self) -> i32 {
        self.presses
    }

    fn press(&mut self) -> i32 {
        self.presses = self.presses.wrapping_add(1);
        self.presses
    }
}
```

Add `type FeatureToggle = ToggleState;` inside the parent's existing
`impl AppViewModel for LabViewModel`. The generated trait names the
associated type after the child component. See the
[complete Rust implementation](https://github.com/pocket-stack/pocketjs/blob/main/apps/vue-sfc-lab/src/lib.rs).

**Each child mount calls `ToggleState::default()` and owns that state until
unmount.** Two toggles have two press counts. A keyed row keeps its state
when its position changes. A `v-if` branch that disappears drops its state;
its next mount starts from `Default`. Put the child in a `View` with
`v-show` to retain the mounted subtree while hiding it.

**Compiled mode generates the child model and its constructor from the
factory.** The `presses` seed and `press` body above become Rust code. Each
mounted child owns a region containing its state, cached memos and tasks.
Unmount cancels that region's tasks and drops its state; a remount runs a new
constructor. No handwritten `ToggleState` implementation is required.

A factory can also take typed mount-time arguments, for example
`createRow(props.seed)` with `seed: i32`. The child snapshots these arguments
when it mounts. A later prop change does not reseed the same child; use the
prop binding for values that must track the parent. In Rust mode, a
parameterized child model implements `microts::New<(i32,)>`; compiled mode
generates that implementation from the TypeScript factory.

Use either a factory or direct view-model imports in one component. Put
`ref`, `computed`, and function bodies in the basename module; the SFC script
contains imports, type declarations, component macros, and the admitted
factory/context statements.

## Bind a parent value with v-model

Use `defineModel` when an interaction edits a value owned by the parent.
This button increments an `i32` and supplies a label when the parent omits it:

```vue
<!-- ModelButton.vue -->
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

const props = withDefaults(defineProps<{ label?: string }>(), {
  label: "VALUE +1",
});
const model = defineModel<i32>({ required: true });
</script>

<template>
  <View focusable @press="model++">
    <Text>{{ props.label }}: {{ model }}</Text>
  </View>
</template>
```

Import `ModelButton` and the root's `count` binding in `app.vue`, then use:

```vue
<ModelButton v-model="count" />
```

The generated root trait requires `count(&self) -> i32` and
`set_count(&mut self, value: i32)`. Rust mode requires both implementations;
compiled mode generates them from the root TypeScript state. The
child receives a `modelValue` prop; assigning it emits
`UpdateModelValue(i32)`, and the parent listener calls the setter.

For a named model, declare `defineModel<i32>("count", { required: true })`
and bind it with `v-model:count="count"`.

**Prop defaults must be string, number, boolean, or enum literals.** Arrays,
objects, and factory defaults are unsupported. A defaulted prop is present
inside the child; an optional prop without a default remains an `Option`
in Rust. Use a `v-if="props.value !== undefined"` guard before using its
inner value.

## Render a list without losing row state

Import `FeatureToggle` in the parent and iterate over the root's `features`
binding:

```vue
<FeatureToggle
  v-for="feature in features"
  :key="feature.id"
  :label="feature.label"
  :enabled="feature.enabled"
  @toggle="toggleFeature(feature.id)"
/>
```

The root's `features` getter returns `&[Feature]`; `toggleFeature` changes
the matching item. **Every `v-for` requires a unique key of type `i32`,
`i64`, `string`, or a string-literal enum.** Use an item's stable identifier
so moves preserve its child model. Removing a key unmounts its row; adding a
new key creates a row with fresh state. A loop index is available through
`v-for="(feature, index) in features"` and has type `i32`.

## Let the parent render list items

Use a scoped slot when a component owns the layout but callers supply the
item content. This list accepts any item type with a string `id`:

```vue
<!-- FeatureList.vue -->
<script setup lang="ts" generic="T extends { id: string }">
import { View } from "@pocketjs/framework/vue-vapor/components";

const props = defineProps<{ items: T[] }>();
defineSlots<{ row(props: { item: T }): any }>();
</script>

<template>
  <View class="flex-row gap-2">
    <template v-for="item in props.items" :key="item.id">
      <slot name="row" :item="item" />
    </template>
  </View>
</template>
```

The parent imports `FeatureList` and `FeatureToggle`, then supplies the
`row` slot. Destructuring can rename a parameter:

```vue
<FeatureList :items="features">
  <template #row="{ item: feature }">
    <FeatureToggle
      :label="feature.label"
      :enabled="feature.enabled"
      @toggle="toggleFeature(feature.id)"
    />
  </template>
</FeatureList>
```

**Slot expressions use the parent's scope plus the declared slot
parameters.** Here `feature` comes from the outlet and `toggleFeature`
comes from the parent. Use `<slot />` for default content and
`<slot name="footer" />` with `<template #footer>` for named content that
needs no parameters. See
[`FeatureCard.vue`](https://github.com/pocket-stack/pocketjs/blob/main/apps/vue-sfc-lab/FeatureCard.vue).

The compiler infers `T` from `items`, checks its `id` field, and generates a
Rust component for each distinct type argument list. Type parameter defaults
fill arguments that supplied props do not determine. The root component
cannot declare generic parameters because it has no parent supplying props.

A generic template cannot display or compare the same value as `Color` in
one use and another type in another use: browser template conversion is
shared across these uses. Split that rendering into components with a
concrete type for each operation.

## Read shared data across component levels

Export the context type and value from the root's basename module:

```ts
// Add to app.ts.
export interface LabTheme { enabledLabel: string }
export const theme = ref<LabTheme>({ enabledLabel: "ON" });
```

This addition uses the `ref` import from `vue` in the root module. Add the
provider in the root `app.vue` script:

```ts
import { provide } from "vue";
import { theme } from "./app";

provide("theme", theme);
```

In a child's SFC script, inject the same type and key:

```ts
import { inject } from "vue";
import type { LabTheme } from "./app";

const theme = inject<LabTheme>("theme")!;
```

The child can render `<Text>{{ theme.enabledLabel }}</Text>`. The native root
model stores a generated `LabTheme` and exposes it through
`fn theme(&self) -> &LabTheme`. Rust mode requires you to implement the getter;
compiled mode generates it from `theme` in `app.ts`.

**Providers belong to the root; every injection requires a matching literal
key and type.** The compiler passes borrowed data through intermediate
components, with no runtime key lookup. The `!` records the required value
for Vue's editor types; the AOT build checks the provider. Injection defaults,
symbol keys, and child providers are unsupported. Change shared data through
root methods; injection adds no child setter.

In a compiled model, another model's mutable state must cross the component
contract through props, events or context. Importing a sibling model's state
into the `.ts` body is rejected. Pure helper modules may export functions and
constants; their functions receive inputs as parameters and cannot read model
state or access the host.

See [TypeScript support](/docs/typescript-support/) for expression, type and
module rules, and the [MicroTS reference](/docs/microts-reference/)
for Vue template syntax, input handlers and diagnostics.
