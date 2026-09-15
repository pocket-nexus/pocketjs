# Vue AOT: v1.1 boundaries and contracts

**Status: v1.1 compiler and runtime implementation, 2026-09-15; test work is
deferred.** This page pins what
the compiler accepts, what it generates, and where generated Rust ends and
application Rust begins. It is the contract for the rewrite of Pocket Vapor
on branch `vue-aot`: the family keeps its name and its execution class `aot`
(§10), and this page supersedes `vapor/DESIGN.md`, which describes the C
pipeline. That pipeline stays in the tree until the Rust pipeline renders
`apps/vue-sfc-lab` with the same features.

Build commands and host integration are in [VUE_AOT_BUILD.md](VUE_AOT_BUILD.md).

The implemented contract includes v1 and v1.1; v2 is scheduled in §10. Changing it
means editing this page first.

## 1. Input, output, execution classes

**Input is a Vue single-file component: one `<template>` and one
`<script setup lang="ts">`.** The script block may contain the statements in
the table below and nothing else. The factory call below is the runtime statement admitted for component state.
Other runtime statements are compile errors with a `file:line` diagnostic.

| Allowed in `<script setup>` | Purpose |
|---|---|
| `import { View, Text, Image } from "@pocketjs/framework/vue-vapor/components"` | host primitives (§4) |
| `import Row from "./Row.vue"` | child components |
| `import type { Todo } from "./todo"` | types from any module |
| `import { count, toggle } from "./todo"` | the view-model module (§2) |
| `import { len, trunc, type i32 } from "@pocketjs/framework/vue-vapor/std"` | built-ins and numeric types (§3, §5, §10) |
| `interface`, `type` | shapes used by the contract |
| `const { count, inc } = createRow()` | instance state from the basename module factory (§2) |
| `const props = defineProps<T>()`, `const emit = defineEmits<T>()`, `const model = defineModel<T>()` | component interface (§2); Vue's compile-time macros |

**Output is Rust source.** The generated module links `pocketjs-core` and
calls `Ui` methods (`create_node`, `insert_before`, `set_style`, `set_prop`,
`set_text`, `set_focus`) on node ids it owns. The product contains no
JavaScript engine, no `ui.*` op encoding and no mirror tree.

**One SFC runs in three execution classes.**

| Class | View-model implementation | Pipeline | Status |
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

## 2. The view-model module

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

The compiler generates `<Name>ViewModel` traits for component contracts. The
application supplies the implementing types. The generated app owns the root
model; generated views own per-instance child models, node ids and memoized
binding values. Parent state is passed by reference and is not copied into
child views.

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

**A child obtains instance state from a zero-argument factory.** Its basename
module exports the factory and its SFC destructures the returned values:

```ts
import { createRow } from "./Row";
const { count, inc } = createRow();
```

The checker reads the factory's return type. A `.ts` factory returns Vue refs
and functions; a `.d.ts` factory declares the same object shape. Browser
previews of declaration-only components construct fresh refs per call.
A component uses either a factory or direct view-model imports. Pure children
continue to use props, emits, model and slots.

**Each stateful child mount constructs a distinct Rust model.** The parent's
trait declares `type Row: RowViewModel + Default`; generated views construct
`M::Row::default()` and own that value until unmount. A keyed row keeps its
model when it moves. A branch that unmounts drops its child model. Child
handlers use the child's mutable model, and events return to the parent.
Slot expressions retain the parent's scope, including across stateful children.
If slot content owns another stateful child, that stored child's associated
model type also requires `'static`. The parent model and props can borrow
application data; the slot registry stores no parent-model reference.

**Optional void functions have a default empty Rust method.** An imported
`((dt: f32) => void) | undefined` remains callable in a handler. Browser
compilation inserts optional calls; absence performs no operation.

### Component interface

| Declaration | Generated |
|---|---|
| `defineProps<{ title: string; max?: i32; todo: Todo }>()` | `pub struct <Name>Props<'a> { pub title: &'a str, pub max: Option<i32>, pub todo: &'a Todo }` |
| `defineEmits<{ saved: [id: i32] }>()` | `pub enum <Name>Event { Saved(i32) }` |
| `defineModel<T>()` | prop `model_value: T` plus event `UpdateModelValue(T)`; `defineModel<T>("name")` uses that name |
| `<slot />`, `<slot name="footer" />` | one slot parameter per slot; slot content compiles in the parent's scope |
| `withDefaults(defineProps<{ label?: string }>(), { label: "VALUE +1" })` | the parent's generated code inserts the literal where it omits the prop; inside the child `label` is `&str`, not `Option` |

