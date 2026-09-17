# Pocket Micro

Pocket Micro compiles a PocketJS Solid application written in **Micro TS** — a
statically shaped subset of TypeScript, Solid and the `@pocketjs/framework`
component API — to one Rust module over `pocketjs-core`. The output links
into a PSP EBOOT that contains **no JavaScript engine**. The proof target is
`apps/hero`, compiled from `apps/hero/main.tsx` and `apps/hero/app.tsx`
unchanged. Design, subset and results: [DESIGN.md](DESIGN.md).

```
bun micro/compiler/cli.ts check hero          # subset diagnostics + plan
bun micro/compiler/cli.ts ir hero             # the Micro IR as JSON
bun micro/compiler/cli.ts build hero          # dist/micro/hero/{app.rs,app.ir.json,hero.pak,styles.bin,manifest.json}
bun micro/compiler/cli.ts build hero --psp --release [--tape "0:0,5:64,6:0"]
                                              # + hosts/psp-micro/target/mipsel-sony-psp/release/{pocket-micro-psp.prx,EBOOT.PBP}
bun micro/tests/parity.ts hero                # byte parity against a fresh Solid oracle (wasm core)
bun micro/scripts/psplink.ts <prx> [--port 10000 --host0 <dir>]
                                              # run on a PSP over PSPLINK; collects receipt + screenshot
bun run micro:test                            # compiler tests + the parity test
```

Layout:

| path | role |
|---|---|
| `micro/compiler/frontend.ts` | Micro TS → Micro IR (TypeScript compiler API, file:line:column diagnostics) |
| `micro/compiler/ir.ts` | the IR: typed expressions, statements, template nodes, bindings with signal dependency sets |
| `micro/compiler/emit-rust.ts` | Micro IR → `pub mod app` against the `pocket-micro` runtime |
| `micro/compiler/assets.ts` | styles.bin, font atlases, images and sprite atlases for the IR's literals, packed as the app `.pak` |
| `micro/compiler/cli.ts` | `ir` / `check` / `build [--psp]` |
| `engine/crates/pocket-micro` | the `no_std` runtime: root layers, focus, press dispatch, flush contract, number formatting, pak feeder |
| `hosts/psp-micro` | the PSP EBOOT (lone cargo-psp crate) |
| `micro/harness` | desktop harness: generated module + core + software rasterizer, frame dumps for parity |
| `micro/tests` | compiler tests, the Solid oracle, the parity test |

Nothing generated is committed. Every artifact is a pure function of the app
sources and this compiler, so it is built on demand into ignored `dist/micro/
<app>/`. What guards the emitter is `micro/tests/parity.test.ts`, which
compiles its output with cargo and compares rendered pixels against stock
Solid, plus the emitter assertions in `micro/tests/compiler.test.ts`.
