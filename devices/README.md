# Pocket3D device kernels

Pocket3D is a family of mechanisms for building purpose-built 3D compilers and
runtimes. PocketJS hosts the reusable hardware substrate and toolchain pins.
These kernels have no dependency on PlaceIR, BSP, materials or game policy.

| Kernel | Shared mechanism | Actual callers |
| --- | --- | --- |
| `vita/pocket-vita-gxm` | GXM memory, patching, targets, descriptors | Atlas, OpenStrike |
| `psp/pocket-psp-ge` | GE frame storage, byte swizzle, cache publication | PocketJS host, Atlas cooker/runtime, OpenStrike |
| `3ds/pocket-3ds-pica` | PICA texture storage and complete mip publication | PocketJS host used by OpenStrike, Atlas |

Atlas owns PlaceIR, target profiles, recipes, native formats and its renderers.
OpenStrike owns BSP/PVS/collision, `.p3d`, its cooker and domain renderers in
[open-strike/domain](https://github.com/pocket-nexus/open-strike/tree/main/domain).
PocketJS keeps the desktop widget, animation, mesh, VRM and simulation consumers
under `engine/`; none requires the BSP compiler. The old `pocket3d::bsp`,
`pocket3d::collide` and `WorldModel::from_bsp` adapters moved to OpenStrike.

The kernels are under the [Pocket3D License](../pocket3d/LICENSE). The PocketJS
hosts that use them are exempt from its title-card condition.

Do not normalize GE, PICA and GXM into one GPU API. Compilers must be able to
see their costs and constraints. Extract another mechanism only after concrete
callers establish its contract. The caller owns GPU completion and retirement;
no implicit waits hide these obligations.
