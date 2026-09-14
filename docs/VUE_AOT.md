# Vue AOT: v1 boundaries and contracts

**Status: decided on 2026-09-14; nothing is implemented.** This page pins what
the compiler accepts, what it generates, and where generated Rust ends and
application Rust begins. It is the contract for the rewrite of the AOT path on
branch `vue-aot`. For Rust targets it replaces the Pocket Vapor design in
`vapor/DESIGN.md`; the C pipeline under `vapor/` stays in the tree until the
Rust pipeline renders `apps/vue-sfc-lab` with the same features.

Items marked **open** are not decided. Everything else is fixed for v1;
changing it means editing this page first.

## 1. Input, output, execution classes

**Input is a Vue single-file component: one `<template>` and one
`<script setup lang="ts">`.** The script block may contain the statements in
the table below and nothing else. Any statement that produces a runtime value
is a compile error with a `file:line` diagnostic.

| Allowed in `<script setup>` | Purpose |
|---|---|
| `import { View, Text, Image } from "@pocketjs/framework/vue-vapor/components"` | host primitives (§4) |
| `import Row from "./Row.vue"` | child components |
| `import type { Todo } from "./todo"` | types from any module |
| `import { count, toggle } from "./todo"` | the logic module (§2) |
| `import { len, trunc, type i32 } from "@pocketjs/framework/aot"` | built-ins and numeric types (§3, §5); the path is open |
| `interface`, `type` | shapes used by the contract |
| `const props = defineProps<T>()`, `const emit = defineEmits<T>()`, `const model = defineModel<T>()` | component interface (§2); Vue's compile-time macros |

**Output is Rust source.** The generated module links `pocketjs-core` and
calls `Ui` methods (`create_node`, `insert_before`, `set_style`, `set_prop`,
`set_text`, `set_focus`) on node ids it owns. The product contains no
JavaScript engine, no `ui.*` op encoding and no mirror tree.

**One SFC runs in three execution classes.**

| Class | Logic implementation | Pipeline | Status |
|---|---|---|---|
| Browser | `todo.ts` on stock Vue Vapor | `framework/compiler/vue-sfc-compile.ts`, unchanged | exists |
| QuickJS guest on device | the same `todo.ts` | the guest build, unchanged | exists |
| Rust AOT | a Rust type implementing the generated trait | the compiler this page specifies | new |

**TypeScript logic is never translated to Rust.** The two implementations
satisfy one contract, and neither is an oracle for the other. Translating
application TypeScript to native code is the path this design retires.

**Targets are the hosts that compile `pocketjs-core` for their target
triple**: PSP, Vita, 3DS, ESP-IDF (P4 and S3), Symbian, QNX, PocketBook,
desktop and browser. GB, NES and GBA cartridges have no `pocketjs-core` build
and are out of scope.

## 2. The logic module

The SFC imports the values and functions its template uses from a module with
the same basename, without an extension:

```ts
import { count, todos, filter, remaining, toggle, save } from "./todo";
```

The module takes one of two forms; a component has exactly one of them, and
the import does not change when a project moves from one form to the other.
TypeScript resolves `./todo` to `todo.ts` before `todo.d.ts`, so the compiler
rejects a component that has both.

| Form | Content | Used by |
|---|---|---|
| `todo.ts` | `ref`, `computed` and functions: a Vue implementation | browser and guest classes; its exported types are also the contract for the Rust class |
| `todo.d.ts` | `export declare const count: i32;` and friends: declarations | Rust-only projects |

**The contract is the TypeScript type of each imported binding**, read
through the TypeScript checker. `Ref<T>`, `ShallowRef<T>` and
`ComputedRef<T>` unwrap to `T`. A binding with a call signature is a
function; every other binding is a value. Measured with TypeScript 5.9.3 and
`@vue/compiler-sfc` 3.6.0-rc.1: stock Vue compiles the import form with no
plugin (every import is a `setup-maybe-ref` binding), and vue-tsc 3.3.11
type-checks template expressions against both module forms.

### Rust shape

The compiler generates one trait per root component, `<Name>Logic`. The
application supplies the type that implements it and owns all state; the
generated view is generic over that type and stores nothing but node ids and
memoized binding values.