**Props borrow.** The parent rebuilds a child's props from its own getters on
every frame; `string`, arrays and object types arrive as `&'a str`, `&'a [T]`
and `&'a T`, and the child memoizes what it renders, so passing props
allocates nothing. Event payloads are owned.

`defineEmits` accepts the tuple form only. Defaults must be literals: strings,
numbers, booleans or enum literals; an object, array or function default is
an error. Scoped slots (slot props) are scheduled for v2 (§10).

## 3. Types

| TypeScript | Rust |
|---|---|
| `string` | `&str` from getters and in props; `String` from functions, in event payloads and wherever the application stores it |
| `boolean` | `bool` |
| `number` | `f64` |
| `i8` … `f64` (§3.1) | the Rust type of the same name |
| union of string literals `"all" \| "done"` | `enum` with unit variants `All`, `Done`; the literal is the display form |
| `interface` / object type | `struct` with derives selected by use, fields in declaration order; `&T` from getters and in props |
| `T[]`, `Array<T>` | `&[T]` from getters and in props; `Vec<T>` from functions |
| `[A, B]` | `(A, B)`; a nonempty homogeneous tuple `[T, T, T]` becomes `[T; 3]` |
| `x?: T`, `T \| undefined` | `Option<T>` |
| discriminated union `{ kind: "a"; … } \| { kind: "b"; … }` (§3.2) | `enum` with one struct or unit variant per member |
| `T & { readonly __newtype?: "Name" }` (§3.2) | `pub struct Name(pub T)` |
| `declare const X: 20`, `"text"`, `true` (§3.2) | a folded literal at every use, plus `pub const X` |
| function type | trait method (§2); not a value |

Rejected in contract positions: `null`, `any`, `unknown`, `never`, `object`,
`symbol`, `bigint`, `Function`, classes, generic parameters, mapped,
conditional and template-literal types other than `Color`, index signatures, `Record`, `Map`,
`Set`, unions other than string literals, discriminated unions and
`| undefined`, and intersections other than the `__type` and `__newtype`
tags.

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
   agree. The compiler reports a warning for each unannotated `number` in a
   contract position (view-model values and signatures, props, emits, object
   fields); `--strict` promotes it to an error, and an explicit `f64`
   silences it.
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
   `ceil`, which return `i32`. **Conversion saturates:** after rounding, NaN
   becomes `0`, values above `2147483647` become `2147483647`, and values
   below `-2147483648` become `-2147483648`, including infinities.
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
12. **`f32` keeps the execution class's native precision.** TypeScript's
    numeric annotation is erased: browser and guest classes use JavaScript
    double precision, while Rust uses single precision. The browser compiler
    inserts no `Math.fround`. Rounding can change values, displayed digits
    and comparisons, including the branch a condition selects. Cross-class
    bit equality is not part of the v1 `f32` contract.

The mechanism behind these aliases is called a *branded type* in compiler
code and on this page. That name stays in English and does not appear in
user-facing documentation, which says numeric types.

### 3.2 Newtypes, constants and discriminated unions

**Newtypes use a second tag property.** `type TodoId = i32 & { readonly
__newtype?: "TodoId" }` generates `pub struct TodoId(pub i32)` with the
derives of its base type. A second `__type` tag on one alias collapses the
property to `never` and rejects every value, which is why the property is
`__newtype` (measured with TypeScript 5.9.3). `TodoId` and `UserId` do not
assign to each other; a plain `i32` still flows into either, the same
softness as `number` into `i32`. A literal in a newtype position adopts it:
`toggle(3)` with `toggle(id: TodoId)` lowers to `TodoId(3)`.

**Literal types carry constants.** `export declare const MAX: 20` and
`export declare const TITLE: "POCKET TODO"` are declarations with no runtime
code, and the checker reports the literal as the type. The compiler folds
the value at every use, a numeric constant adopting the numeric type of its
context like a literal (§3.1 rule 3), and also emits `pub const MAX` with the
default mapping for application code.

