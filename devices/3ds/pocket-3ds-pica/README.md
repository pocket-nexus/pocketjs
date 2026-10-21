# pocket-3ds-pica

`pocket_pica_driver.h` exposes an independent **Renderer and DisplayOutput over
the public C ABI**. The driver consumes DrawLists, texture/font views and target
identities. It does not include `Ui`, a guest engine or product services.
`programs/3ds/product/src/gfx.c` supplies camera/media texture leases, the native stage and
the development-menu overlay through explicit callbacks.

Each display borrows an unlinked, rotated RGBA8 citro3d target. A process-wide
monotonic identity prevents a target from another renderer instance from being
accepted. The application owns the citro3d context and serializes access. Driver
reset and destruction drain pending native work before releasing resources.

**Each submission owns its vertices, commands and exact texture versions until
retirement.** Image keys contain handle and revision; font keys also contain the
guarded page. The 16 MiB default cache evicts unpinned least-recently-used entries.
Pending versions survive capacity errors and out-of-order screen retirement.
Native resolver callbacks must pin their allocation until the release callback.
Geometry has a per-submission limit of 32,768 vertices and 2,048 commands; overflow
fails the submission. Geometry allocations are separate for simultaneous screens.

A renderer wait closes the frame and calls blocking `C3D_FrameBegin`, which drains
the preceding GPU queue. It parks the texture and buffer bindings before closing
an empty frame. This depends on citro3d's [render queue implementation](https://github.com/devkitPro/citro3d/blob/master/source/renderqueue.c):
`C3D_FrameSync` waits for VBlank, while blocking `C3D_FrameBegin` waits for and clears
the queue. Display flush uses `C3D_SyncDisplayTransfer` outside a frame, waits for
PPF, then swaps that screen. The host owns the shared VBlank cadence. Right-eye
copies run only in 3D mode because libctru aliases both pointers in 2D mode.

`pocket_pica.h` remains the header-only texture kernel used by OpenStrike and
Atlas. It checks linear-memory allocation, mip payload size, CPU upload/cache
publication and release. It leaves texel layout, filters, bindings, shaders and
frame scheduling to callers. Stop submission and wait for GPU completion before
releasing or overwriting in-flight storage; the kernel itself does not wait.

Validation commands:

```sh
bun tools/3ds-contracts.ts --check
bun test tests/pica-kernel.test.ts tests/pica-driver.test.ts tests/3ds-profile.test.ts
bun tools/3ds.ts 3ds-demo
bun tools/3ds.ts 3ds-demo --capture
```

The driver test links the real no_std runtime archive for DrawList validation and
glyph expansion, with instrumented citro3d/libctru calls. It covers two screens,
version changes before retirement, pinned-capacity failures, native leases,
short ABI prefixes, foreign target identities, stereo copies and pending teardown.
The native build uses the digest-pinned devkitARM image and pinned QuickJS source.
Host tests and native linking do not establish GPU rendering or performance; final
device validation supplies those results.