| Binding | Generated |
|---|---|
| value `x: T` | `fn x(&self) -> T'` |
| value assigned in a handler (`x = …`, `x++`) or bound through `v-model` | additionally `fn set_x(&mut self, v: T)` |
| function referenced in a binding expression | `fn f(&self, args…) -> R` |
| function referenced in event handlers only | `fn f(&mut self, args…) -> R` |

`T'` is `T` for numbers, `bool`, enums and `Option` of those; `&str` for
`string`; `&[T]` for arrays; `&T` for object types. A function's return type
is owned: `String` for `string`, `Vec<T>` for arrays, `T` for object types.
The call runs on every frame that evaluates the binding, so a list the
template iterates belongs in a value, not in a function. A function
referenced in both positions gets `&self`: binding expressions do not mutate.

**Only the root component imports a logic module in v1.** Child components
are pure: props, emits, model and slots. Stateful child components are open
(§9).

### Component interface

| Declaration | Generated |
|---|---|
| `defineProps<{ title: string; max?: i32; todo: Todo }>()` | `pub struct <Name>Props<'a> { pub title: &'a str, pub max: Option<i32>, pub todo: &'a Todo }` |
| `defineEmits<{ saved: [id: i32] }>()` | `pub enum <Name>Event { Saved(i32) }` |
| `defineModel<T>()` | prop `model_value: T` plus event `UpdateModelValue(T)`; `defineModel<T>("name")` uses that name |
| `<slot />`, `<slot name="footer" />` | one slot parameter per slot; slot content compiles in the parent's scope |

**Props borrow.** The parent rebuilds a child's props from its own getters on
every frame; `string`, arrays and object types arrive as `&'a str`, `&'a [T]`
and `&'a T`, and the child memoizes what it renders, so passing props
allocates nothing. Event payloads are owned.

`defineEmits` accepts the tuple form only. Scoped slots (slot props) and
`withDefaults` are open (§9).

## 3. Types

| TypeScript | Rust |
|---|---|
| `string` | `&str` from getters and in props; `String` from functions, in event payloads and wherever the application stores it |
| `boolean` | `bool` |
| `number` | `f64` |
| `i8` … `f64` (§3.1) | the Rust type of the same name |
| union of string literals `"all" \| "done"` | `enum` with unit variants `All`, `Done`; the literal is the display form |
| `interface` / object type | `struct` with `#[derive(Clone, Debug, PartialEq)]`, fields in declaration order; `&T` from getters and in props |
| `T[]`, `Array<T>` | `&[T]` from getters and in props; `Vec<T>` from functions |
| `[A, B]` | `(A, B)` |
| `x?: T`, `T \| undefined` | `Option<T>` |
| function type | trait method (§2); not a value |

Rejected in contract positions: `null`, `any`, `unknown`, `never`, `object`,
`symbol`, `bigint`, `Function`, classes, generic parameters, mapped,
conditional and template-literal types, index signatures, `Record`, `Map`,
`Set`, unions other than string literals and `| undefined`, and
intersections other than the numeric tags below.

### 3.1 Numeric types

The types module exports one alias per Rust numeric type:

```ts
export type i8    = number & { readonly __type?: "i8" };
export type i16   = number & { readonly __type?: "i16" };
export type i32   = number & { readonly __type?: "i32" };
export type i64   = number & { readonly __type?: "i64" };
export type u8    = number & { readonly __type?: "u8" };
export type u16   = number & { readonly __type?: "u16" };
export type u32   = number & { readonly __type?: "u32" };
export type u64   = number & { readonly __type?: "u64" };
export type usize = number & { readonly __type?: "usize" };
export type f32   = number & { readonly __type?: "f32" };
export type f64   = number & { readonly __type?: "f64" };
```

**The tag property is optional, so any `number` is assignable to every alias
and the aliases are not assignable to each other.** Measured with TypeScript
5.9.3: literals, arithmetic results, `ref<i32>(0)`, `computed<i32>(…)` and
object literals assign without casts, and vue-tsc reports an `f32` argument
passed to an `i32` parameter inside a template. A required tag property
produces seven false errors on the same input. The tag is named `__type`
because `i32` and `f32` share a width and differ in type.

Rules:

1. **Unannotated `number` is `f64`** on every class, so browser and device
   agree. A warning for unannotated numbers in contract positions is open.
