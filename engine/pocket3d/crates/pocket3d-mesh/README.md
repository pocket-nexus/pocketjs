# Pocket3D mesh data

**`Skin` defines joint-to-node mapping and inverse bind transforms for both
desktop glTF and handheld P3M1 assets.** Its allocation-free `matrices` iterator
is the only joint-palette evaluator. Desktop `pocket3d::model::Skin` re-exports
this type; desktop palettes and bind-pose bounds call the same evaluator as
colored-mesh CPU rendering and resident GPU packing.

The crate uses **`no_std` + `alloc`** and depends on `pocket3d-anim` for clips and
skeletons. It does not depend on wgpu, windowing, world simulation or any app.

| Module | Responsibility |
| --- | --- |
| `Skin` | Joint order, inverse binds and output-space transforms |
| `colored` | Colored rigid asset data, lighting parameters and CPU reference |
| `p3m` (internal) | Bounded P3M1 decoder implementing `MeshAsset::decode` |
| `rigid` | Indexed vertex packing, visibility ranges and affine palette layout |

The two formats keep their own vertex attributes and decoders. Both use the
same animation types and skin bindings. The colored profile owns its collapsed
joint visibility rule; a desktop glTF skin does not inherit that rule.

`colored::MeshAsset` decodes **P3M1**, a bounded colored rigid-mesh profile. The
`skin_matrices` method produces row-major 3-by-4 `rigid::SkinMatrix` values.
`rigid_mesh` produces
40-byte unique vertices, u16 indices and immutable visibility ranges for native
backends. A vertex belongs to one joint. Zero affine matrices hide joints;
triangles with three hidden influences are omitted. The PICA backend supports
29 joints per draw; the file format allows 256 nodes and other backends can
consume the decoded geometry without the PICA palette limit.

The CPU `skin` reference takes an explicit `DirectionalLight`; the caller owns
light direction and ambient/diffuse factors. Output and rigid vertex material
factors use a gamma-2 transfer. Normals use the affine linear part followed by
normalization; this profile assumes rigid transforms or uniform scale.

## P3M1 encoding

Numbers are little endian. Coordinates use metres, +Y up and +Z forward. Asset
vertices are in bind space. The node rest hierarchy determines inverse binds.

| Record | Contents |
| --- | --- |
| Header | `P3M1`, u32 node/vertex/index/clip counts |
| Node | u16 UTF-8 name length + name, u32 parent (`0xffffffff` for root), f32 translation[3], quaternion XYZW[4], scale[3] |
| Vertex | f32 position[3], normal[3], linear RGB[3], u16 joint |
| Indices | u32 triangle indices |
| Clip | name, f32 duration, u32 channel count |
| Channel | u16 node, u8 path (0 translation, 1 rotation, 2 scale), u16 key count |
| Key | f32 time, f32 value[3 or 4] |

P3M1 channels interpolate linearly; the in-memory sampler also supports step
channels. Decoder limits are 32 MiB, 256 nodes, 100,000 vertices, 300,000 indices,
64 clips, 128 bytes per name and 500,000 keys across the asset. Parents must
precede children. Times must increase within a channel and fit its clip.
Nonfinite values, invalid rotations/scales/colors/indices, truncated input and
trailing bytes are rejected before returning an asset.

## Import migration

The experimental `pocket3d_anim::mesh` module has moved to this crate:

```rust
use pocket3d_anim::{NodeTrs, Skeleton};
use pocket3d_mesh::colored::{ColorVertex, DirectionalLight, MeshAsset};
use pocket3d_mesh::rigid::{RigidMesh, SkinMatrix};
```

Directly constructed colored assets use `skin: Skin { joints, inverse_bind }`.
P3M1 decoding supplies the identity node mapping. Palette indices refer to skin
joints, which may be a subset or reordering of skeleton nodes.

`cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d-mesh`
checks independent rigs, reordered and multiple skins, transforms, malformed
assets, light configurations, hidden joints and CPU/GPU packing parity.
