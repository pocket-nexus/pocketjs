# Pocket wgpu renderer

`pocket-wgpu-render` translates DrawList through the `pocket-render` walk and
its `glyph_pages` and `tex_cache` modules. Its resources
implement `pocket-drivers::RenderResources`; it has **no dependency on Ui,
pocketjs-core, or pocket3d**. Hosts construct a `WgpuRenderer` with their wgpu
`Device`, `Queue`, and attachment format, then register it as a renderer.
Cargo features do not select this renderer.

The synchronous `Renderer` implementation supports **native wgpu backends**.
Browser WebGPU's `Device::poll(Wait)` does not wait for completion; the constructor
returns `Unsupported` on wasm. Browser software rendering remains a separate
composition choice until an asynchronous presentation contract is available.

Register each complete attachment with `register_target`, then use `target` to
obtain its `DeviceTarget`. Target IDs belong to one renderer instance and are
never reused. Unknown, foreign, removed, partial-region, and format-mismatched
targets are rejected. The driver supports RGBA8/BGRA8, UNORM or sRGB attachments,
and preserves the previous compositor's color encoding and fractional scale.
Glyph atlas, image, gradient, triangle and scissor operations use the shared
DrawList vocabulary. **`TEXT_RUN` draws through a host `TextPainter`**
(`set_text_painter`): the host text system that measured a run paints one
straight-alpha RGBA8 bitmap per distinct run (text, slot, alignment, box width,
line height, opaque colour, scale); the renderer keeps it as a texture, places
it on whole device pixels and modulates it by the run's alpha. A
`TEXT_RUN_XF` draws the same bitmap as two triangles through the run's 2x2
matrix about its origin. Bitmaps no
frame drew for 240 frames are released, and the least recently drawn ones
while more than 96 MiB are resident. Without a painter `TEXT_RUN` is
`RenderError::Unsupported`.

**Alpha accumulates as coverage.** Colour blends with straight alpha; the
alpha channel takes `src + dst × (1 − src)`, so a target cleared to transparent
holds a premultiplied picture that a host composites over its own frame.

Each render copies borrowed resources and allocates an **independent vertex
buffer**. Image and glyph-page versions use handle plus revision cache keys.
Submission references keep replaced versions alive across multiple targets and
out-of-order retirement. Capacity is checked before expansion or GPU upload.
Cache errors and native validation errors drain queued uploads before returning;
native wait timeouts retain ownership and retry until completion. Early retire
waits and stale/foreign tickets are rejected.

**`shutdown` reaches a queue checkpoint before releasing resources.** It submits
staged uploads, waits for all earlier queue work, then releases pending frames,
cache versions and target bindings. This covers a panic after native submission
but before token registration. Shutdown is idempotent and closes the driver;
`render`, `encode` and `register_target` then return `Failed`. Drop uses the
same path.
Under the device target contract (`pocket_drivers::target`), dropping the
runtime `Registration` calls shutdown even while the composition's
`RendererCell` retains the renderer. Unregistering a target that a pending
submission renders into removes it at once; the encoded submission keeps its
own view of the attachment. Normal retirement waits only the requested
submission. No method destroys a shared device or calls
`Texture::destroy`/`Buffer::destroy`.

For composition with other GPU passes, `encode` records into a host encoder and
returns an `EncodeLease`. The host can retain that lease until submission
completion, or call `retain_in_encoder`: **wgpu's encoder and command-buffer
resource tracker owns references to the bound native resources**. In wgpu-core
25.0.2 this is `CommandBufferMutable::trackers`, the render-pass bind-group/view
tracking, and `BufferTracker`'s `Arc<Buffer>` metadata. Handle Drop does not destroy
those allocations. A returned error requires discarding the affected encoder.
The old `pocket-ui-wgpu::UiRenderer` delegates through this path and retains its
existing Ui/encoder API. Its pixel comparison tests cover scale 1 and 2, all
image formats, gradients, triangles, glyph replacement, and sRGB.

Run the independent driver tests with:

```sh
cargo test --locked --manifest-path devices/wgpu/pocket-wgpu-render/Cargo.toml
cargo clippy --locked --manifest-path devices/wgpu/pocket-wgpu-render/Cargo.toml --all-targets -- -D warnings
```

These tests require a native GPU adapter; Mesa Vulkan is sufficient on CI. They
read back two encoders submitted after resource mutation and driver destruction,
two targets with reversed retirement, capacity failure and retry, foreign/stale
handles, font replacement, native attachment-validation failure, and shutdown
after untracked submission or a resource callback panic.
