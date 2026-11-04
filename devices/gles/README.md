# GLES drivers

`pocket-gles1::Renderer<C>` and `pocket-gles2::Renderer<C>` select their pipeline
by type. `pocket-gles` contains the GLES policies for the DrawList walk in
`pocket-render` (fill patches, image and glyph page lookup, GL texture
names as batch keys), texture conversion, driver-owned glyph pages, and
submission lifetimes. None of these crates depend on `Ui` or generate a
DrawList.

`pocket_gles::raw` declares every GL entry point the three crates call: the
common set at the module root, the ES 1.1 fixed-function set in `raw::es1`,
and the ES 2 program set in `raw::es2`. A declaration creates no symbol
reference; a pipeline crate references only the set it calls. **A program
that names only `pocket_gles1` gets no `pocket_gles2` object in its archive
and no reference to an ES 2 entry point.** The two pipelines stay separate
crates for this reason: one crate built with `codegen-units = 1` and without
LTO would place ES 1.1 and ES 2 code in one object file. The `mock-gl`
feature compiles one recording definition of every entry point; the pipeline
crates enable it from their dev-dependencies, so host tests of all three
crates link the same stubs.

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

`programs/native/runtime` selects `pocket_gles1::Renderer` with its `gles1`
feature and `pocket_gles2::Renderer` otherwise, and registers the renderer when
it creates the program. Trace stages 0 and 1 bracket DrawList generation;
stages 2 through 6 come from the renderer.
