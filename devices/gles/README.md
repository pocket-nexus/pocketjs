# GLES drivers

`pocket-gles1::Renderer<C>` and `pocket-gles2::Renderer<C>` select their pipeline
by type. `pocket-gles` contains DrawList decoding, ordered triangle batching,
texture conversion, driver-owned glyph pages, and submission lifetimes. None
of these crates depend on `Ui` or generate a DrawList.

The platform implements the unsafe `ContextAccess` contract. The renderer calls
`ensure_current` before GL access and `bind_target` before drawing. An activation
error must mean context loss has stopped GPU work. A temporary context-acquisition
failure cannot satisfy that contract. Register native targets with `TargetConfig`;
returned handles belong to one renderer and cannot be unregistered while a
submission references them.

`render` copies pixels through `glTexImage2D` and geometry through `glBufferData`.
Every submission retains a separate VBO and its texture versions. `wait` calls
`glFinish`; early retirement and destruction drain pending work before deletion.
The driver does not support `render_zero_copy`. Known native-text operations are
unsupported. `SurfaceQuad` is unsupported unless the target declares an external
compositor responsible for that operation.

`with_limits` supplies resident texture budgets. Candidate defaults are **512
image entries / 64 MiB** and **128 glyph pages / 4 MiB**. The cache evicts entries
without submission references before reporting capacity failure. Image accounting
charges four bytes per texel, including two-byte LA uploads; `cache_usage` reports
these charged resident bytes. Upload staging, pending VBOs, and the four-byte white
texture are outside these texture limits. Device acceptance must determine the
budgets used by each host.

The legacy C entry points in `runtime-cabi` adapt the singleton `Ui` to this
renderer. They retain their existing `gles1` selection switch and current-context
precondition. Their trace stages 0 and 1 bracket core DrawList generation; stages
2 through 6 come from the renderer. Normal glyph pages now belong to the driver;
transformed-text image pages remain resources supplied by the core adapter.
