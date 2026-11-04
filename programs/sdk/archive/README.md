# pocket-archive

The C SDK archive. Every `pocket_runtime.h` function has **one `#[no_mangle]`
definition here**: the `pocket_runtime_*` and `pocket_tick_schedule_*` symbols
forward to the bodies in `pocket_runtime::abi`, and `pocket_draw_list_visit`,
`pocket_glyph_page_a8` and `pocket_raster_draw_op` call the draw-ops,
glyph-pages and raster crates. The ABI records, pointer checks and vtable
adapters are `pocket_drivers::abi`. **Driver registration selects the
backend.** Profile IDs, targets and devices are not Cargo features.

The SDK builds this crate with **default features disabled** and the
`software-renderer` feature, and contains no GLES driver. A C program supplies
the six `pocket_host_*` functions; the no_std build defines the global
allocator over them, the panic handler and `rust_eh_personality`. The `std` feature defines the six hooks over the
standard library instead; it is the Rust crate's default. `external-runtime`
omits the allocator and panic handler when the embedding Rust program owns
them, and keeps the symbols.

**`software-renderer` registers the software rasterizer as renderer 0.**
`pocket_runtime_create` calls `Runtime::set_software_renderer` with a
`pocket_raster::RasterRenderer` and the callback that rebuilds it at the
integer scale boot and the resize entry points select, before the C caller
registers drivers; `pocket_raster_draw_op` forwards to `pocket_raster::abi`.
Without the feature the crate does not depend on `pocket-raster`, renderer 0
stays empty, and `pocket_raster_draw_op` returns `POCKET_STATUS_UNSUPPORTED`
without writing the surface. The SDK export, the host contract runners, and
the ESP-IDF and SiFli archives enable it; `products/3ds/core` and the native
program do not.

**The `physics` feature installs `pocket-physics` in every runtime
`pocket_runtime_create` returns.** A package that requests `ui.physics` is
admitted only by such a runtime, and only when the profile declares the
capability. The SDK export and the 3DS reference program build enable it; the
IDF and SiFli archives leave it off, do not link `pocket-physics`, and report
ops 52..56 unsupported.

`programs/esp-idf/archive`, `programs/sifli/archive` and `products/3ds/core`
re-export this crate and add their own symbols. A Rust program that drives an
instance through `pocket_runtime::abi` without a C guest does not link it.

The public features are checked by
`tests/fixtures/cargo-features/contracts.ts`. Native programs select and link
renderers in their own composition.
