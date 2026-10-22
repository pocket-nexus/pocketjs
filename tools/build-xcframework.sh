#!/bin/bash
# Builds PocketApple.xcframework: the pocket-apple Rust staticlib plus the
# compiled PocketSurfaceView, packaged as a dynamic framework per slice
# (device arm64 + simulator arm64). Output: engine/ios/dist/.
set -euo pipefail

REPOSITORY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$REPOSITORY_DIR/engine/ios"
DIST="$REPOSITORY_DIR/.pocket-build/ios/xcframework"
CARGO_TARGET_DIR="$REPOSITORY_DIR/.pocket-build/ios/cargo-target"
export CARGO_TARGET_DIR
CONTRACTS_DIR="$REPOSITORY_DIR/contracts/generated"
RUST_TOOLCHAIN="$(bun -e 'const { STABLE_RUST_TOOLCHAIN } = await import(process.argv[1]); console.log(STABLE_RUST_TOOLCHAIN)' "$REPOSITORY_DIR/tools/build/toolchains/rust.ts")"
MIN_IOS="16.0"

rm -rf "$DIST"
mkdir -p "$DIST"

build_slice() {
  local rust_target="$1" sdk="$2" clang_target="$3" slice="$4"

  (cd "$REPOSITORY_DIR" && IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS" cargo +"$RUST_TOOLCHAIN" build --manifest-path "$REPOSITORY_DIR/Cargo.toml" -p pocket-apple --release --locked --target "$rust_target")

  local fw="$DIST/$slice/PocketApple.framework"
  mkdir -p "$fw/Headers" "$fw/Modules"

  cp "$IOS_DIR/include/pocket_apple.h" "$fw/Headers/"
  cp "$CONTRACTS_DIR/pocket_runtime.h" "$CONTRACTS_DIR/pocket_drivers.h" "$CONTRACTS_DIR/pocket_spec.h" "$fw/Headers/"
  cp "$IOS_DIR/uikit/PocketSurfaceView.h" "$fw/Headers/"
  cat > "$fw/Headers/PocketApple.h" <<'EOF'
#import <PocketApple/PocketSurfaceView.h>
#include <PocketApple/pocket_apple.h>
EOF
  cat > "$fw/Modules/module.modulemap" <<'EOF'
framework module PocketApple {
  umbrella header "PocketApple.h"
  export *
  module * { export * }
}
EOF
  cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>PocketApple</string>
  <key>CFBundleIdentifier</key><string>dev.pocketjs.PocketApple</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>PocketApple</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
EOF

  xcrun -sdk "$sdk" clang \
    -target "$clang_target" \
    -fobjc-arc -fapplication-extension \
    -dynamiclib \
    -install_name "@rpath/PocketApple.framework/PocketApple" \
    -I "$IOS_DIR/include" -I "$CONTRACTS_DIR" \
    "$IOS_DIR/uikit/PocketSurfaceView.m" \
    "$CARGO_TARGET_DIR/$rust_target/release/libpocket_apple.a" \
    -framework Foundation -framework UIKit -framework QuartzCore -framework CoreGraphics \
    -dead_strip \
    -o "$fw/PocketApple"
}

build_slice aarch64-apple-ios iphoneos "arm64-apple-ios$MIN_IOS" ios-arm64
build_slice aarch64-apple-ios-sim iphonesimulator "arm64-apple-ios$MIN_IOS-simulator" ios-arm64-simulator

rm -rf "$DIST/PocketApple.xcframework"
xcodebuild -create-xcframework \
  -framework "$DIST/ios-arm64/PocketApple.framework" \
  -framework "$DIST/ios-arm64-simulator/PocketApple.framework" \
  -output "$DIST/PocketApple.xcframework"

echo "OK: $DIST/PocketApple.xcframework"
