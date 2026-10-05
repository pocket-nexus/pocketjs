# Pocket3D

Pocket3D is a hardware-native 3D stack for portable interactive software. It is
a family of mechanisms for building purpose-built 3D compilers and runtimes. It
is not one portable engine and not one GPU API.

[3d.pocket.nexus](https://3d.pocket.nexus) shows it with frames captured on the
consoles.

## Design

| | |
| --- | --- |
| **Hardware-native** | A game gets **a renderer for each machine**. GE, PICA200 and GXM are not normalized into one GPU API, so a renderer can use the PSP's fixed pipeline, the 3DS's two screens and the Vita's Cg programs and MSAA. |
| **Compiler-first** | The game is modelled once as **Three.js content that runs in a browser**. A compiler lowers that scene to one console's texture formats, vertex layouts and draw structure. |
| **Purpose-built engines** | Each game owns **its scene DSL, its IR and its renderers**. Games share the device kernels and nothing above them. |
| **Built for coding agents** | The scene is code, and each later step is a command: compile, deploy to the console, measure late frames. |

## Where the code lives

This directory is the entry point. The code sits on the axes
[STRUCTURE.md](../docs/STRUCTURE.md) defines:

| Path | Contents |
| --- | --- |
| [`devices/`](../devices/README.md) | Device kernels with explicit memory and GPU-lifetime contracts: `pocket-vita-gxm` (GXM memory, patching, targets, descriptors), `pocket-psp-ge` (GE frame storage, byte swizzle, cache publication), `pocket-3ds-pica` (PICA texture storage and mip publication) |
| [`engine/pocket3d/`](../engine/pocket3d/README.md) | Desktop wgpu mechanisms, skeletons and clips, mesh loading, the shared physical simulation, the citro3d mesh submission surface, the title card, the app icon and example consumers |
| [`site/pocket3d/`](../site/pocket3d/) | The homepage served at 3d.pocket.nexus |

Scene formats, cookers and scene renderers belong to the engines. Each engine
keeps them in its own repository.

## Title card

A game built on Pocket3D shows the Pocket3D title card when it starts: the
mark and the wordmark, **144 ticks at 60 Hz**, before the game's renderer
starts. [`pocket3d-title`](../engine/pocket3d/crates/pocket3d-title/README.md)
draws it into the console's frame buffer on the PS Vita, the PSP and the
Nintendo 3DS, and over the page in a browser reference; the three drawers
produce the same frames. Its README lists the calls and the rules for a game.

## App icon

A game built on Pocket3D shows the Pocket3D mark as its icon in the console's
launcher. [`engine/pocket3d/icon/`](../engine/pocket3d/icon/README.md) holds
the file each launcher reads: **144 x 80 for the XMB, 128 x 128 indexed for the
PS Vita's bubble, 48 x 48 and 24 x 24 for the 3DS, 57 x 57 and 114 x 114 for
the iPod touch, 48, 72, 96 and 144 pixels square for an Android launcher's
four densities**. `bun tools/pocket3d-icon.ts` bakes them from
`site/pocket3d/mark.svg`. A game reads them from its PocketJS checkout and
keeps no icon of its own; the picture behind the icon (`PIC1.PNG`, the
LiveArea) stays a capture of the game.
[`skills/pocket3d-brand`](../skills/pocket3d-brand/SKILL.md) is the procedure
for a game repository.

## Interface

A game built on Pocket3D draws its title, its readouts, its menus and its
touch controls with PocketJS, over the scene: **one PocketJS app with one
presentation per device shape, and a renderer that draws no text**. The
game's state reaches the app, and the app's commands reach the game, over the
`pocket.overlay` service answered inside the process.
[`skills/pocket3d-interface`](../skills/pocket3d-interface/SKILL.md) is the
procedure for a game repository.

## License

Pocket3D is under the [Pocket3D License](./LICENSE), version 1.0. It grants
what the MIT License grants, with one more condition: **a distributed product
that draws 3D scenes with Pocket3D shows the title card each time it starts**,
unmodified and at its full length. The PocketJS hosts in this repository, and
software that reaches Pocket3D only through them to draw PocketJS interfaces,
are exempt. A separate written license from the copyright holder removes the
condition: write to support@pocket.nexus. Copies published under the MIT
License before this license stay under the MIT License.

## Engines

| Engine | Owns | Renderers |
| --- | --- | --- |
| [OpenStrike](https://github.com/pocket-nexus/open-strike) | BSP, PVS and collision, `.p3d`, the map cooker | GE, GXM, GLES2 |
| Pocket Atlas | PlaceIR, target profiles, `.place` packs | GXM, PICA200 |
| Pocket Maneuver | WorldIR, device profiles, `.pack` packs with a compile receipt | GXM, PICA200, GE |
| Pocket Tokyo | CityIR, device profiles, city packs with a compile receipt | GXM, GE, PICA200 |

## Validation

[`engine/pocket3d/README.md`](../engine/pocket3d/README.md#pocket3d-mechanisms-in-pocketjs)
lists the host checks. Device builds and on-device measurements belong to the
application that owns the frame loop. A passing host test is not physical GPU
acceptance.
