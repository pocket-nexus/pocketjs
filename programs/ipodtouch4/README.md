# iPod touch 4 program

This program runs on iPod touch 4 (`iPod4,1`, iOS 6.1.6). It owns its UIKit
host, input latch, libc support and service transport under this directory.
**Presentation requires OpenGL ES 1.1 and advances one core tick per display link.**

`programs/native/runtime` supplies the instance-based native program archive;
`programs/native/quickjs` composes it with the generated QuickJS guest.
`tools/ios6-setup.ts` prepares pinned Csu, QuickJS, dyld and iOS 6 sysroot
inputs. `tools/build/toolchains/ios6/manifest.json` records their provenance.

`tools/ipodtouch4-icon.ts` bakes the PocketJS artwork from
`assets/brand/pocketjs-icon.png`. See [the runbook](../../docs/IPODTOUCH4.md)
for application builds, packaging and device installation.
