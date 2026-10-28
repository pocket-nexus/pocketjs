# TypeScript support

**PocketJS's application source contract is TypeScript.** Solid and Octane
views use TSX; Vue views use TSX or typed single-file components. Guest builds
emit JavaScript for their execution engine. Native AOT builds emit Rust.
The output language does not add another application source-language promise.

This page defines the source-language differences between ordinary framework
applications, AOT views and compiled models. The framework guides describe
view authoring; the [model guide](/docs/microts-model/) describes frame
execution; [TypeScript and native code](/docs/microts-boundaries/) describes
ownership and host integration.

- [Execution modes](#execution-modes)
- [Data types and Rust values](#data-types-and-rust-values) and [numbers](#numbers)
- [View and model expressions](#view-and-model-expressions)
- [Model modules and imports](#model-modules-and-imports)
- [Functions and callbacks](#functions-and-callbacks) and [model statements](#model-statements)
- [Reactive state](#reactive-state-and-regions) and [async tasks](#async-tasks-and-host-services)
- [Current implementation limits](#current-implementation-limits) and [application checks](#checking-an-application)

## Execution modes

| Build route | TypeScript view | TypeScript model | Native model |
|---|---|---|---|
| Ordinary guest path without AOT admission | Framework transform and PocketJS component rules | Framework and host API rules | No Model AOT implementation is selected |
| AOT view with `app.model: "rust"` or omitted | AOT view subset | Bodies provide guest behavior; their types define the native contract | Application implements the generated Rust trait |
| `app.aot: true`, `app.model: "compiled"` | AOT view subset | Model AOT subset on both guest and native builds | Compiler generates the implementation from `.ts` bodies |

Native AOT commands check their input views. In guest builds, `app.aot: true`
enables Solid graph admission. A Vue SFC also enables its AOT checks when it
imports a value from its basename model or imports
`@pocketjs/framework/vue-vapor/std`. Omitting the manifest flag does not bypass
those Vue contract checks. Compiled model selection still requires both
`app.aot: true` and `app.model: "compiled"`.

**Model AOT restrictions apply to compiled model modules, not all TypeScript
application code.** An ordinary guest application does not acquire native AOT
support by using TypeScript. Its dependencies still need APIs that the target
provides; TypeScript support does not supply browser DOM or Node.js APIs.

The AOT view frontends support Solid TSX and Vue SFCs. Octane remains a guest
framework. The earlier [C cartridge compiler](https://github.com/pocket-nexus/pocket-vapor)
has its own repository, subset and targets.

A view imports its contract from a basename module: `Counter.tsx` or
`Counter.vue` imports `./Counter`. Use `Counter.ts` for a model implementation,
or `Counter.d.ts` for declarations in Rust mode. Declaration previews supply
default values and empty methods; they do not execute Rust business logic.
Compiled mode requires `.ts` bodies and never selects a replacement Rust
implementation after an admission error.

## Data types and Rust values

**AOT data must have a type the compiler can map to native storage.** Type
aliases and interfaces name these types; they do not admit an unsupported
underlying shape.

| TypeScript contract | Rust read or prop form | Rust owned form |
|---|---|---|
| `boolean` | `bool` | `bool` |
| `string` | `&str` | `String` |
| `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `usize`, `f32`, `f64` | Corresponding numeric type | Same numeric type |
| `number` | `f64` in Rust-mode contracts; rejected with `--strict` | `f64` |
| `T[]`, `Array<T>` | `&[T]` | `Vec<T>` |
| `Cap<string, N>` | `&str` | `heapless::String<N>` |
| `Cap<T[], N>` | `&[T]` | `heapless::Vec<T, N>` |
| Explicit interface or object type | Reference to the generated struct | Generated struct |
| String-literal union or string enum | Generated enum | Same enum |
| Object union with a shared string-literal discriminant | Reference to the generated enum | Enum variants with fields |
| Optional property or `T \| undefined` | Optional read form | `Option<T>` |
| Fixed homogeneous tuple | Reference to a fixed array | Fixed array |
| Fixed heterogeneous tuple | Tuple of read forms | Rust tuple |
| `i32 & { readonly __newtype?: "ItemId" }` | Generated `ItemId` value | `ItemId(pub i32)` |
| `Px`, `Deg`, `Ms`, `Color` | Generated unit or color value | Same value |

`Accessor<T>`, `Ref<T>`, `ShallowRef<T>` and `ComputedRef<T>` expose `T` in a
view contract. Setter arguments, function arguments/results and event payloads
use owned forms. The supported state constructors in compiled models are
listed under [reactive state](#reactive-state-and-regions); accepting a wrapper
type in a declaration does not admit every framework API that creates it.

Tuple support in a contract does not imply support for every tuple expression
in a model. Model array literals require one element type. A heterogeneous
tuple cannot be constructed with a mixed array literal or indexed as an array
in a model body. Tuple types cannot have optional or rest elements.

Unsupported data contracts include `any`, `unknown`, `never`, `null`, `bigint`,
`symbol`, classes, function-valued data, `Map`, `Set`, `Record`, mapped object
types and index signatures. Unresolved type parameters and conditional or
template-literal types that remain unresolved are also unsupported. Use an
explicit object shape and `T | undefined` for an optional value.

The view compiler has designated function positions: event callbacks, slots
and model methods. These do not make functions general data values. The `any`
return placeholder in Vue `defineSlots` is accepted; its slot parameter types
still determine the values the parent receives.
`void` is admitted as a function result.

Generic view components are specialized from concrete props or type defaults.
**Model function type parameters are not supported.** These are different
features: a specialized component does not require a generic native model
function.

`Cap` accepts a positive integer capacity. Strings count UTF-8 bytes; arrays
count elements. Overflow traps in development and truncates in release, at a
UTF-8 character boundary for strings. Untagged strings, arrays and nested
values can allocate; `Cap` does not make an entire application allocation-free.

## Numbers

Import numeric types and standard functions from
`@pocketjs/framework/solid/std` or `@pocketjs/framework/vue-vapor/std`.

| Rule | AOT view | Compiled model |
|---|---|---|
| Type source | Contract, prop or expression context | Annotation, context or model-body inference |
| Integer source token such as `1` | Adopts the required type | Infers `i32` without another required type |
| Fractional/exponent token such as `1.0`, `.5`, `1e3` | Adopts a compatible floating type | Infers `f64`; cannot adopt an integer type |
| Integer division | `idiv(a, b)` | `idiv(a, b)`; `/` promotes integer operands to `f64` |
| Integer remainder | `imod(a, b)` | `imod(a, b)` or `%`; a remainder by zero is `0` |
| Float-to-integer conversion | `trunc`, `floor`, `ceil`, `round` | Same functions; a type assertion is not a conversion |
| Numeric reassignment | Must fit the contract | A local keeps its numeric type for its scope |

Compiled model arithmetic and the view transform normalize 8/16/32-bit integer
operations and `f32` results. `f64` uses double precision. `idiv` truncates
toward zero; `idiv` and `imod` return zero for a zero divisor. Float-to-`i32`
conversions saturate at its limits, and NaN becomes zero.

**64-bit integer storage does not provide full-range guest integer precision.**
Guest numeric values use the execution engine's number representation. Above
the safe integer range, `i64`/`u64` results can lose precision. Model `i64`
arithmetic produces a warning, or an error under `--strict`; that diagnostic
does not cover every `u64` operation. A successful strict check does not prove
full-range 64-bit parity.

`Px` describes dimensions and spacing, `Deg` angles, `Ms` durations and `f32`
dimensionless values. A value with a different unit is rejected. `Color`
accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, compares color bits and
formats as lowercase `#rrggbbaa`; it has no arithmetic or ordering operations.

`String(value)` and display helpers use the defined scalar formatting rules.
`fixed(value, digits)` follows `Number.toFixed` formatting in guest and native
output, with `digits` in `0..100`. It formats the stored binary floating-point
value, not an exact decimal quantity. Its reference-player limitation is
listed [below](#current-implementation-limits).

## View and model expressions

The view column covers template/JSX binding expressions. View setup, event
handlers, `:style`/`style` objects and slot syntax have designated forms in the
[Vue reference](/docs/microts-reference/) and
[Solid guide](/docs/microts-solid/).

| Form | AOT view binding | Compiled model body |
|---|---|---|
| Literals, typed reads, struct fields | Supported | Supported |
| Arithmetic, strict comparison, ternary | Supported with typed operands | Supported with typed operands |
| `&&`, `\|\|`, `!`, conditions | Boolean values required | Boolean values required |
| `??` | Optional left operand | Optional left operand |
| String construction | Template strings; `+` is numeric | Template strings and string `+` |
| Object and array literals | Not general binding expressions | Typed struct/union and homogeneous array literals |
| Object/array equality | Compare scalar fields or keys | `equals(a, b)`; `===`/`!==` are for primitive values |
| Integer bit operations | Unsupported | `&`, `\|`, `^`, `<<`, `>>`; see limits below |
| Model function calls | Read-only binding methods; derived view-local expressions cannot call model methods | Named admitted functions and standard functions |
| Optional property access | Supported for optional contract objects | See the current optional-chain limitation below |
| Arbitrary prototype methods, `.length`, `Math.*` | Unsupported | Use the standard functions below |
| Functions stored or returned as values | Unsupported outside designated view callback/slot forms | Unsupported; designated inline callbacks only |

Conditions do not use truthiness: write `len(rows) > 0`, not `if (rows)`.
Template text accepts scalar values and optional scalars; absent optional text
renders empty. Format an object or array through a scalar field or model method.

Model literals do not support object spread, object methods/accessors, array
spread or array holes. An empty array needs an element type from its context.
Model `as T` and angle-bracket assertions still check the expression against
`T`; they cannot bypass a numeric mismatch. `as const` retains the inner
expression check. Model non-null assertions (`!`) and `satisfies` expressions
are outside the subset.

### Collections and indexing

| Function | Model behavior |
|---|---|
| `len(xs)` | Array element count, or Unicode code point count for a string |
| `map(xs, fn)` | New array of callback results |
| `filter(xs, fn)` | New array of elements whose predicate is true |
| `find(xs, fn)` | First matching element or `undefined` |
| `some(xs, fn)` | Whether an element satisfies the predicate |
| `copy(value)` | Owned copy of an array or contract value |
| `equals(a, b)` | Content equality for supported values |
| `min`, `max`, `abs`, `clamp` | Typed numeric operations |
| `trunc`, `floor`, `ceil`, `round`, `idiv`, `imod`, `fixed` | Numeric conversion, arithmetic and formatting described above |

**Use `map(xs, fn)`, not `xs.map(fn)`.** The same rule applies to `filter`,
`find`, `some` and `len`: `.filter`, `.find`, `.some`, `.length`, `.push` and
`.sort` are not model APIs. `len("😀")` is `1`; `len("e\u0301")` is `2`.
That count differs from UTF-16 length, grapheme count and a `Cap<string, N>`
byte capacity.

Dynamic view array indexing produces an optional value; guard it or use `??`.
A literal index into a compile-time constant array can fold to a scalar.
Model array indexing produces the element type. A constant index outside a
known bound is rejected. For scalar and plain struct elements, a dynamic
out-of-range model read uses the type's default value (`0`, `false`, `""`, or
default fields); an out-of-range write is ignored after evaluating the index
and right side. Guard dynamic accesses with `index >= 0 && index < len(xs)`
when absence matters. Compound-element limitations are listed below.

## Model modules and imports

| Form | Admission rule |
|---|---|
| Named imports, including aliases | Framework APIs listed below, or functions/constants from a pure module |
| `import type` | Types must resolve to supported contract shapes when used |
| `interface`, `type`, enums with constant string/integer members | Define supported types or enum values |
| Module `const` | Literal, constant, or object/array literal made from constant values |
| Module `let` | Private region field with an admitted seed |
| State, memo and effect declarations | Framework forms listed below |
| Named `function` / `async function` | Rules in the following sections |
| Factory function | Declares a child's region and returns an object naming its public bindings |
| `createNodeRef()` | Mount-owned animation target slot |
| `createContext()` | Solid view context key |

Model modules reject classes, `namespace` declarations, generators, default
exports, re-exports other than `export * as name` (and type-only ones),
side-effect imports, default value imports, namespace imports of framework
modules and dynamic `import()`. A view component's required default export is a separate frontend
rule. Model top-level executable statements are limited to admitted reactive
registration forms; arbitrary startup calls belong in model methods/hooks.

| Import source | Compiled model API |
|---|---|
| `solid-js` | `createSignal`, `createContext`, `batch`, `untrack` |
| `@pocketjs/framework/solid/reactive` | `createMemo`, `createEffect`, `on` |
| `vue` | `ref`, `computed` |
| `@pocketjs/framework/vue-vapor/reactive` | `watch`, `watchEffect` |
| Framework `solid/std` or `vue-vapor/std` | The numeric, collection, ownership and task functions listed on this page |
| `@pocketjs/framework/input` | `BTN` constants |
| `@pocketjs/framework/animation` | `createNodeRef`, `animate`, `jump` |
| Relative pure module | Named functions and constants; no model state or host access |

Every reachable module's top level is checked, including a module imported
for one constant. A pure helper takes its data through parameters. Another
model's signals are reached through props, events or context, not by importing
them into a model module. [State modules](#imperative-code) share
top-level `let` fields with the modules that import them.

## Functions and callbacks

**Model functions use named declarations with fixed parameter lists.**
Each parameter has a simple name and an explicit supported type. Parameter
destructuring, optional and rest parameters, function type parameters and
generators are not supported; a trailing parameter may default to a literal or
constant (see [Imperative code](#imperative-code)). Return types are
inferred from the body's return statements, including those in loops and
`switch` cases; a function that returns a value returns one on every path,
unless its return type includes `undefined`, which it returns at its end.
Annotate public signatures.

Functions of a model can read and update that model. Imported pure functions
cannot read model state, emit host commands or start tasks. Calls evaluate
arguments once, left to right, with value ownership rules. Recursion is
admitted; development builds enforce `app.recursionLimit` (default `256`).
Release builds omit that depth guard.

Inline arrows are accepted only where the compiler knows their call sites:

| Position | Callback restriction |
|---|---|
| Functional signal setter | One previous-value parameter; returns the replacement value |
| Memo/effect and `on` | The framework's declared reactive form |
| `batch` / `untrack` | Inline callback; `untrack` is admitted inside effects |
| `until` | Zero-parameter expression predicate |
| `map`, `filter`, `find`, `some` | Expression body; at most element and index parameters |
| View callback or slot | The view's declared event/slot contract |

These callbacks may capture admitted model values. They do not provide
general closure values: a model cannot store, return or pass a function to an
arbitrary higher-order function.

```ts
import { createSignal } from "solid-js";
import { map, type i32 } from "@pocketjs/framework/solid/std";

export const [items, setItems] = createSignal<i32[]>([1, 2]);

export function increment(): void {
  setItems(map(items(), value => value + 1));
}
```

## Model statements

| Statement | Restriction |
|---|---|
| `const x = value`, `let x: T = value` | Simple local name and initializer; one numeric type throughout the scope |
| Assignment and admitted arithmetic/integer compound forms | Local, private field or owned value; types must agree |
| `i++`, `--i` as statements | Numeric local or private field |
| Signal setter / Vue `.value = value` | Admitted signal write; computed values are read-only |
| `if` / `else` | Boolean condition |
| `return value` | Returns from its enclosing function or admitted callback |
| `for (let i = start; i < bound; i++)` | The same counter, `<` or `<=`, incremented by `i++` or `++i` and not assigned in the body; bound evaluated before the loop |
| `for (const item of xs)` | Array iteration with one simple local binder, over the array as it was before the first iteration |
| `switch` | Number/string/enum cases; each case ends with a direct `break` or `return`; put `default` last |
| `batch(...)`, `untrack(...)` | Declared callback forms; a batch does not create another instant |
| `console.log(...)` | Displayable arguments; development emits a host log command, release omits the command |
| Task call, `await`, `cancel` | Rules in the task section below |

`for-in`, `for await`, labels, `try`/`catch`/`finally`, `throw` and arbitrary
statement forms are unsupported. Synchronous functions also admit `while`,
`do`, `break`, `continue` and other `for` loops; see
[Imperative code](#imperative-code). Switch cases cannot fall through; current
lowering does not enforce enum exhaustiveness or duplicate-case diagnostics.

```ts
import { createSignal } from "solid-js";
import { copy, len, type i32 } from "@pocketjs/framework/solid/std";

export const [items, setItems] = createSignal<i32[]>([2, 4]);

export function increment(): void {
  const next = copy(items());
  for (let i = 0; i < len(next); i++) {
    next[i] = next[i] + 1;
  }
  setItems(next);
}
```

The copy is required because a non-primitive signal read is an immutable
view. A local that owns the copy can mutate its fields or elements. Values
that survive an `await` become owned snapshots. See
[model value rules](/docs/microts-model/#values-and-bounds).

## Reactive state and regions

Solid models use `createSignal` from `solid-js`; compiled memos and effects
come from `@pocketjs/framework/solid/reactive`. Vue models use `ref` and
`computed` from `vue`, with `watch` and `watchEffect` from the framework's
Vue reactive module. Importing stock Solid `createMemo`/`createEffect` into a
compiled model is rejected. A view-local Solid `createMemo` remains a view
expression expansion and follows the [view rules](/docs/microts-solid/#components-and-expressions).

Signal seeds use admitted constant expressions, or factory parameters for a
child region. A memo reads signals, memos, constants and pure computations;
it cannot read a private mutable field or perform a state/host write.

An inferred effect must subscribe to the same signals/memos on every control
flow path. Use `on([dependencies], callback)` when subscriptions must be
declared. The dependency schedule must be acyclic. The framework runs the
reaction and settles memo caches at frame boundaries; stock framework effect
scheduling does not define compiled model behavior.

The root module owns one region. Each factory mount owns another, with fresh
state on remount and task cancellation on unmount. Mount-time arguments seed
the factory once; prop updates do not reseed it. The
[model guide](/docs/microts-model/#reactions-and-cached-values) defines
dispatch reads, changed flags and lifecycle rounds.

## Async tasks and host services

**`async` functions compile into task state machines.** A task call runs its
first segment in the caller's phase; later segments resume from a boundary
readiness snapshot. `await` occurs as a statement or local initializer inside
an async function, not inside a memo or effect.

| Awaitable | Result or condition |
|---|---|
| `frames(n)` | Frame count reached |
| `after(ms)` | Virtual clock deadline reached |
| `until(() => condition)` | Boolean predicate true at the boundary |
| Named async model call | Child task result; child cancellation cancels the awaiter |
| `join(task())` | `done` with its value, or `cancelled` |
| `all([a, b])` | All results, in member order |
| `any([a, b])` | First ready member; ties choose the lower member index |
| `animate(ref, property, value, options)` | `ended`, `replaced` or `dropped` |

`all` and `any` require a nonempty literal list of admitted awaitables.
`cancel(load)` cancels that function's live task in its region. Starting the
same function again cancels its previous call. Task-start cycles are rejected;
ordinary synchronous recursion has the separate depth rule above.

`Promise<T>` describes a task result; it is not a general promise object.
Arbitrary promises, `.then`, native `fetch` and timers such as `setTimeout`
are not model APIs. The framework ships no model service adapter: a service
module ends in `/model`, and a TypeScript declaration alone is not enough to
admit one. A native host must provide its transport and typed deliveries. See
[the host boundary](/docs/microts-boundaries/#a-task-requests-work-the-host-performs-it).

## Imperative code

Compiled models also admit the imperative forms below: state shared between
modules, loops, in-place array operations, numeric conversions and float math.
Native AOT hosts compile them to Rust; guest builds lower the same Model IR to
JavaScript, and the reference interpreter executes it.

| Form | Rule |
|---|---|
| State modules | A module with top-level `let` fields, or one importing such a module, is a state module. Its fields and functions belong to the root region. Only the root and other state modules import it; factories do not. Exported fields are readable and writable in place by importers, and the native model exposes them as `<module>_<name>()` and `<module>_<name>_mut()`, where `<module>` is the file name; two state modules cannot export fields with the same accessor name |
| Assignable places | `a[i] = v`, `a[i].x += v`, `s.items[j]++` on locals and fields, including imported state fields. A write evaluates its index operands, then its value, then reads its target place, so a value that replaces the target's array writes into the new one; an out-of-range element write is ignored after its operands are evaluated |
| Loops | `while`, `do`-`while`, `break`, `continue` and `for` loops with any condition and update, in synchronous functions. `for (let i = a; i < b; i++)` whose body does not assign `i` keeps its bound-once rule; other `for` loops re-evaluate their condition and run their update after `continue` |
| Operators | `%` on numbers (an integer remainder by zero is `0`), `~` and `>>>`. Shifts of 8- and 16-bit integers run on 32-bit values, as in JavaScript, and wrap the result to the operand's width; `>>>` reads the operand as unsigned in its width |
| Numeric conversion | `i8()` … `u64()`, `usize()`, `f32()`, `f64()` from the std module, with Rust `as` semantics on the argument's static type: a float truncates toward zero and saturates, an integer wraps. `usize()` converts as `u32` on every target |
| Float math | `sqrt`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `exp`, `log`, `atan2`, `pow`, `hypot` on `f32` or `f64` |
| Arrays | `fill(n, v)` allocates; `push`, `pop`, `insert`, `removeAt`, `clear`, `truncate`, `fillRange`, `copyRange`, `fillRect` and `copyRect` change an assignable array place, which they read after evaluating their arguments. `copyRange` takes numeric, boolean or enum elements, clips its window to both arrays and, given a sixth argument, leaves target elements in place where the source holds that value. `fillRect` and `copyRect` do the same for each row of a rectangle in arrays laid out in rows (`start + row * stride`); `copyRect` reads every source row before writing. `fillRange` and `fillRect` store a copy of the value in each element, a negative `truncate` length empties the array, and `pop` or `removeAt` outside the array returns the element type's default. `Cap` arrays do not admit `push`, `insert`, `removeAt` or `truncate`; a value stored into `Cap` elements, such as a string pushed onto a `Cap<string, 3>[]`, is bounded like any other `Cap` write, and so is the result of `fill`, `codePoints`, `embedBytes` or `fromCodePoint` in a `Cap` place. Loops that only read `rows[i][j]` with `i` fixed borrow the row once |
| Constants | A module constant holding an array literal of numbers, booleans or enums is stored once as a static; `embedBytes("./file.bin")` embeds a file as a `u8[]` static |
| Strings | `codePoints(s)` and `fromCodePoint(n)` |
| Parameter defaults | `function f(a: i32, b: i32 = -1)`: a call may omit trailing parameters whose defaults are literals or constants. Awaiting an async function passes every argument |
| Imports | `paths` of the nearest `tsconfig.json` in or above the entry's folder map non-relative specifiers to local modules |
| Namespaces | `export * as name from "./module"` and `import * as name from "./module"` name a local module; `name.member` reads, assigns or calls its exports, nested namespaces included. Namespaces resolve at compile time and cannot be stored or passed |

Element and member reads of fields, locals and constants, including nested
arrays such as `rows[i][j]`, index the stored value in place; they do not copy
the array. When an index calls a function, the array is read before the index,
as in JavaScript.

## Current implementation limits

The following combinations are not portable Model AOT forms. Some pass the
frontend but fail native generation/type checking or reference replay.

| Combination | Current limit and supported approach |
|---|---|
| Model optional property chains such as `value?.count` | Optional-result typing is incomplete; use an explicit presence guard and property read |
| Model `>>>`, unary `~`, or floating-point bit operations | Use supported integer `&`, `\|`, `^`, `<<`, `>>`; frontend acceptance does not establish native support for the other forms |
| Model `switch` with `default` before later cases | Put `default` last; current lowering does not preserve a middle default |
| Inferred return type from `switch` branches | Annotate the function's return type |
| Model indexing of arrays with optional or fixed-array elements | Native result/default typing is incomplete; use scalar/plain-struct indexed elements and explicit bounds checks |
| Heterogeneous tuple construction/indexing in a model | Contract tuple support does not provide general tuple-expression support |
| `fixed` in the reference interpreter | Guest/native formatting exists, but the reference player's builtin handler is missing; a tape using it cannot be replayed there |
| Full-range `i64`/`u64` guest arithmetic | Engine number precision remains a limit; `--strict` is not a proof of 64-bit parity |

## Checking an application

Run admission and then compile the generated native source:

```sh
bun microts/compiler/cli.ts check solid-aot-lab --strict
bun microts/compiler/cli.ts build solid-aot-lab --strict
cargo check --locked --manifest-path apps/solid-aot-lab/Cargo.toml
```

`check` reports frontend admission diagnostics with source locations. `build`
emits the view, model and styles; Cargo checks the native types and trait
implementations. Demo `gen/` directories are ignored by Git and must be
generated before Cargo. A successful frontend check alone does not establish
support for the combinations in the limits table.

Browser/guest and native builds use the selected presentation's component
graph. Native host capabilities remain a separate check: a model can compile
without a network transport, and the default host returns `unavailable`.
Neither TypeScript admission nor board input admission supplies a device
driver or proves on-device timing.
