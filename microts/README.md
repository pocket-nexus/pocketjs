# MicroTS

MicroTS is the ahead-of-time compiler for PocketJS applications. It compiles
Solid TSX and Vue SFC views to Rust through a typed View IR. With
`app.model: "compiled"` it also compiles the supported TypeScript model subset
to Rust through a Model IR. A native AOT build calls the retained UI core
**without a guest engine**; the host still owns input, services and
presentation.

**Status: in development.** The compiler builds the AOT lab in
[`apps/solid-aot-lab`](../apps/solid-aot-lab/). The
[TypeScript support reference](../site/content/docs/typescript-support.md)
lists the supported types, expressions, statements and APIs, and the current
implementation limits.

## Where the code lives

| Path | Contents |
| --- | --- |
| [`microts/compiler/`](./compiler/) | Solid and Vue front ends, the View IR and Model IR, admission checks, Rust code generation, the model fuzzers and the `cli.ts` entry point |
| [`engine/crates/microts/`](../engine/crates/microts/) | The `microts` crate that generated models and views link against |
| [`framework/src/std-microts.ts`](../framework/src/std-microts.ts) | The standard library a compiled model imports as `@pocketjs/framework/solid/std` or `@pocketjs/framework/vue-vapor/std` |

## Commands

```sh
bun microts/compiler/cli.ts build solid-aot-lab --strict
cargo check --locked --manifest-path apps/solid-aot-lab/Cargo.toml
bun run test:fuzz
```

`build` writes generated Rust into the application's ignored `gen/` directory,
so it must run before a Cargo build.

## Documentation

| Topic | Reference |
| --- | --- |
| Overview | [MicroTS](https://pocketjs.pocket.nexus/docs/microts/) |
| Ownership across the application, generated Rust and the host | [TypeScript and native code](https://pocketjs.pocket.nexus/docs/microts-boundaries/) |
| Execution modes and supported subset | [TypeScript support](https://pocketjs.pocket.nexus/docs/typescript-support/) |
| Compiled models | [TypeScript models to Rust](https://pocketjs.pocket.nexus/docs/microts-model/) |
| Views | [Solid TSX to Rust](https://pocketjs.pocket.nexus/docs/microts-solid/) · [MicroTS components](https://pocketjs.pocket.nexus/docs/microts-components/) |
| Reference | [MicroTS reference](https://pocketjs.pocket.nexus/docs/microts-reference/) |
