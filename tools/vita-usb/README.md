# Vita USB dependency

`bun tools/vita-usb.ts` builds Cpasjuste/usbhostfs at
`074283858c15ae2ffbac79807d7b06680ce3f9bd` with the adjacent patch.
The source stays in the ignored toolchain cache. The upstream PSPLINK files
retain their BSD notices; Vita port authorship stays in the upstream checkout.

The patch uses current VitaSDK UDCD layouts and cache APIs, the SDK kernel C
library, and an experimental USB product ID `054c:0f01`. This local development
ID separates the transport from a PSP using PSPLINK (`054c:01c9`); it is not a
Sony-assigned PocketJS product ID. The matching host client selects only this
ID. The patch also rejects oversized USB replies, preserves failed-open
errors, and cancels pending endpoint requests on cable detach.
No TCP/Wi-Fi transport is involved.

File read, write, and seek hooks release the kernel object reference acquired
for each operation, including failed transfers. Closing a file releases its
lookup reference before deleting the owned UID.

`SceSysmemForKernel` has different library/function NIDs in the SDK's 3.60
and 3.63 databases. The driver resolves `ksceGUIDKernelCreateWithOpt` through
taiHEN at startup. It has no static import of that firmware-dependent library;
the build inspects the linked ELF to enforce this. Resolution, USB activation,
and I/O hook failures are recorded in the per-title `driver.json` diagnostic.
Descriptor tables include zero-length terminators and are initialized before
driver registration. Failed USB takeover restores the system controller and
MTP driver; the diagnostic retains the failure and each recovery result.
`startCallback` identifies whether UDCD entered the driver's start callback.

The VPK carries the kernel driver. The runtime loads it through taiHEN after
application launch; it does not edit `tai/config.txt`. HENkaku's unsafe homebrew
permission is needed for kernel loading. The driver persists across native
process replacement. A device reboot unloads it.
