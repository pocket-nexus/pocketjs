# Minimal Nintendo 3DS program

**This program composes through the QuickJS facade
(`programs/native/quickjs/pocket_qjs_program.h`) over the native program built
with `host-backend,host-hooks`.** The native program registers no renderer or
display, and `platforms/3ds/hooks.c` supplies the six `pocket_host_*` hooks. The
facade's `compose` callback registers the PICA renderer, a 400×240 primary
display, a 320×240 auxiliary display and the shared 3DS input source; the guest
is the generated C QuickJS guest in a JavaScript context `main.c` creates.
The Nintendo 3DS product host (Link, the launcher, camera, media worker and
recovery state) lives in pocket-nexus/pocket-shell (`devices/3ds`).

`main.c` opens the first command-line argument as a bundle file. Without an
argument it opens `romfs:/app.pkb`. `package_source.c` supplies bounded range
reads; `pocket_qjs_program_boot_source` hands the source to the Runtime, which
verifies the bundle, binding generation and plan before initializing the guest. The
file stays open until the program is destroyed. Changed
file lengths, short reads and I/O failures return errors. **No product container
parser or recovery inspection code is linked.**

The `3ds-runtime` host contract supplies eight capabilities: buttons, both
analog sticks, cursor, auxiliary touch, auxiliary display, baked glyphs and physics.
The native program installs `pocket-physics`. The platform HID driver
(`platforms/3ds/input.c`) supplies input facts and reserves no chord.
This program uses L+R+START to exit. The SMDH icons are `platforms/3ds/icon.png`
and `platforms/3ds/icon-small.png`, which `bun tools/device-icons.ts` writes
from the SVG files beside them.

```sh
# Build a generic runtime; the source checkout and pinned toolchains are required.
bun tools/pocket.ts build --target 3ds --generic --out .pocket-build/3ds-runtime
# Compile an application whose host config lists the 3ds-runtime host contract.
bun tools/pocket.ts compile --config apps/3ds-demo/pocket.host.config.ts \
  --target 3ds-runtime --project-root . --output .pocket-build/app.pkb
# Preserve native code and replace the SMDH and RomFS application. The id,
# title and version default to the bundle's plan; --id must equal its app id.
bun tools/pocket.ts pack --target 3ds --runtime .pocket-build/3ds-runtime \
  --bundle .pocket-build/app.pkb --author Example --out .pocket-build/app.3dsx
```

`tools/build/3ds/native.ts` supplies the pinned Rust build-std compiler and
containerized devkitARM build. The compatibility entry
`tools/runtime.ts 3ds` builds this program.

**The native host tests use the actual native program, facade and Bellard
guest.** `bun tools/test-3ds-minimal.ts` builds `tests/fixtures/3ds-minimal/runtime.c`
with the composition of `main.c`, a counting CPU renderer and two CPU displays in
place of PICA. They cover range reads, host contract rejection before guest initialization, truncated
files, input, repeated instance destruction and allocator balance. Native validation
(`.github/workflows/3ds-runtime.yml`) builds the program and checks with
`tools/check-3ds-symbols.ts` that its ELF defines no product symbol.
`tests/e2e/3ds-repack.ts` launches the repacked program in Azahar and verifies
native screenshots; native host test success does not imply emulator acceptance.
