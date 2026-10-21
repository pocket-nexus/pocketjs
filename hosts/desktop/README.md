# Desktop program composition

Each shell or application owns **one `UiProgram`**, which composes a Runtime,
package source, generated QuickJS guest adapter and device input source. The
service provider, text offload namespace and compositor surface table use the
same UI operation context. Runtime owns guest turns and core advancement.

Each instance registers a `WgpuRenderer` and device-owned display. The display
leases at most **three retained GPU targets**. Runtime waits for rendering
before publishing a lease to the window thread. The window submits sampling
before releasing the lease; the shared GPU queue orders that read before reuse.
Resize replaces the pool while outstanding leases keep their old textures.

The shell renderer samples registered child textures in compositor order.
Child texture changes are independent of shell DrawList revisions, so the
GPU display requests complete redraws and publishes no damage-buffer identity.
Hidden instances follow the System plan's suspend/continue policy. Idle hashes
and output-channel backpressure defer presentation through Runtime's pending
frame API without adding guest turns.

The program thread uses `pocket_runtime::timing::TickSchedule` at 60 Hz. Native
window, clipboard, service and offload adapters retain their existing roles.

Run `cargo +stable test --locked --manifest-path hosts/desktop/Cargo.toml` for
host tests. On a GPU acceptance host, append `gpu::tests -- --ignored` to run
the target lease and Full Runtime pixel-readback tests.
