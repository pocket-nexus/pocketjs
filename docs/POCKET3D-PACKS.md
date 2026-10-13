# Pocket3D packs as pieces

A Pocket3D game cooks one pack a level and a device profile. `pocket3d-packs` cuts those packs into **pieces named by their bytes** and lists them in **one manifest**. Every device reads a pack through the manifest: the browser fetches the pieces a section lies in, a PSP reads them beside its `EBOOT.PBP`, a 3DS reads them from its memory card. A device that holds an earlier cook receives the pieces it lacks.

| Part | Where |
| --- | --- |
| Cutter, checker and directory delivery | `tools/pocket3d-packs.ts` |
| LAN delivery to a 3DS, computer side | `tools/pocket3d-delivery.ts` |
| LAN delivery to a 3DS, console side | `hosts/3ds/src/packs_delivery.c` |
| Reader (`no_std` + `alloc`, optional C interface) | `engine/pocket3d/crates/pocket3d-packs` |
| Browser reader over HTTP | `devices/web/pocket-web-wgpu/src/source.rs` |
| Tests | `tests/pocket3d-packs.test.ts`, `tests/pocket3d-delivery.test.ts`, the crate's unit tests |

## The manifest

The manifest is a text file. Its first line is the format, `pocket-pack-pieces/2`.

```
pocket-pack-pieces/2
pack street 30515456 5f0c…(64 hexadecimal digits: the pack's SHA-256)
3b1d9a04c2e67f5810aa 1048576
77c0e1f2a9b3d4c5e6f7 4134144
pack yards 32337920 a81e…
3b1d9a04c2e67f5810aa 1048576
```

- A line `pack <name> <bytes> <sha256>` starts a pack. A name is **1 to 24** lowercase letters, digits and hyphens.
- Each following line `<name> <bytes>` is one piece of that pack, in order. **A pack is its pieces concatenated.**
- A piece's name is the **first 20 hexadecimal digits of the SHA-256 of its bytes**. Its file is `<name>.bin` in the manifest's directory.
- Two packs that list the same name share one file.
- On a handheld the manifest's file is `pocket.packs`. On a web host it is `<16 digits of its own hash>.packs`, so a page that names it can be cached without a limit; a pack's address is `<manifest>#<pack>`.

A reader refuses a manifest whose first line is another format, a line that is neither form, a piece before the first pack, a pack named twice, and a pack whose pieces do not add up to its size.

## Where a pack is cut

`writePacks` cuts a pack in two steps.

1. **At each section boundary.** `sectionCuts` reads Pocket3D's section table: a 16-byte head (`mark, version, count, spare`, four `u32`) and `count` entries of 16 bytes (`tag, offset, size, spare`). A section that two packs hold with the same bytes becomes the same piece, stored once. A game whose pack has another layout passes its own `cuts`.
2. **Inside a span longer than `max`.** `contentCuts` slides a 32-byte rolling hash over the span and cuts where the hash's upper `bits` bits are zero, no closer than `min` to the last cut and no further than `max`. The cut points depend on the bytes near them, so an insertion moves the pieces around it and leaves the others with their names.

`CUT_SIZES` is `min` **512 KiB**, `max` **4 MiB**, `bits` **20**. Two cooked levels of 59.9 MiB cut into 55 pieces in 0.19 s on an M3 Max.

## Tool

```
bun tools/pocket3d-packs.ts cut <directory> <name>=<pack>…    # pieces and <hash>.packs into <directory>
bun tools/pocket3d-packs.ts check <directory> <manifest>      # every piece is what its name says
bun tools/pocket3d-packs.ts bring <directory> <manifest> <to> [--prune]
```

`bring` copies the pieces `<to>` lacks, then writes the manifest there as `pocket.packs`, then (with `--prune`) removes the pieces no pack lists. The manifest is written last: a copy that stops half way leaves the old manifest and every piece it names.

The same functions are exports: `writePacks`, `checkPacks`, `lacking`, `bring`, `parseManifest`, `piecesOf`.

## Devices

| Device | Where the pieces are | Delivery |
| --- | --- | --- |
| Browser | A static directory: `<hash>.packs` and the `.bin` files | Upload the directory. The page names `<manifest>#<pack>` |
| PSP | Beside `EBOOT.PBP`, or on the PSPLINK share | `bring` to the Memory Stick folder or to the share's directory |
| Nintendo 3DS | A directory on the memory card, or `romfs:/` of the `.3dsx` | `bring` to a card in a reader, or `deliver` over the LAN |
| Release zip | The folder the zip is made from | `bring` to that folder |

