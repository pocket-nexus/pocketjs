# PS Vita wired development

**The stock Vita runtime enables USB debugging in default builds.** The VPK
contains the USBHostFS kernel driver; application launch loads it through
taiHEN. HENkaku's unsafe homebrew permission is required. The build generates
an unsafe-homebrew SELF for this purpose. `--no-usb-debug` excludes the driver,
disables the transport worker, and retains cargo-vita's safe SELF.

**USB carries updates, status, commands, and framebuffer captures.** There is
no Wi-Fi discovery or wireless fallback. The computer serves an isolated
directory as `host0:`. The app's worker owns every USB filesystem operation;
the rendering thread exchanges one request/reply at a time with that worker.
Successful USB status exchanges reset the display and automatic-suspend idle
timers. Manual suspend remains available; disconnected apps keep the system's
idle behavior.

## First installation

The computer needs VitaSDK, CMake, a C compiler, Bun, and Rust
`nightly-2026-05-28`. The USB host also needs libusb 0.1 compatibility headers
and pkg-config; on macOS install `libusb-compat` and `pkgconf` with Homebrew.
The first build downloads the pinned USBHostFS source. Later builds use
`.pocket-build/toolchains/vita-usb/`. The source revision and SDK adaptations
are recorded in `tools/vita-usb/`.

```sh
bun run vita:dev build --app hero
# In VitaShell, enter USB storage mode.
bun run vita:dev install --app hero --mount /Volumes/PSV
```

`install` copies `hero-main.vpk` to `ux0:data/pocketjs-dev/` and compares its
SHA-256 with the source. Eject the storage volume, exit VitaShell's transfer
mode, install the VPK, and open Pocket Hero from LiveArea. A successful copy
does not establish that the app has launched.

```sh
# Keep this process running in one terminal.
bun run vita:dev serve --app hero
# Other terminals:
bun run vita:dev status --app hero
bun run vita:dev capture --app hero
```

The device enumerates as **`054c:0f01`**, an experimental development ID used
by this driver and its matching host. PSP PSPLINK uses `054c:01c9`, so the
Vita host does not claim a connected PSP. On Linux, give the current user
access to `054c:0f01` through a udev rule. The shipped host build supports
macOS and Linux; Windows driver/host setup is not supplied by this command.

## Runtime menu

**L + R + SELECT opens the native menu.** The host consumes the chord until
release before processing launcher SELECT. While the menu is open, guest
input is cleared and guest rendering continues.

| Input | Action |
| --- | --- |
| Cross | Recreate the active JS guest and its native resources |
| Square | Queue a GXM capture to `menu-capture.rgba` and `menu-capture.json` in the USB share |
| Triangle | Return to the JS/PAK embedded in this native build |
| Circle | Close the menu |

The running `serve` command converts menu captures to PNG and prints the
output path under `.pocket-build/validation/vita-usb/`.

A JavaScript exception leaves the native menu and USB worker available. USB
builds interrupt JavaScript evaluation after **5 seconds**, or a frame turn
after **250 ms**, to recover from loops in guest code. The runtime retains
the error text in status. GPU/native faults can still require
reopening the LiveArea bubble or rebooting the device.

**The menu reports driver loading and startup errors.** `0x8002d003` means
a module dependency library is missing. The driver resolves the sysmem export
for the SDK's 3.60 and 3.63 library identifiers at startup; the build rejects
a static import of that library. Startup diagnostics are stored in
`ux0:data/pocketjs-dev/<TITLE_ID>/startup.json` and `driver.json` for retrieval
through VitaShell USB storage when the debug transport cannot connect.

**Status includes battery and free-memory measurements once per second.**
`telemetry` reports battery percentage, charging, external power, low battery,
battery temperature in hundredths of a degree Celsius, and free user/CDRAM/
physically contiguous memory in bytes. The worker writes `health.json` beside
the startup diagnostics every five seconds, including when USB is disconnected.
The latest write can be lost during a power failure; the snapshot does not
identify the cause of a shutdown.

## JS and resource updates

