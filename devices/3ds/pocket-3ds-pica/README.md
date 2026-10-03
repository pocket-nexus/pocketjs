# pocket-3ds-pica

A header-only C device kernel used by PocketJS's DrawList host (including
OpenStrike) and Atlas's native PICA renderer. It checks linear-memory 2D texture
allocation, mip payload sizes, CPU upload/cache publication and explicit release.
It exposes citro3d types; it does not hide PICA formats, TEV, tiling or frame costs.

Callers own texel layout, filters, bindings, shaders and frame scheduling. Stop
submission, unbind/park context references and wait for actual GPU completion
before releasing or overwriting in-flight storage. `C3D_FrameSync` alone is a
VBlank wait, not a retirement fence. No kernel function waits implicitly.

`bun test tests/pica-kernel.test.ts` exercises failure cleanup, payload bounds and
full-mip publication against an instrumented host stub. The normal 3DS build
compiles the same header against citro3d; host tests do not prove GPU execution.
