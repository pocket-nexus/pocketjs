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
| [`engine/pocket3d/`](../engine/pocket3d/README.md) | Desktop wgpu mechanisms, skeletons and clips, mesh loading, the shared physical simulation, the citro3d mesh submission surface and example consumers |
| [`site/pocket3d/`](../site/pocket3d/) | The homepage served at 3d.pocket.nexus |

Scene formats, cookers and scene renderers belong to the engines. Each engine
keeps them in its own repository.

## Engines

| Engine | Owns | Renderers |
| --- | --- | --- |
| [OpenStrike](https://github.com/pocket-nexus/open-strike) | BSP, PVS and collision, `.p3d`, the map cooker | GE, GXM, GLES2 |
| Pocket Atlas | PlaceIR, target profiles, `.place` packs | GXM, PICA200 |
| Pocket Maneuver | WorldIR, device profiles, `.pack` packs with a compile receipt | GXM, PICA200, GE |

## Validation

[`engine/pocket3d/README.md`](../engine/pocket3d/README.md#pocket3d-mechanisms-in-pocketjs)
lists the host checks. Device builds and on-device measurements belong to the
application that owns the frame loop. A passing host test is not physical GPU
acceptance.
