---
name: pocket3d-brand
description: Apply the Pocket3D brand to a game built on Pocket3D — the Pocket3D app icon on PSP, PS Vita, Nintendo 3DS, iPod touch and Android, and the title card at launch. Use when creating or packaging a Pocket3D game, adding a console target to one, touching ICON0 / icon0 / SMDH / Icon.png / an APK's drawable icon / PIC1 / LiveArea files, or reviewing a game repository's launcher art.
---

# Pocket3D brand

## Overview

A game built on Pocket3D carries two fixed pieces of the Pocket3D brand and
one piece of its own:

| Surface | Whose | Source |
| --- | --- | --- |
| App icon in the console's launcher | Pocket3D | `engine/pocket3d/icon/` |
| Title card, the first 2.4 seconds of every launch | Pocket3D | `engine/pocket3d/crates/pocket3d-title` |
| Picture behind or beside the icon (`PIC1.PNG`, LiveArea `bg.png` and `startup.png`) | the game | a capture of the game |

The two Pocket3D pieces are files and code in the PocketJS checkout. A game
wires them in; it does not draw, bake, generate or edit either. Both READMEs
hold the exact calls:
[`engine/pocket3d/icon/README.md`](../../engine/pocket3d/icon/README.md) and
[`engine/pocket3d/crates/pocket3d-title/README.md`](../../engine/pocket3d/crates/pocket3d-title/README.md).
In a game repository the same paths start at `vendor/pocketjs/`.

## The app icon

**Do not create an icon.** No capture of a scene, no rendered logo, no
generated image, no resized copy of another console's icon. The icon is the
Pocket3D mark on the plum ground, and every game shows the same one:

| Console | File under `engine/pocket3d/icon/` |
| --- | --- |
| PSP | `psp/ICON0.PNG` (144 x 80) |
| PS Vita | `vita/icon0.png` (128 x 128, 8-bit indexed) |
| Nintendo 3DS | `3ds/icon.png` (48 x 48) and `3ds/icon-small.png` (24 x 24) |
| iPod touch 4 | `ios/Icon.png` (57 x 57) and `ios/Icon@2x.png` (114 x 114) |
| Android | `android/mdpi.png` (48 x 48), `android/hdpi.png` (72 x 72), `android/xhdpi.png` (96 x 96) and `android/xxhdpi.png` (144 x 144) |

1. Point the build at the file. TypeScript builds import `POCKET3D_ICON` from
   `tools/pocket3d-icon.ts`; `Psp.toml` and Makefiles name the path;
   `packageVitaVpk` takes `icon`. An Android build copies the four files of
   `POCKET3D_ICON_ANDROID` to `res/drawable-<density>/icon.png` in its build
   directory and names `@drawable/icon` in the manifest.
2. Delete the game's own icon files (`icon0.png`, `ICON0.png`, `n3ds/icon.png`,
   an `Icon*.png` in an iOS bundle directory) and whatever script produced
   them. Where a build system reads the icon from a directory it owns, the
   build copies the file there and `.gitignore` lists the copy.
3. Give both 3DS sizes to `smdhtool`. With one argument it halves the large
   icon, and the keys of the mark blur.
4. Keep the launcher's title string as the game's name. It is what tells two
   games apart.

Check the result from the built artifact, not from the source tree:

```sh
# PSP: the second entry of the PBP is ICON0.PNG
bun -e 'const d=require("fs").readFileSync(process.argv[1]);const o=i=>d.readUInt32LE(8+4*i);
  process.stdout.write(d.subarray(o(1),o(2)))' EBOOT.PBP | cmp - vendor/pocketjs/engine/pocket3d/icon/psp/ICON0.PNG
# PS Vita: the VPK is a zip
unzip -p game.vpk sce_sys/icon0.png | cmp - vendor/pocketjs/engine/pocket3d/icon/vita/icon0.png
# Android: the APK is a zip, and aapt stores a PNG it cannot shrink as it was given
unzip -p game.apk res/drawable-xhdpi/icon.png | cmp - vendor/pocketjs/engine/pocket3d/icon/android/xhdpi.png
```

`aapt package` rewrites a PNG when its own encoding is smaller, so a `cmp`
that fails there is settled by decoding both files and comparing pixels.

For a `.3dsx`, `smdhtool` stores the icons as RGB565 tiles, so compare the
SMDH with one built from the two files by the same `smdhtool`.

## The title card

The card plays first at every launch, before the game's renderer starts and
before input is read. The calls per console and the rules are in the crate's
README. A development build may skip it behind a flag of its own; a build
that leaves the developer's machine plays it. The
[Pocket3D License](../../pocket3d/LICENSE) makes the card a condition of
distributing a game.

## The game's own art

`PIC1.PNG` on the PSP and the LiveArea pictures on the PS Vita are captures of
the game itself, taken from a running build. Commit them when the package
consumes them. They do not contain another game's scene, and they are not
reused as icons.

## Common mistakes

- Resizing the Vita icon for another console. Each console has its own file.
- Passing a 24-bit PNG as the Vita icon. The packager rejects it: the file in
  `vita/` is indexed.
- Leaving the old icon in the repository beside the new wiring. A later
  build script picks it up again.
- Drawing the mark with the game's renderer for a menu or a loading screen.
  The mark appears in the icon and in the title card, from these sources.
