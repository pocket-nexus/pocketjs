# PocketJS — iPad 2,2 (A1396)

Fork of [pocket-nexus/pocketjs](https://github.com/pocket-nexus/pocketjs) with a working iPad 2,2 / iOS 6.1.3 target.

## Result

- 60 fps, 42 flexbox nodes, 9 GL draws/frame
- QuickJS + Taffy + Rust + GL ES 2.0
- Touch events working
- Ad-hoc signed (ldid), no jailbreak required

## Closes

[pocket-nexus/pocketjs#517](https://github.com/pocket-nexus/pocketjs/issues/517)

## What was needed

1. **Mach-O dylib stubs** for the sysroot (UIKit, Foundation, CoreGraphics, OpenGLES, libobjc, libSystem, libgcc_s)
   - `cputype=12` (ARM), `cpusubtype=9` (ARMv7), `filetype=6` (MH_DYLIB)
   - Load commands: `LC_SEGMENT` + `LC_VERSION_MIN_IPHONEOS` + `LC_SYMTAB` + `LC_DYSYMTAB` + `LC_ID_DYLIB`
2. **`-undefined dynamic_lookup`** in ld-classic flags (tools/ipad2.ts)
3. **Post-link version patch** — ld-classic injects `compat_version=29561.83.47` into `LC_LOAD_DYLIB`. dyld on iOS 6 rejects it. Patched to `1.0.0` post-link.
4. **`ldid -S`** to re-sign after the patch.

## Build

    bun tools/ipad2.ts build
    # + version patch
    # + ldid -S
    ideviceinstaller install dist/ipad2/PocketJSiPad2.app

## Hardware

| | |
|---|---|
| Device | iPad 2,2 (A1396) |
| OS | iOS 6.1.3 (10B329) |
| CPU | Apple A5 (dual-core ARMv7) |
| RAM | 512 MB |
| GPU | PowerVR SGX543 (GL ES 2.0) |