2. The tag survives declarations, array elements, `Ref<T>` and object fields;
   TypeScript drops it through arithmetic (`a + 1` is `number`). The compiler
   types template expressions with the rules below and does not rely on
   TypeScript for numeric types.
3. An integer literal adopts the numeric type its context expects; a
   fractional literal adopts float types only; a literal without context is
   `f64`.
4. Arithmetic and comparison operands must have one numeric type after
   literal adoption. Mixing types is an error, including `i32` with `f64`.
5. Integer to float widening is implicit in one place: a host attribute
   declared as `f32` receiving an integer expression, such as
   `:style="{ width: 80 + count * 12 }"` with `count: i32`.
6. Float to integer conversion goes through `trunc`, `round`, `floor` or
   `ceil`, which return `i32`.
7. `/` and `%` on integer types are errors; `idiv` and `imod` (§5) divide
   integers with the same result on every class. `/` and `%` on float types
   are the plain operators.
8. Integer overflow is not defined by v1. The Rust build uses wrapping
   arithmetic so it cannot panic; the browser and guest classes do not wrap.
9. `len()` returns `i32`; the `v-for` index is `i32`.
10. `i64` and `u64` lose precision above 2^53 on the browser and guest
    classes.
11. **Numbers display the way JavaScript `String(n)` displays them on every
    class.** The Rust runtime implements that conversion, including
    `Infinity`, `-0` as `0`, and the exponent switch at 1e21 and below 1e-6.

The mechanism behind these aliases is called a *branded type* in compiler
code and on this page. That name stays in English and does not appear in
user-facing documentation, which says numeric types.

## 4. Template subset

### Elements and attributes

| Element | Attributes | Events |
|---|---|---|
| `View` | `class`, `:class`, `:style`, `focusable`, `debug-name` | `@press` when `focusable` |
| `Text` | `class`, `:class` | |
| `Image` | `class`, `:class`, `src` (static asset name) | |
| child `.vue` component | its declared props, `v-model` | its declared emits |

The compiler recognizes host primitives by their import path and passes them
to the Vue transform as custom elements, so each one lowers to an explicit
create-element operation with static and dynamic props separated (measured on
`@vue/compiler-vapor` 3.6.0-rc.1).

**`class` compiles at build time.** A static `class` literal becomes one
style id through `compileClasses` in `framework/compiler/tailwind.ts`. A
`:class` binding must be a ternary, or a chain of ternaries, whose leaves are
full class literals; each leaf becomes a style id and the template picks one
at runtime. Object and array class syntax is an error.

`:style` takes an object literal whose keys are numeric props from the `PROP`
table in `contracts/spec/spec.ts` (`width`, `height`, `opacity`, …) and whose
values are numeric expressions; each key lowers to one `set_prop` call.

### Directives

| In v1 | Rules |
|---|---|
| `v-if`, `v-else-if`, `v-else` | the condition is `bool`; `x !== undefined` on an `Option` value narrows `x` to `T` inside the block; a chain that compares one enum value against literals lowers to `match` |
| `v-show` | the condition is `bool`; lowers to one `set_prop` of `DISPLAY`; the subtree stays mounted |
| `v-text` | on `Text` only, with no children; the expression follows the `{{ }}` rules; lowers to the same `SET_TEXT` as `{{ }}` |
| `v-for="item in list"`, `v-for="(item, i) in list"` | `list` is an array; `:key` is required and its type is `i32`, `i64`, `string` or an enum |
| `v-bind:prop` / `:prop` | the expression type matches the child's declaration |
| `v-on:event` / `@event` | handler forms below |
| `v-model` on child components | the value type matches the child's `defineModel<T>` |

Not in v1: `v-html`, `v-once`, `v-memo`, `v-bind="object"`, dynamic event
names, template refs and imperative animation (transitions come
from `transition-*` classes through the style table), `<component :is>`,
`<Teleport>`, `<Transition>`, `<KeepAlive>`, `<Suspense>`, `v-for` over
numbers or objects, scoped slots.

### Handlers

A handler is one of `f()`, `f(args…)`, `x = expr`, `x += expr`, `x -= expr`,
`x++`, `x--`, `emit("name", args…)`, and for component events `f($event)`.
Assignment targets are logic-module values, which then get a setter (§2).
`emit` pushes `<Name>Event::Name(args…)` for the component's own events.
Anything else, including two statements in one handler, is an error.

