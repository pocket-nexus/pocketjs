# Pocket3D citro3d backend

This backend draws **colored triangle streams and indexed rigid skins on the
PICA200**. It accepts geometry and affine bone matrices from `pocket3d-mesh`,
with no application state, character names or controller assumptions. C owns
citro3d calls; Rust owns animation sampling and skeleton interpolation.

The host owns C3D initialization, render targets and the frame boundary.
For a colored stream, call `p3d_mesh_create`, upload a static mesh once or a
dynamic mesh after `C3D_FrameBegin`, then call `p3d_begin` with a citro3d
view-projection matrix and `p3d_draw`. `ColorVertex` contains three position
floats followed by four color floats, for **28 bytes per vertex**.

For a rigid skin, initialize `skin.v.pica` with `p3d_skin_init` and pass a
`P3D_SkinSource` to `p3d_skin_create`. The backend copies **40-byte unique
vertices and 16-bit indices into one resident linear allocation**. Each vertex
contains position, normal, square-root material color and its bone's matrix-row
offset. The source can be released after creation. Every actor can share the
resulting `P3D_SkinMesh`; it contains no mutable pose or per-actor vertex stream.

Before drawing, call `p3d_begin` for common depth/blend state, then
`p3d_skin_begin` with a `P3D_SkinLight` for the skin shader and attributes. Pass each actor's affine
matrix palette and `p3d_skin_visible` mask to `p3d_skin_draw`. **Up to 29 joints
use 87 float-vector uniforms**, leaving room for projection and shader
constants within the PICA200's 96-register limit. This backend rejects larger
palettes. Its input contract has one bone per vertex; weighted multi-bone
blending is not implemented.

The shader transforms positions and normals, normalizes the normals and
computes `ambient + diffuse * max(dot(normal, lightDirection), 0)`.
**The caller supplies direction, ambient and diffuse factors.** Factors must be
finite, nonnegative and sum to at most one. Direction is normalized by the
backend; a zero direction is accepted when diffuse is zero. The function
returns false without changing render state for invalid input.
Material factors and scalar lighting use a gamma-2 transfer for the RGB
framebuffer; this is a colored-mesh profile, not an sRGB implementation.
Normal transformation assumes rigid transforms or uniform scale. An all-zero affine matrix marks
a hidden joint. Immutable index ranges record the three influencing joints;
ranges with no visible joint are skipped, and adjacent visible ranges are
submitted together. **Expression visibility needs no vertex or index uploads.**
Each actor updates at most 1,392 bytes of matrix uniforms before drawing.

Buffers use `linearAlloc` and a data-cache flush before their first submission.
The host must wait for the GPU before freeing or changing an in-flight buffer.
The backend uses a depth buffer, source-alpha blending and no backface culling.
The host must restore UI shader, attributes, buffers, blending and depth state
before drawing 2D UI. The [folding-prop example](example/main.c) uses two
different rig sizes, shared geometry, independent poses, hidden joints and
three caller-selected lights without application assets or QuickJS.

Both shaders are assembled by devkitPro's `picasso`. Texture sampling,
stereo-eye submission and per-pixel lighting are outside this profile.

Build the standalone example from the repository root:

```sh
docker run --rm -v "$PWD:/repo" -w /repo/engine/pocket3d/backends/citro3d/example \
  devkitpro/devkitarm@sha256:116afba8df8453961de2936ffab20dd441edf4d682856c1ec8b0e53d7ed0bbf5 make
```

The output is `dist/pocket3d-citro3d/rigid-skin.3dsx`. Add `CAPTURE=1` to
write three GPU readbacks and an assertion receipt under `/p3d-rigid` on the
console/emulator SD. These are rendering checks, not frame-rate measurements.


On macOS with Azahar installed, `bun engine/pocket3d/backends/citro3d/example/capture.ts`
checks the capture build using an isolated emulator SD and three GPU readbacks.

[Sample capture receipt](example/evidence/receipt.json) records geometry
visibility and brightness checks for directional, unlit and zero-light passes.