**Discriminated unions become enums with data.** A union whose members are
object types sharing one property of distinct string-literal type, declared
under a `type` alias, generates one enum: the discriminant literal names the
variant in PascalCase, the remaining properties are the variant's named
fields, and a member with no other properties is a unit variant.

```ts
export type Load =
  | { kind: "loading" }
  | { kind: "ready"; items: Todo[] }
  | { kind: "error"; message: string };
```

```rust
pub enum Load { Loading, Ready { items: Vec<Todo> }, Error { message: String } }
```

In templates `load.kind === 'ready'` lowers to `matches!`, `{{ load.kind }}`
displays the literal, and a `v-if` on the discriminant narrows `load` inside
the block, so `load.items` lowers to the field of an `if let Load::Ready {
items } = load` (§9, expression types). A chain over every literal lowers to
an exhaustive `match`.

### 3.3 Units and derives

**The standard library exports `Px`, `Ms`, `Deg` and `Color`.** `Px`, `Ms`
and `Deg` wrap `f32`; `Color` has TypeScript type
`` `#${string}` & { readonly __newtype?: "Color" } `` and Rust storage
`Color(pub u32)` in the core's ABGR order.

| Style property | Required unit |
|---|---|
| dimensions, padding, margin, gap, basis, insets, radius, border/bevel widths, line height, tracking, translations, perspective and arc width | `Px` |
| rotation and arc angles | `Deg` |
| every color property in `PROP` | `Color` |
| grow, shrink, opacity, scale, transform origins and gradient stop fractions | dimensionless `f32` |

Literals adopt the required unit: `width: 80` emits `Px(80.0)`. The integer
host-attribute widening in §3.1 also constructs the unit wrapper. A value
with another unit is rejected. `Ms` is available in application signatures;
the core `PROP` table contains no duration property.

**Color accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`.** Text displays
lowercase `#rrggbbaa`; equality compares ABGR values, so `#f00` and `#ff0000`
compare equal. Color arithmetic and ordered comparisons are errors. Browser
compilation normalizes color display and equality before invoking stock Vue.
An absent optional Color displays empty text in Vue interpolation and
`undefined` inside a JavaScript template string.

Derives follow generated operations: copying scalar values needs `Copy`,
owned snapshots need `Clone`, memo comparison needs `PartialEq`, and keyed
lists need `Eq` and `Ord`. Requirements propagate into field types. Types
passed through borrowed props do not gain unused derives.

The generated editor declarations use `NoInfer` for later operands of
same-type built-ins, preserve literal adoption, and expose `onPress` only
on the `focusable: true` branch of View props. Style property types are
generated from the same unit table the compiler reads.

## 4. Template subset

### Elements and attributes

| Element | Attributes | Events |
|---|---|---|
| `View` | `class`, `:class`, `:style`, `focusable`, `debug-name` | `@press` when `focusable` |
| `Text` | `class`, `:class` | |
| `Image` | `class`, `:class`, `src` (static asset name) | |
| child `.vue` component | its declared props, `v-model` | its declared emits |
| `ActionHandler` | static `:button="BTN.CIRCLE"`, `active`, `latched` | `@press` |
| `AxisHandler` | static `axis="primary"` or `"secondary"`, `active` | `@delta` with an `i32` millidegree payload |

The compiler recognizes host primitives by their import path and passes them
to the Vue transform as custom elements, so each one lowers to an explicit
create-element operation with static and dynamic props separated (measured on
`@vue/compiler-vapor` 3.6.0-rc.1).

**`class` compiles at build time.** A static `class` literal becomes one
style id through `compileClasses` in `framework/compiler/tailwind.ts`. A
`:class` binding must be a ternary, or a chain of ternaries, whose leaves are
full class literals; each leaf becomes a style id and the template picks one
at runtime. Object and array class syntax is an error.

`:style` takes an object literal whose keys come from `PROP` in
`contracts/spec/spec.ts` (`width`, `height`, `opacity`, …). Values must match
the property numeric type or unit in §3.3; each key lowers to one `set_prop` call.

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
Assignment targets are view-model values, which then get a setter (§2).
`emit` pushes `<Name>Event::Name(args…)` for the component's own events.
Anything else, including two statements in one handler, is an error.

### Text

