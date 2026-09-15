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

`check --boards` reports the input demands against the existing board
profiles. `--board <name>` selects a profile and fails on missing input
adapters; `build --board <name>` checks before writing generated files.
These profiles describe input coverage. They do not certify a Rust toolchain,
display size or native core port. The current ESP32 profiles have no
relative-axis adapter, so an AxisHandler produces `VB104` for those profiles.

**Generated Rust and its style table are application source assets.** Keep
them in Git with the Rust implementation. Device builds consume these files
through Cargo and need no Bun or `build.rs` generator.

The feature lab has two view-model implementations:

- `apps/vue-sfc-lab/app.ts` exports Vue refs, a computed value and a method for
  browser and QuickJS builds.
- `apps/vue-sfc-lab/src/lib.rs` implements the generated `AppViewModel` trait
  and exposes `LabApp` to native hosts.

The root component imports its view model from `./app`. Pure children use
props, emits, models and slots. A stateful child destructures a zero-argument
factory from its basename module. `FeatureToggle.vue` uses this form to keep
an activation count per mounted instance. Its Rust model implements the
generated child trait and `Default`; the parent's trait selects that model
through an associated type. The compiler checks both implementations'
shared TypeScript contract when compiling the SFC for AOT. Browser and guest
builds run the same admission pass for roots that import their basename
contract. Legacy SFCs without this contract retain their current Vue pipeline
during migration.

A Rust-only app can provide `app.d.ts` in place of `app.ts`. Browser and guest
builds supply Vue refs with defaults from the declaration types: zero, empty
strings, empty arrays, false, absent optional values and the first enum
variant. Factory previews create fresh refs on each call, and optional
functions remain absent. Functions return the default for their return type. These defaults
provide a preview; the application logic remains in Rust. A component with
both module forms is rejected.

**A host calls `LabApp::frame` once per tick.** The frame resolves input,
dispatches the selected handler and evaluates bindings if state was
invalidated. A host that edits `LabApp::model` between frames calls
`invalidate()`. The host draws through `app.ui_mut().core_mut()` using the existing
core rendering path. Fonts and image textures are host resources; load font
atlases into the core and register image names through `Ui::register_image`
before mounting views that consume them.

**The compiler generates `<Name>App<M, H>` with the frame loop.** Its constructor
takes a host, the root props and the application's view model. `set_props`
replaces borrowed root props and schedules an update. `invalidate` schedules
an update after a host mutation. The feature lab wraps `AppApp<LabViewModel, LabHost>`
to load its styles and set its viewport before mounting.

**Host types declare the input channels they can deliver.** `Host` provides
`ui`, `ui_mut` and `into_ui`. `HasButton<MASK>` admits an ActionHandler's
named button; `HasRelativeAxis<ID>` admits an AxisHandler's axis. The feature
lab's `LabHost` declares CROSS and the primary relative axis. A host that
does not implement a demanded trait cannot construct the generated app.
`CoreHost` is a `Ui` with injectable button input; it grants no relative axes
or touch capability.

JavaScript hosts can pass `AxisDelta[]` as the seventh `globalThis.frame`
argument, or queue motion with `feedAxisDelta` from
`@pocketjs/framework/vue-vapor/input`. Deltas are signed i32 millidegrees.
An explicit array replaces queued motion; `[]` represents no motion. DevTools
records this channel in a sparse v4 tape track. Old tapes replay with no axis
motion. The simulation host accepts an axis array as its fourth `frame`
argument. Rust hosts use `Input::with_axis(id, delta)`.

The style contract uses `Px`, `Deg` and `Color`; `Ms` is available for
application signatures. Color display is lowercase `#rrggbbaa`, and Color
equality compares color values. Browser compilation inserts the required
normalization; ordinary string values retain their spelling.

The C cartridge compiler remains available through the existing `.tsx`
command. Rust AOT targets require a `pocketjs-core` build; GB, NES and GBA
cartridges use the retained C pipeline.
