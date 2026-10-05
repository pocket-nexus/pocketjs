# Pocket3D mechanisms in PocketJS

Pocket3D is a technology family for building purpose-built 3D runtimes and
compilers. It is not one portable engine or one GPU API.
[`pocket3d/README.md`](../../pocket3d/README.md) is its entry point in this
repository.

Atlas owns PlaceIR, profiles, recipes, native packs and its scene renderers.
OpenStrike owns BSP/PVS/collision, `.p3d`, the map cooker and its GE/GXM/GLES2
renderers in [open-strike/domain](https://github.com/pocket-nexus/open-strike/tree/main/domain).
Those implementations have moved out of PocketJS. The old desktop `bsp`
feature and collision re-export are removed; OpenStrike owns its desktop
`bsp_world` adapter too.

The existing names below identify experimental implementations, not a mandatory
API for other members of the family:

| Path | Responsibility / consumers |
| --- | --- |
| `crates/pocket3d` | Desktop wgpu uploader, camera and render mechanisms; PocketJS desktop host, widgets and OpenStrike desktop |
| `crates/pocket3d-anim` | Skeletons, clips and pose sampling; desktop models and VRM |
| `crates/pocket3d-mesh` | Mesh loading; desktop models and widgets |
| `crates/pocket3d-world` | Shared physical simulation and its invariant tests |
| `crates/pocket3d-title` | The title card a Pocket3D game shows at launch, drawn into a frame buffer with no GPU; Rust for the PS Vita and PSP, a C header for the Nintendo 3DS, a module for browser references |
| `icon/` | The app icon a Pocket3D game shows in a console's launcher: the mark on the title card's ground, one file per launcher (PSP, PS Vita, Nintendo 3DS, iPod touch, Android), baked by `tools/pocket3d-icon.ts` |
| `backends/citro3d` | Existing 3DS mesh submission surface used by handheld experiments and OpenStrike |
| `examples/` | Widget and handheld consumers |

[Device kernels](../../devices/README.md) expose native GXM, GE and PICA
mechanisms with explicit memory and GPU-lifetime contracts. Platform compilers
retain knowledge of target formats, limits and costs. New shared code must come
from demonstrated needs in actual applications, without domain scene names or
implicit GPU waits.

Validation from the repository root:

```sh
cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d -p pocket3d-world --lib
cargo check --locked --manifest-path engine/Cargo.toml -p pocket-widget -p pocket-vrm -p pocket-ui-wgpu
```

Device builds and on-device measurements belong to the application that owns
the frame loop. A successful host test is not physical GPU acceptance.