`{{ expr }}` accepts numbers, strings, booleans, enums and `Option` of those;
`None` and `undefined` display as the empty string, matching Vue. Objects and
arrays in text are an error. Interpolation calls the runtime's display trait,
implemented for those types only, so a struct in text fails in `rustc` as well
as in the checker; an enum displays its literal.

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
| `f(args…)` | method call on the view-model type | |
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
| `round(x)` | `float → i32` | `Math.round`: halves round toward positive infinity; compare `x - floor(x)` with `0.5` before adding one to the floor, avoiding rounding in `x + 0.5` |
| `idiv(a, b)`, `imod(a, b)` | `(int, int) → int` | truncating division and remainder; a zero divisor yields `0` on every class |
| `min(a, b)`, `max(a, b)` | `(T, T) → T` | one numeric type |
| `abs(x)` | `T → T` | |
| `clamp(x, lo, hi)` | `(T, T, T) → T` | |
| `fixed(x, digits)` | `(float, i32) → string` | `Number.prototype.toFixed`, including round-half-up on exact binary ties |

## 6. Semantics pinned across classes

The same template renders the same text and structure on all three classes
within the numeric precision and overflow boundaries in §3.1. **`f32`
precision, integers beyond JavaScript's exact range and integer overflow are
exceptions.** The rules above close the other known divergences:

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
   node's handler runs against `&mut ViewModel` as a method call or a setter.
   Action and axis handlers run in document order. A handler's `active`
   condition controls delivery; button history advances even when inactive.
   A latched button handler waits until it observes the button released.
   Incremental input is a typed relative-axis delta and is never encoded as
   buttons. Multiple deltas for one axis in a frame are summed with i32
   saturation. Each axis handler receives one nonzero accumulated delta.
   A handler's emit runs the parent listener before the next handler.
   The next handler reads fresh parent-derived props and loop values;
   a component-entry snapshot does not hide an earlier handler's mutation.
3. **Update.** The generated `update(&mut self, ui, &ViewModel)` evaluates every
   binding in the template, compares each result with the value it produced
   last time, and issues `Ui` calls for the ones that changed. `v-if` blocks
   mount and unmount; `v-for` blocks reconcile by key and keep per-row memos.

### Blocks

- **`mount` builds the static structure and leaves every dynamic block
  `Empty`; the first `update` mounts the active branches.** `mount` takes no
  view-model reference.
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
no effects, no dirty masks. Update work visits rendered bindings and list
items; application functions and string operations contribute their own cost.
The view-model type is a plain Rust struct with `&self` and `&mut self` methods.
Input dispatch uses a cursor to skip completed handlers. Lists cache handler
prefix counts and locate the next row with a binary search; if an earlier
handler reorders model data, resolving a retained key may scan the source.
The compile-time dependency
masks of the Pocket Vapor design do not carry over: application logic in Rust
is opaque to the compiler, so an edge from a setter to a binding cannot be
computed at build time.

Three rules bound that cost:

- **A frame in which no handler ran issues no `update`.** In v1 state
  changes only through `dispatch`, so idle frames do no view update. Input
  handlers still sample button history to arm latches. A host
  that mutates the application between frames calls `invalidate()` on the
  generated app, and the next frame runs `update` once.
- **`update` reads what bindings read.** It calls the getters that template
  expressions name and nothing else; a field the template does not use is
  never touched, whatever its size.
- **A text binding memoizes its inputs, not its output.** `format!` runs
  only when one of the values it prints changed.

## 8. Generated code shape

Illustrative: the names are fixed, the bodies are not. The source is a root
component, its declarations module and one child component.

```vue
<!-- Todo.vue -->
<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { len, type i32 } from "@pocketjs/framework/vue-vapor/std";
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
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
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

pub trait TodoViewModel {
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
    pub fn mount(ui: &mut Ui, parent: NodeId, anchor: NodeId) -> Self; // blocks start Empty
    pub fn update<M: TodoViewModel>(&mut self, ui: &mut Ui, props: &TodoProps<'_>, vm: &M);
    pub fn dispatch<M: TodoViewModel>(&mut self, input: &Input, vm: &mut M, events: &mut Vec<TodoEvent>);
    pub fn unmount(self, ui: &mut Ui);
}
```

Application code:

