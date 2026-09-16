# Solid TSX to Rust

**Pocket Vapor compiles a Solid TSX view and its TypeScript contract into Rust.**
The Solid and Vue front ends produce the same View IR. The Rust generator,
host input contract and `pocket_vapor` runtime consume that IR.

The browser and guest execute the TypeScript model with Solid. Native AOT
executes a Rust model implementing the generated trait. **TypeScript function
bodies are not translated to Rust.** Both model implementations must provide
the same state transitions.

## Build a view

The example in `apps/solid-aot-lab/` includes props, callbacks, named and scoped
slots, generic components, keyed rows, context and instance state.

```sh
bun vapor/compiler/cli.ts check solid-aot-lab --strict
bun vapor/compiler/cli.ts build solid-aot-lab --strict
cargo check --manifest-path apps/solid-aot-lab/Cargo.toml
bun tools/build.ts solid-aot-lab-main --no-config
```

`build` writes Rust modules and a style table under the app's `gen/` directory.
`check` accepts `--json` for the IR and `--board` for host capability admission.
A TSX native build requires the `build` or `check` subcommand; the bare TSX
command selects the retained cartridge compiler.

An app opts its browser and guest builds into admission with
`"app": { "framework": "solid", "aot": true }` in `pocket.json`. The checker
follows imports from the manifest entry before the transform cache is read.
Ordinary Solid apps retain their existing source subset.

## Files and ownership

`Counter.tsx` imports its model from `./Counter`. Use one `Counter.ts` or
`Counter.d.ts`, never both. Child view imports include the `.tsx` extension.
A declaration module supplies signal defaults for browser previews; these
mocks do not implement the Rust application's logic.

```ts
// Counter.ts
import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
export const [count, setCount] = createSignal<i32>(0);
```

```tsx
// Counter.tsx
import { Text, View } from "@pocketjs/framework/solid/components";
import { count, setCount } from "./Counter";

export default function Counter() {
  return (
    <View class="p-4 bg-slate-100" focusable
      onPress={() => setCount(count() + 1)}>
      <Text>{count()}</Text>
    </View>
  );
}
```

The native model implements `count(&self) -> i32` and
`set_count(&mut self, value: i32)`. **An `Accessor<T>` becomes a model getter;
a setter is generated when a view writes the signal.** A `Setter<T>` pairs
with the matching `Accessor<T>` by its `setName`/`name` naming convention and
value type. A plain function remains a method.

The component file contains imports, type declarations and one default-exported
function declaration. The body accepts prop defaults through `mergeProps`, a
zero-argument model factory, context reads, derived expressions, PocketJS
lifecycle hooks and one JSX return. State creation and application logic belong
to the basename module and the Rust model.

## Components and expressions

Import `Show`, `Switch`, `Match`, `mergeProps`, `createMemo` and `useContext`
from `solid-js`. Import host elements, keyed `For` and lifecycle hooks from
`@pocketjs/framework/solid/*`. Numeric types and built-ins use
`@pocketjs/framework/solid/std`; button constants use
`@pocketjs/framework/input`.

| Form | Behavior |
|---|---|
| `props.label` | Borrowed prop; prop destructuring is rejected |
| `onSaved: (id: i32) => void` | Required callback, named `saved` in the IR |
| `props.onSaved?.(value)` | Optional callback; arguments are skipped without a listener |
| `children?: JSX.Element` | Default slot, rendered with `props.children` |
| `badge?: JSX.Element` | Named slot, rendered with `props.badge` |
| `row: (props: { item: Accessor<T> }) => JSX.Element` | Scoped slot; pass the accessor and read it in the parent |
| `const { presses, press } = createRow()` | One model per mounted child instance |
| `const width = createMemo(() => count() * 12)` | Expression expanded at each read; no extra Rust getter |
| `<Show when={count() > 0}>` | Boolean branch; false unmounts its children |
| `<Switch><Match when={...}>` | Ordered boolean branches |

Derived expressions read signals, props and built-ins. They cannot call model
methods. JSX text uses Solid's line whitespace rules. Text expressions accept
numbers, strings, enums and their optional forms; render booleans through a
string ternary. Write literal Unicode characters instead of HTML entities.

**Keyed rows retain their model when an object is replaced under the same key.**
The item and index are accessors. Keys must be unique among siblings. The key
function reads its argument, constants and built-ins.

```tsx
<For each={items()} by={item => item.id}>
  {(item, index) => <Text>{index() + 1}. {item().label}</Text>}
</For>
```

A root context provider passes an accessor: `<ThemeContext.Provider
value={theme}>`. Children use `useContext(ThemeContext)!` and read `theme()`.
The provider wraps the complete root view; nested overrides are rejected.

Static `class` strings and ternaries with full class literal leaves become
style IDs. A `StyleClass` prop forwards a compiled class selection to a child.
`style` accepts an object of numeric host properties. The
[shared reference](/docs/pocket-vapor-reference/) defines numeric types,
units, built-ins and optional array indexing.

## Input and lifecycle

`ActionHandler` takes a static `button={BTN.CROSS}`, an optional boolean
`active` and bare `latched`. `AxisHandler` takes `axis="primary"` or
`axis="secondary"`; `onDelta` receives signed `i32` millidegrees through the
hardware-neutral relative-axis contract.

Handlers admit model calls, signal writes, callback emissions and blocks of
expression statements or `if` statements. An emission ends its handler or a
branch of its final `if`. Optional callback arguments run only when a listener
is present.

**One frame's input dispatch is one batch.** Handlers run in document order;
structural updates follow the dispatch. Before each row handler, the bridge
resolves its enclosing keys against the current data, skips a missing key and
freezes those row values for that handler. The next handler sees prior writes.

Use `onMount` and `onCleanup` from `@pocketjs/framework/solid/lifecycle` on roots
and children with a model factory. Each hook calls a zero-argument model method.
A child model that registers hooks must satisfy Rust's `'static` bound;
it can own its state or refer to static data.
After a structural update, cleanup runs in reverse creation order and mount
runs in creation order, in one batch. A round that ran hooks triggers another
update. Root disposal runs outstanding cleanup hooks without another frame.

Native code generation consumes **View IR format 3**. Older IR is rejected.
The shared format includes statement sequences, conditions, lifecycle hooks,
style props, optional callback emissions and literal array constants.
