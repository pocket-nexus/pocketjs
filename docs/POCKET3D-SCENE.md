# Authored scenes on constrained hardware

`pocket3d-bsp` cooks a GoldSrc map. `pocket3d-scene` cooks a scene no map
format produced: procedural terrain, scattered vegetation, props, water and
particles, for a GPU that has no shader of its own.

Companion docs: `engine/pocket3d/README.md` (the substrate), `docs/RUNTIMES.md`
(the runtime family), `hosts/vita/README.md` (the Vita host and its toolchain).

## The two terms

The cooker resolves what the device cannot compute — sun and sky irradiance,
ambient occlusion, exponential height fog and its sun in-scattering — into two
packed colours per vertex:

```text
pixel = albedo x lit + fog.rgb x fog.a
```

**`lit` already carries `(1 - coverage)`.** A backend with a multiply blend and
an additive blend therefore reproduces exact linear aerial perspective, with no
fragment program of its own.

Both terms are stored gamma-encoded. A product of gamma-encoded values is the
gamma encoding of the product, so the multiply pass is exact; the additive pass
is the same gamma-space lerp that fixed-function fog has always performed on
this class of hardware.

**Fog is baked from one viewpoint.** `BakeInputs::eye` names it, and
`pocket3d_scene::ride::DriftSettings` names the stretch of river the camera
stays on. A scene is honest over that stretch and no further. A dynamic object
gets its own eye: the boat is baked from the camera's seat on it, 7.5 m away,
so the one object that is always in the foreground stays clear of the haze that
the world origin sits in.

## Chunks

Geometry is chunked. Each chunk carries a bounding sphere, an LOD band, and
**its own quantization origin and scale**, so 16-bit positions keep
sub-millimetre precision at any world size. The dequantization folds into the
per-chunk transform a backend already uploads, so the precision costs nothing
at runtime. A chunk splits before its relative `u16` indices can overflow.

`cull::VisibleSet` performs six-plane rejection, LOD band selection and
translucent sorting over those records. None of it touches a GPU, so it is
written once rather than once per backend. Chunks the cooker measured as
effectively clear are marked, and the fog pass skips them.

## Runtime surfaces

Water, the sky dome, cloud, wake and particles cannot be cooked: they depend on
the camera and the clock. `runtime::DynamicMesh` holds them in the cooked
layout's full-precision twin, with the same attribute order, so a backend's
three vertex programs differ only in stride.

They are built from the same lighting model as the cooked geometry, which is
why they sit in the same air as it. Particle motion is a pure function of index
and clock, so a backend that drops frames or resumes from suspend picks the
motion up where the clock says it should be.

## The Vita backend

`pocket3d-vita` draws a scene with vita2d's stock shader binaries in three
passes:

| Pass | Program | Blend | Result |
| --- | --- | --- | --- |
| albedo | texture | none | `albedo` |
| light | colour at offset 8 | `dst * src` | `albedo x lit` |
| fog | colour at offset 12 | `src * srcAlpha + dst` | `albedo x lit + fog x coverage` |

Alpha-blended cutouts take a single pass instead, texture times one flat tint
per chunk, resolved from that chunk's own baked vertices at load and drawn back
to front against a depth test that does not write. **A multiply pass over an
already-blended tile would be wrong**, which is the real limit of drawing
without a shader: blended surfaces get one colour per batch rather than one per
vertex. That limit lands on foliage cards, cloud and particles, which are small
or uniform.

Textures are **swizzled with a full mip chain**. vita2d's texture helper
allocates one linear level; a forest at 960x544 aliases without the chain.

## The valley

`pocket3d-valley` is the first scene: a procedural river valley cooked in under
a second into **392 chunks and 64k triangles**, with every texture synthesized
from its seed. The ground is one grid laid out in river space — rows along the
current, columns fanning out from the centre line — so the shoreline is
resolved where it matters, the far slopes cost almost nothing, and there is no
seam because every row shares one column table.

Vegetation is cooked at three densities against the LOD bands the runtime culls
with: trees near the camera's stretch of river, crossed billboards through the
middle distance, tree-line cards beyond that.

```sh
bun run valley preview --frames 0,40,80 --size 960x544
bun run valley build            # dist/vita/valley-vita.vpk
bun run valley install --mount /Volumes/PSV
```

`preview` renders with a CPU rasterizer that runs the same culling, the same
runtime surfaces and the same blend model as the device. The device evaluates
the blend as three passes through an 8-bit framebuffer and this evaluates it
once in float, so the two agree on composition, geometry and colour and differ
by the rounding of the intermediate passes. It is a reference for the image,
not a byte oracle for it.