```rust
struct TodoApp { count: i32, todos: Vec<Todo>, filter: Filter }

impl TodoViewModel for TodoApp {
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

## 9. Compiler, build, tests

The compiler is TypeScript on Bun. It reuses `parse` from
`@vue/compiler-sfc`, `parse` from `@vue/compiler-dom` and `transform` from
`@vue/compiler-vapor`, pinned to the repository's Vue version (3.6.0-rc.1;
upstream is at rc.8 and the IR is not a public API, so its type definitions
are vendored). `generate` from `@vue/compiler-vapor` is not used.

### Pipeline

```
Vapor IR + TypeScript types ─► View IR ─► Rust AST ─► printer ─► gen/<component>.rs
```

**Rust source text exists in the printer and nowhere else.** No analysis pass
emits code.

- **View IR** is the end of analysis and serializes to JSON. Names are
  resolved (a view-model value, a `v-for` variable, a built-in), every
  expression node carries its type, class literals are style ids, memo slots
  and node numbers are assigned, and `v-if` groups, `v-for` blocks and
  handlers are explicit nodes. It knows nothing about Rust and nothing about
  Vue's IR.
- **Expression types come from the TypeScript checker.** The compiler feeds
  the virtual TypeScript that `@vue/language-core` generates for the SFC, the
  code vue-tsc checks, to a program built with `proxyCreateProgram` from
  `@volar/typescript`, and reads each template expression's type with
  `getTypeAtLocation`, locating nodes through the virtual code's `mappings`.
  Control-flow narrowing comes with it. Measured with vue-tsc 3.3.11:
  `current.text` inside `v-if="current !== undefined"` is `string`,
  `load.items` inside `v-if="load.kind === 'ready'"` is `Todo[]`, the
  `v-else` branch sees `load.kind` as `"loading"`, and a `v-for` variable
  has the element type. The compiler's own checker does three things: subset
  admission by syntax, numeric tag propagation through arithmetic (§3.1 rule
  2), and the TypeScript-to-Rust mapping. `@vue/language-core` and
  `@volar/typescript` are pinned together with vue-tsc.
- **Rust AST** covers the subset the compiler emits: `struct`, `enum`,
  `trait`, `impl`, `fn`, `let`, `if`, `match`, method calls, field access,
  literals and `format!`. The View IR to Rust AST pass is where the lowering
  rules of §3 and §5 live: `len()` becomes `chars().count() as i32`, `idiv`
  becomes a runtime call, display goes through the JavaScript-semantics
  helper.
- **The printer** parenthesizes by precedence, rewrites identifiers (keywords
  get `r#`, string-literal variants become PascalCase, collisions get a
  suffix), escapes literals and indents. Its output is valid Rust; the build
  runs `rustfmt` on it when the tool is present and compiles the unformatted
  file when it is not.

### Output

**Generated files are committed, and a drift test regenerates them in memory
and compares bytes**, the convention of `engine/core/src/spec.rs` and
`tests/contract.ts`. `gen/<component>.rs` plus the style table enter the app
crate as ordinary source, so device builds need no Bun and `build.rs`
generates nothing. Output is deterministic: the same input produces the same
bytes, with fields and nodes in a fixed order.

### Alternative emitter

The View IR JSON is also the boundary for a Rust-side emitter: a
`pocket-vue-codegen` crate built on `quote!` and `prettyplease`, run from
`build.rs`. That path keeps lowering rules and runtime in one workspace at
the cost of a two-language compiler and a versioned schema. It is the path
to take if the front end moves to Rust; the View IR makes that switch a
back-end change.

### Rust-side checks

The generated code is shaped so that `rustc` enforces rules the checker
also states:

- `update` borrows the view model as `&M` and `dispatch` as `&mut M`, so a
  binding cannot mutate state during rendering.
- A new emit in the SFC makes the application's `match` on `<Name>Event`
  non-exhaustive, and a new declaration leaves a trait method unimplemented:
  contract changes surface as compile errors in application code.
- Node ids and style ids are `NodeId` and `StyleId` newtypes over the core's
  `i32`, so the two cannot be swapped in a `Ui` call.
- `v-for` keys carry an `Eq + Ord` bound; `f64` is not `Ord`, which is why
  keys are `i32`, `i64`, `string` or an enum (§4).
- Text interpolation goes through the display trait (§4).

### Tests

- Front end: one View IR JSON snapshot per fixture SFC; subset diagnostics
  asserted by `file:line`.
- Back end: the generated Rust compiles under `cargo test` and runs `mount`
  and `update` against a `Ui` recorder that logs the call sequence; the
  sequence is the assertion.
