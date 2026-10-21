# Minimal Nintendo 3DS program

**This program links the default Runtime archive and the generated C QuickJS guest.**
It registers the PICA renderer, a 400×240 primary display, a 320×240 auxiliary
display and the shared 3DS input source. `products/3ds` owns Link, the launcher,
camera, development server, media worker and recovery state.

`main.c` opens the first command-line argument as a package file. Without an
argument it opens `romfs:/app.pocket`. `package_source.c` supplies bounded range
reads to the Runtime; the Runtime verifies the package, profile and plan before
initializing the guest. The file stays open until Runtime destruction. Changed
file lengths, short reads and I/O failures return errors. **No product package
parser or recovery inspection code is linked.**

The `3ds-runtime` profile supplies eight capabilities: buttons, both analog
sticks, cursor, auxiliary touch, auxiliary display, baked glyphs and physics.
The platform HID driver supplies input facts without reserving product chords.
This program uses L+R+START to exit; the product's reload and menu chords remain
in `products/3ds/src/input_policy.c`.

```sh
# Build a generic runtime; the source checkout and pinned toolchains are required.
bun tools/pocket.ts build --target 3ds --generic --out .pocket-build/3ds-runtime
# Compile an application that accepts the minimal profile.
bun tools/pocket.ts compile --runtime-config programs/3ds/pocket.runtime-config.ts \
  --manifest apps/3ds-demo/pocket.json --output .pocket-build/app.pocket
# Preserve native code and replace the SMDH and RomFS application.
bun tools/pocket.ts pack --runtime .pocket-build/3ds-runtime \
  --pocket .pocket-build/app.pocket --id dev.example.app --title App \
  --author Example --version 1.0.0 --out .pocket-build/app.3dsx
```

`tools/build/3ds/native.ts` supplies the pinned Rust build-std compiler and
containerized devkitARM build. The minimal program and product have separate
Makefiles, source lists and archives. The compatibility entry
`tools/runtime.ts 3ds` builds this program; `tools/3ds.ts` selects the product.

**Host contract tests use the actual Runtime and Bellard guest.** They cover
range reads, profile rejection before guest initialization, truncated files,
input, repeated instance destruction and allocator balance. Native validation
builds both programs and checks that the minimal ELF excludes product symbols.
`tests/e2e/3ds-repack.ts` launches the repacked program in Azahar and verifies
native screenshots; host contract success does not imply emulator acceptance.
