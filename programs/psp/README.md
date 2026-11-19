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
- `frame::Program` is what a program decides per guest. `configure` runs after
  `Runtime::new` and before boot, `buttons` filters the buttons the guest
  receives, and `end_frame` runs after each frame's list is kicked and ends
  the guest by returning a value.
- `Options::cadence` presents the guest at a rate that divides the package's
  tick rate, at most **60** core ticks per frame; `None` keeps the rate the
  runtime selects from the profile. `Options::data_name` names the guest's
  `fs` directory under `ms0:/PSP/SAVEDATA/POCKETJS/`; `None` uses the
  embedded application's output name, or in the generic runtime the name of
  the EBOOT's directory.
- `Runtime::add_provider` answers operations the library does not implement.
  The library answers ops **30 to 38**; an operation two providers support is
  refused. Op dispatch receives the guest's `Ui`, so a provider uploads
  textures into that guest (`Ui::upload_texture_flags`).
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
script reads and an XMB `Psp.toml` in place of the application's. The
application passed to the build is the one the library embeds; a program that
carries more bundles embeds them from its own build script. Switching
between applications on the device belongs to such a crate in
[pocket-nexus/pocket-shell](https://github.com/pocket-nexus/pocket-shell).
