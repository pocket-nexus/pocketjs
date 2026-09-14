# Building a Vue AOT application

**The compiler emits Rust from the template and TypeScript contract.** The
application supplies its Rust view model. The accepted language is defined in
[VUE_AOT.md](VUE_AOT.md).

```sh
bun install
bun vapor/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml
```

`build` accepts an app directory, an app name under `apps/`, or a root `.vue`
file. It writes Rust modules and `styles.bin` to the app's `gen/` directory.
`--out` selects another directory. `--ir` writes the analyzed View IR as JSON.
`--no-format` skips `rustfmt`; if the tool is absent, the compiler writes the
printer's output. `check` performs admission and type analysis without writing
generated files. `--strict` rejects unannotated `number` in contract positions.

**Generated Rust and its style table are application source assets.** Keep
them in Git with the Rust implementation. Device builds consume these files
through Cargo and need no Bun or `build.rs` generator.

The feature lab has two view-model implementations:

- `apps/vue-sfc-lab/app.ts` exports Vue refs, a computed value and a method for
  browser and QuickJS builds.
- `apps/vue-sfc-lab/src/lib.rs` implements the generated `AppViewModel` trait
  and exposes `LabApp` to native hosts.

The root component imports its view model from `./app`. Child components use
props, emits, models and slots. The compiler checks both implementations'
shared TypeScript contract when compiling the SFC for AOT. Browser and guest
builds run the same admission pass for roots that import their basename
contract. Legacy SFCs without this contract retain their current Vue pipeline
during migration.

A Rust-only app can provide `app.d.ts` in place of `app.ts`. Browser and guest
builds supply Vue refs with defaults from the declaration types: zero, empty
strings, empty arrays, false, absent optional values and the first enum
variant. Functions return the default for their return type. These defaults
provide a preview; the application logic remains in Rust. A component with
both module forms is rejected.

**A host calls `LabApp::frame` once per tick.** The frame resolves input,
dispatches the selected handler and evaluates bindings if state was
invalidated. A host that edits `LabApp::model` between frames calls
`invalidate()`. The host draws through `app.ui.core_mut()` using the existing
core rendering path. Fonts and image textures are host resources; load font
atlases into the core and register image names through `Ui::register_image`
before mounting views that consume them.

**The compiler generates `<Name>App<M>` with the frame loop.** Its constructor
takes a `Ui`, the root props and the application's view model. `set_props`
replaces borrowed root props and schedules an update. `invalidate` schedules
an update after a host mutation. The feature lab wraps `AppApp<LabViewModel>`
to load its styles and set its viewport before mounting.

The C cartridge compiler remains available through the existing `.tsx`
command. Rust AOT targets require a `pocketjs-core` build; GB, NES and GBA
cartridges use the retained C pipeline.