- Differential: `vapor/tests/differential/<name>/` holds `App.vue`, its
  module, `fixture.json` and `tape.json`, a list of per-frame inputs
  (buttons, axis deltas). The browser class runs through `hosts/sim`
  (`bootWorld`, `frame`) with the TypeScript mock built from the fixture; the
  AOT class runs a `cargo test` binary in `engine/crates/pocket-vapor` that
  includes the generated code, mounts the view over `FixtureViewModel` and
  feeds the same tape. Both sides dump a normalized tree after every frame,
  `{ t: node type, s: style id, x: text, k: children }`, and the runner
  compares the dumps frame by frame.
- Fixtures come from the contract. The compiler generates a `FixtureViewModel`
  that implements `<Name>ViewModel` from a JSON document, `serde::Deserialize`
  on the contract types behind a `test` feature, and a TypeScript mock
  module of the same shape. One fixture feeds both sides of the differential
  test, and the mock with default values (`0`, empty string, empty list,
  no-op functions) is what the browser build runs when a project has only a
  `.d.ts` module.
- DrawList goldens on the desktop host apply to AOT apps as they do to guest
  apps.

**One spec file pins what both runtimes implement.** `contracts/spec/vapor.ts`
holds the host primitive vocabulary (elements, attributes, events, the
`:style` keys drawn from `PROP`), the built-ins with their signatures and the
numeric type names. `contracts/spec/gen-rust.ts` emits
`engine/crates/pocket-vapor/src/spec.rs` from it, the std module's
declarations and the components' prop types come from the same file, and
`tests/contract.ts` byte-compares every generated output. The board admission
of `vapor/BOARDS.md` carries over as the source of compile-time demands. The
C runtime, `vapor/compiler/compile.ts`, `sccp.ts` and `rom.ts` do not.

## 10. Name, paths and plan

**The family keeps the name Pocket Vapor and the execution class keeps the
name `aot`.** The design is what the name says, Vue Vapor compiled ahead of
time, and the manifest field, the site and the board admission carry the name
today.

| What | Where |
|---|---|
| compiler, TypeScript on Bun | `vapor/compiler/`: new files beside the C pipeline until parity, alone after |
| command | `bun vapor/compiler/cli.ts build <app>` |
| numeric types and built-ins | `@pocketjs/framework/vue-vapor/std`, file `framework/src/std-vue-vapor.ts` |
| family spec | `contracts/spec/vapor.ts`, generated into `engine/crates/pocket-vapor/src/spec.rs` (§9) |
| Rust runtime | `engine/crates/pocket-vapor`, crate `pocket_vapor`: blocks, keyed lists, the display trait, built-ins, input dispatch, `NodeId` and `StyleId` |
| generated code | `gen/` in the app crate, committed (§9) |
| fixtures and differential tests | `vapor/tests/` |

### Implemented in v1.1

- Factory-backed stateful children with one model per mounted instance (§2).
- Action and relative-axis handlers with frame sampling (§4, §7).
- Host capability bounds: `Host`, `HasButton<MASK>`, `HasRelativeAxis<AXIS>`
  and `HasTouch`. A generated app requires the capabilities its template
  uses. `HasTouch` is available to hosts; v1.1 adds no touch-specific
  template syntax. Board input profiles remain the diagnostic source.
- Optional void methods with empty defaults (§2).
- Editor rules, units, usage-based derives and fixed tuples (§3.3).

### Planned for v2

- Scoped slots. `defineSlots<{ row(props: { item: Todo }): any }>()` types
  the slot, `<slot name="row" :item="t" />` supplies the values, and the
  parent's `<template #row="{ item }">` compiles in the parent's scope with
  `item` as one more typed parameter. The child exposes the arguments of
  every slot instance and the parent updates the instances with its own
  context plus those arguments. Generic components
  (`<script setup generic="T">`) build on this.
- Capacity tags (`Todo[] & { readonly __cap?: 32 }` becomes
  `heapless::Vec<Todo, 32>`) for targets without an allocator.
- Typed provide and inject. `provide("theme", theme)` in the root script and
  `const theme = inject<Theme>("theme")` in a child are the two runtime
  statements admitted for this, both stock Vue. The compiler matches them by
  key, checks the types, and threads a `&Theme` through the generated views,
  so a deep tree passes no props along the way and the runtime does no
  lookup.
