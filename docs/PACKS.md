# Packs

A pack is a read-only file under the game data root, opened at runtime. Content in the app pak ships
inside the EBOOT and stays in memory for the life of the program: on PSP-1000, **EBOOT + arena is at
most about 20.8 MB**, and running out of arena stalls the program with no message. A pack file stays
on the memory stick until the guest reads the part it needs. `contracts/spec/pack.ts` is normative;
the capability id is `data.pack`, the namespace `globalThis.pack`.

## API

```ts
pack.open(path: string): number
// >= 0 a handle; -1 not found, invalid path or no free handle; -2 fetch in progress, call again next frame
pack.size(fh: number): number
// bytes, or -1 for a bad handle
pack.read(fh: number, offset: number, dst: Uint8Array): number
// fills dst or stops at end of file; returns the byte count, 0 past the end, -1 on error
pack.loadImg(fh: number, offset: number, length: number): number
// bytes [offset, offset+length) are one IMG entry; returns a texture handle or -1
pack.close(fh: number): void
pack.stats(): string
// one JSON line of diagnostic counters (PackStats in the spec)
```

Only the browser host returns -2. Write the retry on every host:

```ts
const fh = pack.open("ch01/tiles.pack");
if (fh === -2) return; // call again next frame
```

`loadImg` takes the layout `uploadImgEntry` takes (`framework/compiler/pak.ts`): `u16 w, u16 h, u8 psm,
u8 flags, u16 reserved`, then the payload. T8 with or without `IMG_FLAG_RLE`, 16-bit and 8888 all work,
as does `IMG_FLAG_LINEAR`. Release the texture with the ui op `freeTexture`. A stale or closed handle
makes every op return -1 and `close` a no-op.

A host without the module leaves `globalThis.pack` unset. `framework/src/game2d/music.ts` checks with a
live lookup and plays silence; an app reading packs itself checks the same way.

## Paths

A path is relative with `/` separators. **`..`, `.`, an empty segment, a leading `/`, `:` and `\` are
refused**, and so is anything over 200 bytes, 8 segments or 64 bytes per segment. All return -1.

| Host | Root |
|---|---|
| PSP | the directory of `argv[0]`, then `ms0:/PSP/GAME/<POCKETJS_APP>/`, then `host0:/` |
| browser (`platforms/web/pack.js`) | the `baseUrl` given to `createPackHost` |
| sim (`platforms/sim/pack.ts`) | the `root` directory given to `createSimPackHost` |

`POCKETJS_APP` is the app's `output` name. `pack.stats()` reports where the last open resolved in
`root`: `program`, `cwd`, `fallback` or `host0` on PSP. `cwd` replaces the first entry only when the
program received no `argv[0]`. A miss tries every remaining root, at about 10 ms per root on a card.

**On PSP, `programs/psp/src/main.rs` spells out `psp::module!` to keep `argv[0]`,** which the macro
drops after its `chdir`. `worker_main` also enters that directory with `sceIoChdir`: rust-psp's `chdir`
applies to its own main thread, and PPSSPP answers a relative path on a new thread with
`SCE_KERNEL_ERROR_NOCWD`.

In PPSSPP, `argv[0]` depends on where the EBOOT sits:

| EBOOT host path | `argv[0]` | The root is |
|---|---|---|
| contains `PSP/GAME/` | `ms0:/PSP/GAME/<dir>/EBOOT.PBP` | that directory under the memstick (`$HOME/.ppsspp` on headless) |
| anywhere else | `umd0:/EBOOT.PBP` | the EBOOT's host directory (PPSSPP mounts it as `umd0:`) |

Under PSPLINK a program loaded as `host0:/<name>.prx` has `argv[0]` under `host0:`, so
`pack.open("packs/x.pack")` opens `host0:/packs/x.pack`. **A USB share has its own read time and
latency**: `framework/src/game2d/music.ts` assumes no fixed cost per read, and its margin is the queued
audio (557 ms at 22 050 Hz). `pack.stats()` reports the measured times.

## Memory

**`read` writes into `dst`'s own storage.** Nothing passes through a string or a temporary, so a
caller that reuses one buffer allocates nothing per read.

**`loadImg` reads into one retained native buffer, 64-byte aligned, and decodes into the texture's own
storage.** The bytes never enter the JS heap. The buffer starts at 64 KiB and grows to the power of two
that fits the largest entry seen, up to `PACK_MAX_IMG_BYTES` (1 114 112 bytes). It is not released:
the arena has power-of-two classes that never merge (`platforms/psp/alloc/src/arena.rs`), so its bytes
could not serve another class.

**The first texture of each power-of-two size grows the arena once.** After that, `loadImg`
and `freeTexture` cycle within the free lists: the pack demo's 200 cycles add 0 bytes after the first
rotation through its six entries.

The browser host holds a whole file in one `ArrayBuffer` from the fetch until its last handle closes.
A later open fetches again and returns -2 until the bytes arrive.

## Cost per call

`read` and `loadImg` run on the guest's turn and block it for the device read. PPSSPP models a memory
stick read at about 80 MB/s and an open at 10 ms, so **its read times are not a real-unit estimate**.
The table holds PPSSPP figures for relative comparison.

| Call | PPSSPP (emulated CPU, modelled I/O) |
|---|---|
| `open` | 10 ms, modelled on a Pro Duo |
| `read` 8 KiB | about 105 µs |
| `loadImg` 3.4 KB RLE, decoding to 256×256 T8 | 1.8 ms |
| `loadImg` 262 KB raw 8888 | 9.7 ms |
| `loadImg` 265 KB incompressible RLE, 512×512 T8 | 10.0 ms |

Call `open` in a scene transition, spread `loadImg` over frames, and keep entries small: the time goes
up with the entry's size on the card.

## Limits

- **8 files open at once per guest.** `open` returns -1 beyond that, the same value as not found.
- One `loadImg` range is at most 1 114 112 bytes.
- `size` and offsets are JS numbers; the PSP host seeks with 64-bit offsets.
- No writes. Saves go through `globalThis.fs` (docs/FS.md).
- A failed PSP seek or read closes and reopens the file's resolved path once before returning -1, for
  descriptors a suspend invalidates. That path has not run on a real unit.
- The browser host has no range requests: a file is fetched whole, including a long track.

## The demo

`apps/game2d-pack-demo` runs one frame timeline on every host: six textures from a pack, music looping
and changing tracks, overlapping sound effects, 200 load/free cycles.

```sh
bun apps/game2d-pack-demo/gen-assets.ts
PPSSPP_HOME=<isolated home> apps/game2d-pack-demo/verify/psp.sh <run> bench beside 1400 3480
bun apps/game2d-pack-demo/verify/audio-check.ts <DumpAudio wav>
```

Output lands in `.pocket-build/validation/game2d-pack-demo/<run>/`.
