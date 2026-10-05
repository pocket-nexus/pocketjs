# Pocket3D app icon

A game built on Pocket3D shows the Pocket3D mark as its icon in the console's
launcher: the mark of 3d.pocket.nexus on the plum ground of the
[title card](../crates/pocket3d-title/README.md), `#171226`. **Every game uses
these files. A game does not draw an icon of its own.** The launcher sets the
game's name beside the icon, and the name tells one game from another.

| Console | File | Size | Read by |
| --- | --- | --- | --- |
| PSP | `psp/ICON0.PNG` | 144 x 80 | `pack-pbp`, `xmb_icon_png` in `Psp.toml` |
| PS Vita | `vita/icon0.png` | 128 x 128, **8-bit indexed** | `sce_sys/icon0.png` in the VPK |
| Nintendo 3DS | `3ds/icon.png`, `3ds/icon-small.png` | 48 x 48, 24 x 24 | `smdhtool --create` |
| iPod touch 4 | `ios/Icon.png`, `ios/Icon@2x.png` | 57 x 57, 114 x 114 | the application bundle |
| Android | `android/mdpi.png`, `android/hdpi.png`, `android/xhdpi.png`, `android/xxhdpi.png` | 48 x 48, 72 x 72, 96 x 96, 144 x 144 | `res/drawable-<density>/` in the APK |

The mark covers 86% of the shorter side on the XMB and in the Homebrew
Launcher, which show the whole rectangle. It covers 70% of the PS Vita's
bubble, which the LiveArea cuts to a circle, and 76% of the SpringBoard icon,
whose corners iOS rounds. An Android icon has the same 76%: a launcher that
cuts every icon to a shape of its own (MIUI's rounded square) keeps the whole
mark. The 24-pixel icon is a drawing of its own at 92%:
given one icon, `smdhtool` halves the 48-pixel one.

## Wiring a game

A game reads the files from its PocketJS checkout (`vendor/pocketjs`), so a new
drawing reaches every game with the pin. A game keeps no copy in Git.

A build written in TypeScript takes the paths from `tools/pocket3d-icon.ts`.
The import needs no package installed in the game's repository:

```ts
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";

// PSP: the third argument of pack-pbp is ICON0.PNG
await $`pack-pbp ${out}/EBOOT.PBP ${out}/PARAM.SFO ${POCKET3D_ICON.psp} NULL NULL ${pic1} NULL ${prx} NULL`;

// PS Vita: `icon` replaces sce_sys/icon0.png, whatever the asset tree holds
await packageVitaVpk({ tool, sfo, eboot, output, applicationAssets, icon: POCKET3D_ICON.vita });
```

A build that names files in a manifest or a Makefile takes them by path:

```toml
# psp/Psp.toml
xmb_icon_png = "../vendor/pocketjs/engine/pocket3d/icon/psp/ICON0.PNG"
```

```make
# Nintendo 3DS: the large icon, then the small one
ICON       := $(POCKETJS)/engine/pocket3d/icon/3ds/icon.png
SMALL_ICON := $(POCKETJS)/engine/pocket3d/icon/3ds/icon-small.png
$(BUILD)/game.smdh: $(ICON) $(SMALL_ICON)
	smdhtool --create '$(TITLE)' '$(DESCRIPTION)' '$(AUTHOR)' $(ICON) $@ $(SMALL_ICON)
```

PocketJS's own 3DS Makefile (`hosts/3ds/Makefile`) takes the same two
variables, `ICON` and `SMALL_ICON`. Its iPod touch packager
(`tools/ipodtouch4.ts`) takes `icon` in the application's description: give it
`ios/Icon@2x.png`. That packager writes the 57-pixel file by reducing the one
it is given, and the iPod touch 4 shows the 114-pixel file. A game with its own
iPod packager copies `ios/Icon.png` and
`ios/Icon@2x.png` into the bundle under those names and sets
`UIPrerenderedIcon` in `Info.plist`, so SpringBoard adds no gloss.

An Android build copies each file into the resource directory of its density
under one name, and the manifest names that resource:

```ts
import { POCKET3D_ICON_ANDROID } from "../vendor/pocketjs/tools/pocket3d-icon.ts";

// res/drawable-mdpi/icon.png, res/drawable-hdpi/icon.png, ... then `aapt package -S res`
for (const [density, file] of Object.entries(POCKET3D_ICON_ANDROID)) {
  mkdirSync(`${res}/drawable-${density}`, { recursive: true });
  copyFileSync(file, `${res}/drawable-${density}/icon.png`);
}
```

```xml
<application android:icon="@drawable/icon" android:label="Pocket Game">
```

A phone's launcher reads the file of its own density: **96 x 96 at 320 dpi**.

A build system that reads the icon from a directory it owns (the `assets`
directory of `cargo vita`, a `static/sce_sys` tree) gets the file copied there
by the build, and the copy is listed in `.gitignore`.

## Rules for a game

- The icon is these files, **unchanged**: not redrawn, recoloured, cropped,
  or set over a capture of the game.
- The launcher's title string names the game: `TITLE` in `PARAM.SFO`, the
  SMDH title, `CFBundleDisplayName`, `android:label`.
- A capture of the game goes where the console shows a picture behind or
  beside the icon: `PIC1.PNG` on the PSP (480 x 272), `bg.png` and
  `startup.png` in the PS Vita's LiveArea. Those stay the game's own.

## Re-baking

`site/pocket3d/mark.svg` is the drawing. After it changes:

```sh
bun tools/pocket3d-icon.ts --preview   # the ten files, and a sheet under .pocket-build/pocket3d-icon/
bun tools/pocket3d-icon.ts --check     # what tests/pocket3d-icon.test.ts runs
```

The command rasterizes with `@napi-rs/canvas` at four samples per pixel in each
direction, and needs no browser and no network. The PS Vita file holds at most
256 colours as palette indices, the form the VPK packager requires; entry 0 is
the ground.