```sh
bun run vita:dev push --app hero
bun run vita:dev watch --app hero
# Or send an existing target-correct package:
bun run vita:dev push --app hero --package dist/hero-main.pocket
```

`push` compiles JS/PAK from the runtime's resolved build plan and sends one
`.pocket` package. `watch` watches the app directory; `--watch-dir` selects a
different source root. It rebuilds after a changed file timestamp and sends
the package after the build succeeds. For an external project, pass
`--runtime path/to/app.runtime.json` and `--project-root path/to/project`.
Failed builds or uploads remain pending in the watcher and are retried after
two seconds, including when USB reconnects without another source edit.

**An update succeeds after the candidate produces its first frame.** The
worker verifies the package checksum, Vita target, host ABI, app ID/output,
and native plan. The render thread retires the previous QuickJS realm, GPU
resources, core, and PAK at a closed-scene boundary. It then creates the new
guest. Failure during evaluation or the first frame restores the previous
bundle in a fresh realm and returns an error. JavaScript state resets;
this is whole-guest reload. The updated bundle remains in memory until reset,
application switching, or process exit.

The package limit is **32 MiB**. Source paths, title, version, and plan hash
may change without changing native services. Other plan changes require a
native rebuild. Updates in a multi-app VPK address its main guest; return to
that guest before pushing.

## Native and JS replacement

```sh
bun run vita:dev build --app hero
bun run vita:dev native --app hero
```

The build emits a VPK, SELF, and `.runtime.json` together. The native command
transfers the SELF over USB, checks its length/checksum, and stages it in an
inactive `pocket-dev-a.self` or `pocket-dev-b.self` slot under this title.
The module manager's loaded SELF path identifies the active slot; an unknown
path rejects the update before either slot is written.
After validating the upload, the worker releases the `app0:` mount to permit
writes to that title's directory. Guest JS/PAK remains in memory. The slot is
read back and its checksum checked before launch.
`sceAppMgrLoadExec` starts it through `app0:`. The replacement contains the
native runtime and its embedded JS/PAK. The limit is **64 MiB**.

**The original `eboot.bin` stays intact.** Reopening the installed LiveArea
bubble starts that recovery build. A native command reports success only
after a status receipt names the new build ID, shows completed frames, and
contains no guest error. A staged file or a restart request is not a success
receipt. Firmware launch errors are returned by the existing process.

The kernel driver remains loaded across native replacement and application
exit. Each process queries the kernel module namespace and reuses a resident
driver before attempting a load. It is not added to `tai/config.txt`;
rebooting unloads it and restores
the system's USB mode. Exit the host process before returning to VitaShell
USB storage. If another USB plugin owns the port, disable that plugin for
the development session and reboot before starting Pocket Runtime.

## Captures and acceptance

```sh
bun run vita:dev menu --app hero
bun run vita:dev capture --app hero --out .pocket-build/validation/vita-usb/manual/frame.png
bun run vita:dev reload --app hero
bun run vita:dev reset --app hero
```

**Captures read the 960 × 544 GXM render buffer after GPU completion.** The
render thread copies RGBA bytes before the next scene can reuse the buffer;
the worker transfers that copy over USB. The computer encodes PNG and writes
a JSON receipt with frame, native build, guest hash, and generation. This
capture includes native overlays and differs from the Vita3K CPU golden path.

The client rejects stale status, session mismatches, concurrent commands,
and incomplete response identities. USB upload failures retain the active
guest. If a command times out, its payload remains in the share for the
in-flight reader; a timeout does not prove that the device applied it.
**A pending request blocks later commands until its completion arrives.**
The device retains completed replies across interrupted writes and sends them
after USB reconnects, without executing the command again. The next command
retires a completed request and its upload. Restarting the host starts a new
session; the client waits for live status from that session before retiring
the previous session's request.

Physical acceptance requires a live status receipt, a changed guest hash
after JS push, a changed native build after SELF replacement, and a decoded
GXM capture from that process. Build and protocol tests do not establish
physical acceptance. Keep per-run results in ignored
`.pocket-build/validation/vita-usb/<run>/`.
