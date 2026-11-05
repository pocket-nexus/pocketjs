# Device ownership and evidence

`tools/device-lease.ts` uses OS `flock` on macOS and Linux. Lock files live in
`~/.pocketjs/device-leases`, shared by PocketJS, Atlas and OpenStrike worktrees.
The file stays in place; the kernel releases its lock when the owner exits,
including SIGKILL. Do not delete a live lock file: another inode would allow a
second owner. A contention error reports the owning PID and working directory.

The current CLI keys are `psp:usb`, `vita:usb` and `3ds:wire`. The 3DS key
serializes the host's handheld control sessions, including hostname/IP aliases.
USB servers use separate `psp:usb:transport` and `vita:usb:transport` keys so
control commands can use an existing server. There must still be one PSPLINK
USB host, with the shared directory identified before staging or launching.

Wrap an acceptance run, including its child commands, with:

```sh
bun tools/device-lease.ts psp:usb -- bun path/to/acceptance.ts
```

`guardDeviceCommand(key)` integrates an existing CLI through a parent process
that owns the lock until the command exits. `withDeviceLease(key, callback)`
provides `lease.assertHeld()` and `lease.environment` for in-process tools.
Pass that environment to child processes. Async contexts isolate parallel
callers; only children of the owning run may inherit its token. Raw tools and
older checkouts that omit these APIs do not participate in this cooperative
protocol. Inspect existing sessions before the first deployment.

`tools/device-evidence.ts` binds observations to a device key, runtime build
and asset SHA-256 map. Every observation checks that identity again. An
application supplies the identity reported or read back by its runtime; a
local build file alone cannot establish it. The receipt contains timestamps
and belongs in ignored validation output. It is separate from deterministic
compiler receipts.

Atlas owns its camera coverage, render settings and frame budgets. OpenStrike
owns its maps, game scenarios and interaction checks. The shared helper does
not infer successful rendering or hardware acceptance from a package hash.