### Text

`{{ expr }}` accepts numbers, strings, booleans, enums and `Option` of those;
`None` and `undefined` display as the empty string, matching Vue. Objects and
arrays in text are an error.

## 5. Expressions and built-ins

| Construct | Rust lowering | Rule |
|---|---|---|
| `+ - * / %` | the same operator | numeric operands of one type (§3.1) |
| `=== !==` | `== !=` | numbers, strings, booleans, enums, and `x === undefined` on `Option`; objects and arrays are an error; `==` and `!=` are an error |
| `< <= > >=` | the same operator | numbers of one type, or strings |
| `&&`, `\|\|`, `!` | the same operator | `bool` operands; no truthiness |
| `c ? a : b` | `if c { a } else { b }` | `c` is `bool`; `a` and `b` share one type |
| `x ?? d` | `x.unwrap_or(d)` | `x` is `Option<T>` |
| `x?.y` | `Option` combinators | `x` is `Option` of an object type |
| `a.b` | field access | |
| `arr[i]` | `arr.get(i as usize).cloned()` | yields `Option<T>`; `i` is `i32` |
| `` `${a} ${b}` `` | `format!` | the one string concatenation form; `+` on strings is an error |
| `f(args…)` | method call on the logic type | |
| `undefined` | `None` | in comparisons and `??` only |

Not accepted: `typeof`, `in`, `instanceof`, `new`, `delete`, `void`, bitwise
operators, `**`, arrow functions and closures, regular expressions, computed
property names, array and object literals outside `:style`, prototype
methods including `.length`, `Math.*`, and every other global.

**Built-ins are functions exported from one module, imported by name in the
SFC, and implemented twice: in TypeScript for the browser and guest classes
and in Rust for the AOT runtime.** The compiler maps the module's exports to
the Rust runtime by name.

| Built-in | Type | Semantics |
|---|---|---|
| `len(x)` | `(string \| T[]) → i32` | strings count Unicode scalar values: `[...s].length` in TypeScript, `chars().count()` in Rust |
| `trunc(x)`, `floor(x)`, `ceil(x)` | `float → i32` | `Math.trunc`, `Math.floor`, `Math.ceil` |
| `round(x)` | `float → i32` | `Math.round`: halves round toward positive infinity; the Rust implementation is `(x + 0.5).floor()` |
| `idiv(a, b)`, `imod(a, b)` | `(int, int) → int` | truncating division and remainder; a zero divisor yields `0` on every class |
| `min(a, b)`, `max(a, b)` | `(T, T) → T` | one numeric type |
| `abs(x)` | `T → T` | |
| `clamp(x, lo, hi)` | `(T, T, T) → T` | |
| `fixed(x, digits)` | `(float, i32) → string` | `Number.prototype.toFixed`, including round-half-up on exact binary ties |

## 6. Semantics pinned across classes

The same template renders the same text and structure on all three classes
for every accepted program. The rules above close the known divergences:

| Divergence | JavaScript | Rust | Closed by |
|---|---|---|---|
| number display | `String(n)` | `Display` prints `inf`, `-0`, no exponent | §3.1 rule 11 |
| string length | UTF-16 code units | bytes or scalar values | `.length` rejected; `len()` counts scalar values |
| `===` on objects | identity | `PartialEq` structure | objects rejected in comparisons |
| integer `/`, `%` | fractions, `NaN` on zero | truncation, panic on zero | `idiv`, `imod` |
| `Math.round(-2.5)` | `-2` | `f64::round` gives `-3` | `round` built-in |
| `toFixed` on exact ties | half up | `{:.N}` rounds half to even | `fixed` built-in |
| `null` and `undefined` | two empty values | one `Option` | `null` rejected |

**The subset checker runs on every class, including the browser build**, so
a template that passes in the browser is a template the Rust compiler
accepts.

## 7. Update model

One frame on the AOT class:

1. The host calls the generated `frame(input)` once per tick, the
   one-turn-per-tick rule of `docs/RUNTIMES.md`.
2. **Dispatch.** Focus navigation and press edges resolve to a node; the
   node's handler runs against `&mut Logic` as a method call or a setter.
   Incremental input reaches the logic as a typed relative-axis delta under
   the contract of `vapor/host/input.ts`; it is never encoded as buttons.