**PS Vita and the other hosts** take the directory form: `bring` to the directory the program reads (over FTP or a card reader), and a `Store` over the device's file calls. A LAN delivery there needs that host's control connection to carry the three steps below; `packs_delivery.c` is BSD sockets and `stdio`, and its 3DS calls sit behind `__3DS__`.

## LAN delivery to a 3DS

`deliver(client, directory, manifest, { prune, verify })` in `tools/pocket3d-delivery.ts` takes a paired `PocketRuntimeClient`. It checks every piece against its name, opens an HTTP endpoint on the computer that serves the manifest's pieces and its text under a **random 256-bit token**, and sends one control line a step:

| Line (`"t":"pocket3d.packs"`) | The console | Answer |
| --- | --- | --- |
| `"piece":{host,port,token,name,bytes,crc32}` | Answers `cached` for a file of that name and size. For any other state it fetches `/<token>/<name>.bin` into `<name>.bin.tmp`, compares length and CRC-32, and renames | `pocket3d.piece` with `ok`, `cached` |
| `"manifest":{host,port,token,bytes,crc32}` | Fetches `/<token>/pocket.packs` the same way | `pocket3d.manifest` |
| `"prune":true` | Removes the `.bin` files `pocket.packs` does not name, and `.tmp` files | `pocket3d.pruned` with `removed` |

`"verify":true` in a piece's request has the console read the file it holds and compare its CRC-32.

A host calls `p3d_delivery(line, directory, reply, capacity, &changed)` for each control line it receives and sends `reply` when the call returns true. The call runs a step to its end and pumps the paired connection while it waits, so the frame loop stops for that time. **`changed` is set when `pocket.packs` was replaced**: the host drops its parsed list and reads the new file. A disconnect, or L+R+START, cancels a transfer and removes the partial file. A piece is **64 MiB** at most, the manifest **1 MiB**.

## Reader

```rust
use pocket3d_packs::{Manifest, Reader, Store};

let manifest = Manifest::parse(text)?;
let pack = manifest.pack("street").ok_or("no such pack")?;
Reader::new(pack, store).read(section.offset as u64, &mut bytes)?;
```

- `Store::read(piece, at, into)` is the device's part: bytes of one named piece. `Directory` (feature `std`) reads `<name>.bin` files.
- `Pack::parts(offset, bytes)` gives the pieces a range lies in and the range inside each, by binary search over the pieces' starts.
- `names(text)` lists a manifest's pack names without allocating, for code that runs before a heap exists.
- Feature `cabi` exports the same reader to C (`pocket3d_packs.h`): `p3d_packs_parse`, `p3d_packs_find`, `p3d_packs_name`, `p3d_packs_pieces`, `p3d_packs_piece`, `p3d_packs_read` with a callback that reads one piece's file.

The reader copies ranges; it holds no piece in memory. A program reads a section when it needs it, so **a level's sections can be read one by one** and a device that streams a section in parts asks for the ranges in turn. The browser reader fetches a piece whole with a plain request and keeps the last pieces read in memory, up to **32 MiB** (`HELD`); the browser's HTTP cache holds the others, and two reads that need one piece at the same moment share one request.

## What a game does

1. Cook each level's pack with Pocket3D's section table (or pass `cuts`).
2. Call `writePacks(directory, [{ name, file }, …])` after a cook; name each pack by the level's id.
3. Deliver: `bring` for a folder, a share or a release zip; `deliver` for a 3DS on the LAN; upload the directory for the web.
4. In the program, parse `pocket.packs`, list the packs it names, and read sections through `Reader` (Rust) or `p3d_packs_read` (C). On the web, give `Source::open` the address `<manifest>#<pack>`.
5. On a 3DS, link `packs_delivery.c` and pass each control line to `p3d_delivery`.

## Limits

- The manifest carries no signature. The piece names and the pack's SHA-256 detect damage, not a hostile sender; the LAN delivery relies on the paired connection and the token.
- A console takes a piece file of the right name and size as correct unless the delivery asks for `verify`.
- The browser reader reads two formats: `pocket-pack-pieces/1` (a JSON manifest of fixed-size pieces, written by `cutPack`) and `/2`. The handheld readers read `/2`.
