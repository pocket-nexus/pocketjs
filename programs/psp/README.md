# PocketJS for PSP

**`pocketjs-psp` is a library crate and the stock program binary.** The
binary (`src/main.rs`) runs one application: the bundle it embeds, or
`app.pkb` beside the EBOOT in the generic runtime (cargo feature `runtime`).
A guest that fails to start halts with its error on the debug screen.

```sh
bun tools/psp.ts hero --release   # target/mipsel-sony-psp/release/EBOOT.PBP embeds dist/hero-main.pkb
bun tools/runtime.ts psp          # dist/runtime/psp/EBOOT.PBP reads app.pkb beside it
```

`pocket target add psp` installs the pinned Rust nightly, cargo-psp, the PSP
SDK and the prebuilt QuickJS archive; the guest bridge also needs LLVM `clang`
and `llvm-ar` with the MIPS backend (`POCKETJS_LLVM_BIN`).

## Program binaries

**`src/main.rs` declares the module with `module!` and calls `frame::run`
once.** The library holds the blocks a PSP program composes:

- `module!(name, entry)` declares the PSP module. The main thread records the
  EBOOT's path, and `frame::start` sets the clock to 333 MHz, initializes
  graphics and the controller, then calls `entry` on a **1 MiB** QuickJS
  worker thread.
- `frame::run(source, Options, &mut impl frame::Program)` boots one guest
  from a `PackageSource` and runs its frames: controller, guest turn,
  collection on arena pressure, paced present. Trace (`POCKETJS_TRACE`),
  benchmark (`bench`) and capture (`capture`) builds hook the same loop, and
  the capture frame index runs across every guest of the process. `run`
  returns the program's exit value after it drops the runtime, or the error
  of a guest that failed to start.
- `frame::Program` is what a program decides per guest, in this order:
  - `configure(&mut Runtime)` runs after `Runtime::new` and before boot.
  - `globals(context, global)` runs once while the guest boots: after the
    generated bindings created `ui` and the library mounted its namespaces,
    before the bundle evaluates. The program installs its own native globals
    there (`service_bindings::add_fn`, `libquickjs_sys` re-exported as
    `pocketjs_psp::libquickjs_sys`).
  - `buttons(u32)` filters the buttons the guest receives each frame.
  - `commit(&mut Ui)` runs inside `Runtime::present` with the core guard
    held, after the video plane's commit and before the frame's list is
    encoded. A texture the program updates there (`Ui::update_texture_t8`)
    shows in that frame; the core keeps the storage a list in flight samples
    until that list retires.
  - `end_frame(&mut Runtime)` runs after each frame's list is kicked and ends
    the guest by returning a value.
- `Runtime::boot(globals)` and `Runtime::present(commit)` take the same two
  hooks as closures for a program that drives a `Runtime` without
  `frame::run`.
- `with_ui(context, f)` runs `f` on the `Ui` of the guest that owns
  `context`, from inside a native function the program installed; a
  function that returns a texture handle uploads it this way.
- `Options::cadence` presents the guest at a rate that divides the package's
  tick rate, at most **60** core ticks per frame; `None` keeps the rate the
  runtime selects from the profile. `Options::data_name` names the guest's
  `fs` directory under `ms0:/PSP/SAVEDATA/POCKETJS/`; `None` uses the
  embedded application's output name, or in the generic runtime the name of
  the EBOOT's directory. `Options::devtools` (default true) lets the guest's
  boot probe the DevTools mailbox when no guest before it did; the mailbox's
  polls are main-thread `host0:` I/O, so a program whose own transport uses
  the PSPLINK share sets it false.
- `Runtime::add_provider` answers operations the library does not implement.
  The library answers ops **30 to 38**; an operation two providers support is
  refused. Op dispatch receives the guest's `Ui`, so a provider uploads
  textures into that guest (`Ui::upload_texture_flags`).
- `audio` is the PCM output the video plane feeds (one 44.1 kHz channel, a
  single-writer ring): a program's own worker thread may feed it while no
  video plane is open.
- `Runtime::complete` shows the frame in flight with the GE idle, and
  `host::read_display_rows_rgba` reads the displayed frame back. After `run`
  returns, no list is open: a program draws on the GE through
  `host::list_ptr()` and `psp::sys` (re-exported as `pocketjs_psp::psp`)
  before it boots the next guest.
- `embedded::BUNDLE` and `embedded::OUTPUT` are the bundle build.rs embeds
  from `POCKETJS_EMBED_BUNDLE` and its output name; `embedded::source()` is
  that bundle, or `app.pkb` in the generic runtime.

**A binary crate in another repository depends on `pocketjs-psp` by path and
writes its own entry over the same blocks.** Its features `capture`, `bench`
and `runtime` forward to the library's. `buildPspProgram()` in
`tools/psp.ts` builds such a crate: `PspProgram` names its directory, its
package (the binary carries the same name), the variables its own build
script reads and an XMB `Psp.toml` in place of the application's.
`PspProgramBuild.profile` is the profile the program exports and admits
packages against: `psp`, `psp-runtime`, or the crate's own host contract of
platform `psp` with its own id and capabilities. The application passed to
the build is the one the library embeds; a program that carries more bundles
embeds them from its own build script. Switching between applications on the
device, Pocket Link over the PSPLINK share (`globalThis.link`) and companion
media playback (`globalThis.media`) belong to such a crate in
[pocket-nexus/pocket-shell](https://github.com/pocket-nexus/pocket-shell);
the stock program starts no link worker and reads nothing under
`host0:/pocket-link/`.
