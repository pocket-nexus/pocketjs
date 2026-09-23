# Solid TSX to Rust

**MicroTS compiles a Solid TSX view and its TypeScript contract into Rust.**
The Solid and Vue front ends produce the same View IR. The Rust generator,
host input contract and `microts` runtime consume that IR.

**The supported application source is TypeScript: `.tsx` views and `.ts`
models.** Browser and QuickJS builds execute JavaScript emitted from these
files. Native AOT executes a Rust model implementing the generated trait.
Setting `app.model` to `"compiled"` translates the admitted TypeScript model
subset into that implementation. The default `"rust"` mode uses the
application's handwritten Rust model; its `.ts` module supplies browser and
guest behavior, or `.d.ts` declarations supply preview defaults.

See [TypeScript support](/docs/typescript-support/) for the differences between
ordinary apps, view expressions and compiled model bodies,
[TypeScript models to Rust](/docs/microts-model/) for reaction scheduling
and tasks, and [TypeScript and native
boundaries](/docs/microts-boundaries/) for model ownership, generated
values and host integration. JavaScript is a build output and execution-engine
format, not an additional AOT source-language contract.

## Build a view

The example in `apps/solid-aot-lab/` includes props, callbacks, named and scoped
slots, generic components, keyed rows, context and instance state. It sets
`app.aot: true` and `app.model: "compiled"`: `app.ts` supplies model logic and
`src/lib.rs` connects the generated app to the native host.

```sh
bun microts/compiler/cli.ts check solid-aot-lab --strict
bun microts/compiler/cli.ts build solid-aot-lab --strict
cargo check --manifest-path apps/solid-aot-lab/Cargo.toml
bun tools/build.ts solid-aot-lab-main --no-config
```

`build` writes view modules, compiled model modules and a style table under
the app's `gen/` directory. **Demo `gen/` directories are ignored by Git;
generate them before running Cargo.**
`check` accepts `--json` for the IR and `--board` for host capability admission.
A TSX native build uses the `build` subcommand; `check` runs admission without
generating Rust. The earlier cartridge compiler is maintained in a
[separate repository](https://github.com/pocket-stack/pocket-vapor).

An app opts its browser and guest builds into admission with
`"app": { "framework": "solid", "aot": true }` in `pocket.json`. The checker
follows imports from the manifest entry before the transform cache is read.
Ordinary Solid apps use their framework and host contracts without the AOT
view and model checks; see [execution modes](/docs/typescript-support/#execution-modes). Add
`"model": "compiled"` to compile model bodies; without it, AOT checks the
view contract and leaves the native model implementation to Rust.

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

The generated trait requires `count(&self) -> i32` and
`set_count(&mut self, value: i32)`. Rust mode requires you to implement these
methods; compiled mode generates them from `Counter.ts` and uses its `0` seed.
**An `Accessor<T>` becomes a model getter;
a setter is generated when a view writes the signal.** A `Setter<T>` pairs
with the matching `Accessor<T>` by its `setName`/`name` naming convention and
value type. A plain function remains a method.

**These component-body rules apply to the `.tsx` view.** The component file
contains imports, type declarations and one default-exported
function declaration. The body accepts prop defaults through `mergeProps`, a
model factory with mount-time arguments, context reads, derived expressions, PocketJS
lifecycle hooks and one JSX return. State creation and application logic belong
to the basename TypeScript module. Rust mode also requires a native model
implementation. Compiled models must pass admission and native compilation;
the [current limits](/docs/typescript-support/#current-implementation-limits)
identify forms for which a frontend check alone is insufficient.

## Components and expressions

Import `Show`, `Switch`, `Match`, `mergeProps`, `createMemo` and `useContext`
from `solid-js`. Import host elements, keyed `For` and lifecycle hooks from
`@pocketjs/framework/solid/*`. Numeric types and built-ins use
`@pocketjs/framework/solid/std`; button constants use
`@pocketjs/framework/input`.

**A view-local `createMemo` and a model memo have different compilation rules.**
A view-local memo from `solid-js` defines an expression expanded at each read.
In a compiled `.ts` model, import `createMemo`, `createEffect` and `on` from
`@pocketjs/framework/solid/reactive`; these participate in the compiled reaction
schedule and memo cache. The model checker rejects those primitives imported
from `solid-js`.

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

View-local derived expressions read signals, props and built-ins. They cannot
call model methods. Compiled model functions and memos have the separate
[model expression rules](/docs/typescript-support/#view-and-model-expressions).
JSX text uses Solid's line whitespace rules. Text expressions accept
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
`style` accepts an object of numeric host properties. See
[TypeScript support](/docs/typescript-support/#numbers) for numeric types,
units and arithmetic, and the [expression comparison](/docs/typescript-support/#view-and-model-expressions)
for built-ins and optional array indexing.

## Input and lifecycle

`ActionHandler` takes a static `button={BTN.CROSS}`, an optional boolean
`active` and bare `latched`. `AxisHandler` takes `axis="primary"` or
`axis="secondary"`; `onDelta` receives signed `i32` millidegrees through the
hardware-neutral relative-axis contract. `MotionHandler` takes a static
`value` and optional `minQuality`; `onUpdate` receives the fused motion
payload described in the [reference](/docs/microts-reference/#motion-state).
A bare model function may declare a prefix of the payload parameters.

View handlers admit model calls, signal writes, callback emissions and blocks of
expression statements or `if` statements. An emission ends its handler or a
branch of its final `if`. Optional callback arguments run only when a listener
is present. These handler-body rules do not restrict the
[statements in compiled model functions](/docs/typescript-support/#model-statements).

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

With a compiled model, each frame first resumes ready tasks from the host's
readiness snapshot, then dispatches input, runs reactions and settles memos.
View updates and lifecycle rounds follow. Host commands drain after those
rounds; asynchronous host results are delivered at a later frame boundary.
Unmounting a factory cancels its tasks and clears its node references. A model
reference created by `createNodeRef` from `@pocketjs/framework/animation` can
bind to `<View ref={target} />`; it names a host node for animation and does
not expose a DOM element or a device SDK handle.

Native code generation consumes **View IR format 1**. Other versions are rejected.
The shared format includes statement sequences, conditions, lifecycle hooks,
style props, optional callback emissions and literal array constants.
