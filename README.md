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

---

## v0.3.0 — Production Applets + Network

### What's new

- **HTTP transport** (NSURLConnection, TLS 1.2) — Rust pocket-net + ObjC bridge
- **Worker domain** (runtime.worker + net.http) for production applets
- **10 production applets** compiled for 768x1024 touch-primary
- **19 total applets** (9 shell + 10 production)

### Production Applets

| Applet | .pak | .js |
|--------|------|-----|
| Hacker News | 161 KB | 261 KB |
| YouTube | 207 KB | 304 KB |
| GitHub | 402 KB | 419 KB |
| X (Twitter) | 213 KB | 341 KB |
| Discord | 207 KB | 328 KB |
| Weather | 470 KB | 327 KB |
| Maps | 263 KB | 295 KB |
| Podcasts | 208 KB | 332 KB |
| Notes | 257 KB | 288 KB |
| Home Assistant | 259 KB | 309 KB |

### Shell Applets

ipad2-clock, ipad2-demo, note, hero, launcher, settings, gallery, cards, stats

### Build applets

    bun tools/build.ts hn
    bun tools/build.ts youtube
    bun tools/build.ts github
    bun tools/build.ts x
    bun tools/build.ts discord
    bun tools/build.ts weather
    bun tools/build.ts maps
    bun tools/build.ts podcasts
    bun tools/build.ts notes
    bun tools/build.ts homeassistant

### Deploy

    bun tools/ipad2.ts deploy
    bun tools/ipad2.ts launch