3. **Update.** The generated `update(&mut self, ui, &Logic)` evaluates every
   binding in the template, compares each result with the value it produced
   last time, and issues `Ui` calls for the ones that changed. `v-if` blocks
   mount and unmount; `v-for` blocks reconcile by key and keep per-row memos.

### Blocks

- **`mount` builds the static structure and leaves every dynamic block
  `Empty`; the first `update` mounts the active branches.** `mount` takes no
  logic reference.
- **Every `v-if` group is one generated enum**: one variant per branch plus
  `Empty`. A lone `v-if` is an enum with one branch variant and `Empty`; a
  chain with `v-else` uses `Empty` before its first update. `update` computes
  the first true branch; the same variant updates in place, a different one
  unmounts the old block and mounts the new one. There is no `Option` path in
  the generator.
- **Blocks have no marker nodes.** Each block exposes `first_node()`; an
  insertion searches the following siblings for the first node that exists
  and passes anchor `0` (append) when there is none. `insert_before` in
  `pocketjs-core` has move semantics.
- **One `<Text>` is one text node and one `format!`**, whatever the number of
  `{{ }}` inside it. The view formats into a scratch `String`, compares it
  with the memo and swaps the two buffers on change, so an unchanged frame
  allocates nothing.
- **`v-for` keeps rows in a `Vec<Row { key, block }>` in render order.** The
  fast path compares the new key sequence with the old one and, when they
  match, updates rows in place with no allocation. The slow path builds a
  `BTreeMap` from old keys to indices, reuses and moves matching rows with
  `insert_before`, mounts the rest and unmounts leftovers. There is no
  longest-increasing-subsequence pass. Duplicate keys fail a debug assertion
  and mount a new row in release builds.
- **Slots compile in the parent's scope.** The child mounts and unmounts a
  slot through a `SlotBlock` trait with those two methods and decides where
  and when it appears; the parent updates the slot's content with its own
  context.

**No dependency tracking exists at runtime or at compile time**: no signals,
no effects, no dirty masks. The cost of a frame is proportional to the number
of bindings plus the length of rendered lists, and the logic type is a plain
Rust struct with `&self` and `&mut self` methods. The compile-time dependency
masks of the Pocket Vapor design do not carry over: application logic in Rust
is opaque to the compiler, so an edge from a setter to a binding cannot be
computed at build time.

## 8. Generated code shape

Illustrative: the names are fixed, the bodies are not. The source is a root
component, its declarations module and one child component.

```vue
<!-- Todo.vue -->
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { len, type i32 } from "@pocketjs/framework/aot";
import Row from "./Row.vue";
import { count, todos, filter, remaining, toggle } from "./todo";

const props = defineProps<{ title: string }>();
const emit = defineEmits<{ saved: [id: i32] }>();
</script>

<template>
  <View class="flex-col gap-2 p-4" :class="filter === 'done' ? 'bg-slate-900' : 'bg-slate-50'">
    <Text class="text-lg font-bold">{{ props.title }} · {{ remaining() }} left</Text>
    <Row v-for="t in todos" :key="t.id" :todo="t" @toggle="toggle(t.id)" />
    <Text v-if="len(todos) === 0" class="text-slate-500">NOTHING HERE</Text>
    <Text v-if="filter === 'done'">done only</Text>
    <Text v-else-if="filter === 'active'">active only</Text>
    <View focusable @press="count++"><Text v-text="count" /></View>
    <View focusable @press="emit('saved', count)"><Text>SAVE</Text></View>
  </View>
</template>
```

```ts
// todo.d.ts
import type { i32 } from "@pocketjs/framework/aot";
export interface Todo { id: i32; text: string; done: boolean }
export type Filter = "all" | "active" | "done";
export declare const count: i32;
export declare const todos: Todo[];
export declare const filter: Filter;
export declare function remaining(): i32;
export declare function toggle(id: i32): void;
```

```vue
<!-- Row.vue -->
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { Todo } from "./todo";

const props = defineProps<{ todo: Todo }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <View focusable :class="props.todo.done ? 'text-slate-500' : 'text-white'" @press="emit('toggle')">
    <Text>{{ props.todo.done ? "[X] " : "[ ] " }}{{ props.todo.text }}</Text>
  </View>
</template>
```

