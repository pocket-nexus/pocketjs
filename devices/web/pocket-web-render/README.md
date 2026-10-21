# Pocket wgpu renderer

`pocket-web-render` translates DrawList through `pocket-draw-ops`,
`pocket-tri-batch`, `pocket-glyph-pages`, and `pocket-tex-cache`. Its resources
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
Native `TEXT_RUN` is unsupported; glyph atlas, image, gradient, triangle, scissor,
and registered compositor-surface operations use the shared DrawList vocabulary.

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
`render`, `encode` and `register_target` then return `Failed`. The infallible
surface-binding setter performs no work after closure. Drop uses the same path.
An adapter which shares the renderer must call shutdown when its registration
owner is dropped, even if other handles retain the renderer. Normal retirement
waits only the requested submission. No method destroys a shared device or calls
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
image formats, gradients, triangles, glyph replacement, surfaces, and sRGB.

Run the independent driver tests with:

```sh
cargo test --locked --manifest-path devices/web/pocket-web-render/Cargo.toml
cargo clippy --locked --manifest-path devices/web/pocket-web-render/Cargo.toml --all-targets -- -D warnings
```

These tests require a native GPU adapter; Mesa Vulkan is sufficient on CI. They
read back two encoders submitted after resource mutation and driver destruction,
two targets with reversed retirement, capacity failure and retry, foreign/stale
handles, font replacement, native attachment-validation failure, and shutdown
after untracked submission or a resource callback panic.
