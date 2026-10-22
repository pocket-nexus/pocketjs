# PocketJS iPhone 4S host

This host targets the exact `iPhone4,1` / iOS 6.1.3 / `10B329` hardware tuple.
It compiles the shared legacy UIKit runtime for ARMv7 and links it against a
local sysroot extracted from the operator-provided, validated restore image.
Apple system binaries are never committed or included in the npm package.

The wrapper defaults to required OpenGL ES 1.1. Its retained UI core and UIKit
view both use density 2, and it accepts only a 640×960 renderbuffer for the
320×480 logical surface. SpringBoard artwork preserves the byte-identical
iPhone 2G `Icon.png` at 1× and rasterizes the matching local `Icon.svg` with 8×
supersampling for Retina, including the precomposed round mask, chrome bevel,
and glass highlight.

Use `bun iphone4s doctor`, `bun iphone4s prepare-sysroot`, and then the build,
deploy, launch, status, and capture commands documented in `docs/IPHONE4S.md`.