What the compiler generates for `Todo.vue`; `Row.vue` produces
`RowProps<'a> { todo: &'a Todo }`, `RowEvent { Toggle }` and `RowView` the
same way:

```rust
// generated from Todo.vue + todo.d.ts
pub struct Todo { pub id: i32, pub text: String, pub done: bool }
pub enum Filter { All, Active, Done }
pub struct TodoProps<'a> { pub title: &'a str }
pub enum TodoEvent { Saved(i32) }

pub trait TodoLogic {
    fn count(&self) -> i32;
    fn set_count(&mut self, v: i32);   // assigned by `@press="count++"`
    fn todos(&self) -> &[Todo];
    fn filter(&self) -> Filter;
    fn remaining(&self) -> i32;        // referenced in a binding: &self
    fn toggle(&mut self, id: i32);     // referenced in a handler: &mut self
}

enum If0 { B0(Block0), Empty }             // <Text v-if="len(todos) === 0">
enum If1 { B0(Block1), B1(Block2), Empty }  // the filter v-if / v-else-if chain
struct Row { key: i32, block: RowView }     // one <Row v-for> row

pub struct TodoView { /* node ids, memoized values, If0, If1, Vec<Row> */ }
impl TodoView {
    pub fn mount(ui: &mut Ui, parent: i32, anchor: i32) -> Self; // blocks start Empty
    pub fn update<L: TodoLogic>(&mut self, ui: &mut Ui, props: &TodoProps<'_>, logic: &L);
    pub fn dispatch<L: TodoLogic>(&mut self, input: &Input, logic: &mut L, events: &mut Vec<TodoEvent>);
    pub fn unmount(self, ui: &mut Ui);
}
```

Application code:

```rust
struct TodoApp { count: i32, todos: Vec<Todo>, filter: Filter }

impl TodoLogic for TodoApp {
    fn count(&self) -> i32 { self.count }
    fn set_count(&mut self, v: i32) { self.count = v }
    fn todos(&self) -> &[Todo] { &self.todos }
    fn filter(&self) -> Filter { self.filter }
    fn remaining(&self) -> i32 { self.todos.iter().filter(|t| !t.done).count() as i32 }
    fn toggle(&mut self, id: i32) {
        if let Some(t) = self.todos.iter_mut().find(|t| t.id == id) { t.done = !t.done }
    }
}
```

A handler the template references and the application does not implement is
a `rustc` error.

## 9. Build, tooling, open items

- The compiler is TypeScript on Bun. It reuses `parse` from
  `@vue/compiler-sfc`, `parse` from `@vue/compiler-dom` and `transform` from
  `@vue/compiler-vapor`, pinned to the repository's Vue version (3.6.0-rc.1;
  upstream is at rc.8 and the IR is not a public API, so its type definitions
  are vendored). The expression compiler and the Rust generator are new code;
  `generate` from `@vue/compiler-vapor` is not used.
- Output is `gen/<component>.rs` plus the style table for the app crate. How
  the crate picks the files up, a `build.rs` with `rerun-if-changed` or
  committed files, is open.
- Host primitives are built into the Rust AOT runtime with the same props and
  semantics as the JavaScript components. A shared spec and a drift test for
  that parity are open.
- The Pocket Vapor board admission (`vapor/BOARDS.md`) carries over as the
  source of compile-time demands. The C runtime, `vapor/compiler/compile.ts`,
  `sccp.ts` and `rom.ts` do not.
- Testing: a differential snapshot test renders one fixture of props and
  logic values through stock Vue Vapor on the micro-DOM and through the
  generated Rust view, then compares the trees. DrawList goldens on the
  desktop host apply to AOT apps as they do to guest apps. The harness is
  open.

Open:

1. The name of the family and the paths of the types and built-ins module.
2. Stateful child components (proposed: a `Default`-constructed logic type
   per instance).
3. Scoped slots; `withDefaults` with literal defaults; input beyond `@press`
   in templates (button maps, relative-axis handlers).
4. A warning for unannotated `number` in contract positions.
5. An auto-generated mock for projects whose logic module is a `.d.ts`.
6. `build.rs` mechanics, the host-primitive parity spec and drift test, and
   the differential test harness.
