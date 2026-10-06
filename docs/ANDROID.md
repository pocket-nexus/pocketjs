# Android

`hosts/android` is one host: a Java Activity with a `GLSurfaceView`, a JNI
runtime (`app/jni/runtime.c`) over QuickJS-C, the shared Rust core and its
OpenGL ES 2 renderer. `tools/android.ts` builds it for a named profile. **A
profile is a target id, that target's resolver and the toolchain file
`tools/cli/<profile>-toolchain.json`.** Both targets share host ABI 9 and
stay outside the public `POCKET_TARGETS` registry.

| Profile | Target | Logical | Panel | Libraries | minSdk | NDK |
|---|---|---|---|---|---|---|
| `moto-g-play` (default) | `moto-g-play-dev` | 360×800 | 720×1600 | `arm64-v8a` (API 23) | 23 | 27.1.12297006 |
| `redmi-1s` | `redmi-1s-dev` | 360×640 | 720×1280 | `armeabi-v7a` (API 18), `arm64-v8a` (API 21) | 18 | 21.4.7075529 |

Both profiles raster at density 2, target SDK 34 and compile the Activity
against platform 34. [Clear IME setup](CLEAR_IME.md) covers the Moto G Play
device commands.

## The Redmi 1S profile

The measured device is the Redmi 1S (`armani`): Android 4.3, four Cortex-A7
cores, an Adreno 305, a 720×1280 panel. `tools/redmi-1s-profile.ts` declares
`redmi-1s-dev` with `input.touch`, `text.glyphs.baked` and `io.offload`.
**`input.buttons` is absent, as it is for `ipodtouch4-dev`: a manifest that
requires it does not resolve.** `ui.physics` is absent because the host does
not bind ops 52..56.

**One APK serves an Android 4.3 phone and a 64-bit phone.** It carries an
`armeabi-v7a` library linked against API 18 and an `arm64-v8a` library linked
against API 21 with 16 KB segment alignment (`-z max-page-size=16384`). NDK
27 links against API 21 and later; NDK 21.4 carries the C library stubs of
API 18. The link runs with `--no-undefined` against those stubs, and the Rust
core is `no_std` (`bare-platform`), so the API 18 library needs no C library
shim.

## Fitting the panel

**`PocketSurfaceView.onMeasure` sizes the surface to the plan's logical aspect
ratio inside the window and the root layout centres it over black.** The
picture has one scale in both directions on every panel. A 360×640 build
fills a 720×1280 panel at 2 device pixels a logical pixel; on a 1080×2400
panel it is 1080×1920 with 240 black pixels above and below.
`dispatchTouchEvent` subtracts the surface's origin, and the native contact
latch scales by the surface's size, so a contact reaches the guest in logical
pixels of the same rectangle.

## Building

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal
bun redmi-1s setup      # platform 34, build tools 35.0.0, NDK 21.4.7075529, QuickJS, both Rust targets
bun redmi-1s doctor
bun redmi-1s build      # apps/clear/pocket.redmi-1s.json -> dist/redmi-1s/pocket-clear.apk
```

`POCKETJS_ANDROID_SDK_ROOT` selects the SDK and `JAVA_HOME` selects Java 17.
`build` is `build-demo` (the guest bundle of the toolchain file's manifest)
followed by `build-app` (the libraries, the Activity and the package).

**`build-app --plan` builds an app this repository does not name:**

```sh
bun tools/android.ts --profile=redmi-1s build-app \
  --plan=<plan.json> --project-root=<dir> --out=<file.apk> [--icon=<png|svg>] [--release]
```

- `--plan` is a plan resolved for the profile's target, for example by
  `validateAndResolveBuildPlan(manifest, { target: REDMI_1S_TARGET }, REDMI_1S_CONTRACTS)`.
  The tool verifies its checksum and its target, then compiles the guest with
  `tools/build.ts` from `--project-root` (default: this repository).
- **The package name, label and version come from the plan**: the app id with
  each `-` as `_`, the title, and `major * 1_000_000 + minor * 1_000 + patch`
  as the version code.
- `--out` is the APK's path (default: the toolchain file's output).
- The build directory is `.pocket-build/<profile>`, so builds of one profile
  run one at a time.

## The launcher icon

**The package carries one icon file a density**: `mipmap-mdpi` to
`mipmap-xxxhdpi` at 48, 72, 96, 144 and 192 pixels (`tools/android-icon.ts`).
A launcher draws the file of its own bucket. A single bitmap in
`res/drawable` is an mdpi file, which an xhdpi launcher scales up by 2.

- **`--icon=<file>` names the source**: a square PNG of at least 192 pixels a
  side, or an SVG that declares its width and height. Without it the source
  is PocketJS's mark on its plum ground, `assets/brand/pocketjs-avatar-dark.svg`.
- **Each file is made from the source once.** A bitmap is averaged down: a
  destination pixel is the mean of the source area it covers, in
  premultiplied colour. A vector is rastered for each size at four samples a
  pixel in each direction.
- **A source is never scaled up.** The tool refuses a bitmap under 192
  pixels a side and one that is not square, before the first compile.
- aapt2 runs with `--no-crunch`, so the files in the package are the bytes
  the tool wrote.

Art that fills the square to its corners suits a launcher that cuts its own
shape: MIUI V5 masks the icon to its rounded plate.

## Signing

**A development build is debuggable and signed with a debug key** kept in the
toolchain cache (`~/.cache/pocket-nexus/android/signing`). `run-as` reads its
private files.

**`--release` signs with the Pocket Nexus Android release key and sets
`android:debuggable="false"`.** The key is a PKCS #12 keystore outside every
repository: `POCKET_NEXUS_ANDROID_KEY` names it, the default is
`~/.config/pocket-nexus/signing/pocket-nexus-android-release.p12`, and its
alias is `pocket-nexus`. The password is the first line of the `.password`
file beside the keystore; apksigner reads that file, so the password is in no
command line and no log. A missing keystore or password file stops the build
before the first compile. A phone holding one kind of build refuses the other
kind until the package is uninstalled.

Each APK carries **v1 and v2 signatures**, which Android reads from API 18 on.

## The package and its receipt

**Two builds of one checkout produce the same APK bytes.** aapt2 dates its
entries 1980-01-01; the tool gives `classes.dex` and the libraries the same
date, adds them with `zip -X` in a fixed order, and links each library with
`--build-id=none`.

The receipt stands beside the APK (`<profile>.receipt.json` for the default
output, `<name>.receipt.json` for `--out=<name>.apk`). It records the plan
hash, the package identity, `release`, both SDK levels, the APK's size and
SHA-256, **`signer.certificateSha256`**, the icon's source with its SHA-256
and the SHA-256 of each density's file, each library's ABI, API level, size,
SHA-256 and ELF summary, and the `apksigner verify` and `aapt dump badging`
output.

## A game without a compile: the runtime and the repack

**The native library takes four values from the profile and none from the
app** (target id, host ABI, logical viewport, raster density), so every app
of a profile links the same `libpocketjs.so` and `classes.dex`. The runtime
build compiles them with no guest and links them into one template APK;
the repack adds a game to it in TypeScript, with no SDK tool.

```sh
bun tools/runtime.ts android        # dist/runtime/android/ with runtime.json
bun tools/community-key.ts          # the community key as two DER files
bun tools/pocket-pack.ts build --manifest <pocket.json> --project-root <dir> \
  --target redmi-1s-dev -o game.pocket
bun tools/repack.ts --target android --runtime dist/runtime/android --pocket game.pocket \
  --id <id> --title <title> --author <author> --version <x.y.z> [--icon <square.png>] -o game.apk
```

- **The runtime directory holds `template.apk`, the two templates it was
  linked from (`AndroidManifest.xml`, `res/values/strings.xml`) and
  `runtime.json`**: target `redmi-1s-dev`, host ABI 9, the PocketJS commit,
  the SDK levels, the ABIs and the size and SHA-256 of each file.
  `template.apk` is aapt2's link of the runtime with the identity
  `dev.pocket-nexus.runtime.template` (`ANDROID_TEMPLATE_IDENTITY`), the
  default icon at five densities, empty `assets/app.js` and `assets/app.pak`,
  `classes.dex` and `lib/armeabi-v7a/libpocketjs.so`,
  `lib/arm64-v8a/libpocketjs.so`; it is unsigned (1.76 MB for `redmi-1s`).
- **`tools/repack/android.ts` checks before it writes**
  (`tools/repack/shared/runtime.ts`): the runtime's files against
  `runtime.json`, the `.pocket` footer, a `redmi-1s-dev` variant at host ABI
  9 whose app id is `--id`, the variant's viewport against the runtime's, and
  the template's SDK levels. Any mismatch stops the repack with the reason.
- It keeps the template's entries in their order and replaces five things.
  **The compiled `AndroidManifest.xml` gets the package name, versionCode
  and versionName; `resources.arsc` gets the package name and
  `string/app_name`** (`tools/repack/shared/android-resources.ts`). Each
  string pool is written as aapt2 writes one: aapt2 sorts a pool (the
  manifest's attribute names with resource ids first, then every other string
  by its UTF-8 bytes), so a changed string moves to its sorted place and every
  reference is renumbered; the table's UTF-8 pool writes a character past
  U+FFFF as two 3-byte surrogates. The variant's bundle (without the
  section's NUL terminator) and pack become `assets/app.js` and
  `assets/app.pak`, the files `PocketActivity` reads. `--icon`, a square PNG
  of any size, is scaled to the five densities; without it the template's
  icon stays. Stored entries are 4-byte aligned and stored `.so` files
  4096-byte aligned, as `zipalign -p 4` places them.
- **The names:** the package name is the id with each `-` as `_`, and a
  dot-separated segment that then starts with a digit gets `x` in front
  (`dev.pocket-nexus.studio.2pac.8-ball` →
  `dev.pocket_nexus.studio.x2pac.x8_ball`); each segment is a letter, then
  letters, digits and `_`, and the name holds at most 127 characters (a
  resource table's limit). Two ids map to one package name when one has a
  segment `x<digit>…` where the other has `<digit>…`. The versionCode is
  major × 1 000 000 + minor × 1 000 + patch. The label is the title with
  leading and trailing ASCII whitespace removed and each inner run of it as
  one space, which is what aapt2 makes of a string resource; a control
  character is refused.
- **Signing is v1 + v2 with Web Crypto** (`tools/repack/shared/apk-sign.ts`):
  `META-INF/MANIFEST.MF`, `CERT.SF` (`X-Android-APK-Signed: 2`) and
  `CERT.RSA` (PKCS #7, RSA PKCS #1 v1.5, SHA-256), then the APK Signing Block
  with the v2 signature before the central directory. Android 4.3 reads the
  v1 signature and not the v2 block. The repack verifies the v2 signature with the certificate's public
  key before it returns, so a key that is not the certificate's is refused.
- **A repacked game is signed with the Pocket Studio community key, never
  the Pocket Nexus release key.** The repack takes
  `signer: { privateKey, certificate }`: a PKCS #8 DER key (or a `CryptoKey`
  imported for RSASSA-PKCS1-v1_5 with SHA-256) and an X.509 DER certificate.
  **It refuses a certificate whose SHA-256 is not
  `POCKET_STUDIO_COMMUNITY_SIGNER`** unless the caller names another
  certificate in `options.certificateSha256`, which the tests do for a
  throwaway key. `bun tools/community-key.ts` turns the keystore
  `~/.config/pocket-nexus/signing/pocket-studio-community.p12`
  (`POCKET_STUDIO_COMMUNITY_KEY` names another) into
  `pocket-studio-community.pkcs8.der` and `pocket-studio-community.cert.der`
  beside it, mode 600. OpenSSL reads the password from the `.password` file
  (`-passin file:`), and the tool writes nothing unless the certificate is
  the community certificate and the key signs what it verifies. A Worker
  holds the two files' bytes as secrets.
- **The same inputs give the same APK bytes on one JavaScript runtime**: every
  entry is dated 1980-01-01, the entries keep the template's order, and RSA
  PKCS #1 v1.5 signatures carry no time. The deflate streams (zip entries and
  the icons' PNG data) come from the runtime's `CompressionStream`, so Bun and
  workerd write different compressed bytes for the same uncompressed entries
  and pixels.
- **aapt2, zipalign and apksigner are the test oracle.** Where the Android SDK
  is installed, `tests/repack-android.test.ts` links each game of a corpus
  (hyphens, digit segments, quotes, a backslash, Japanese, an emoji label,
  whitespace runs) with aapt2, aligns it with zipalign and signs it with
  apksigner, and requires the TypeScript APK to hold the same entries in the
  same order with the same bytes outside `META-INF/`, to pass
  `apksigner verify` (v1 and v2) and `zipalign -c -p 4`. It runs on the test
  fixture and on `dist/runtime/android` when one is built. Without the SDK
  (CI) those tests skip, and a verifier in `tests/helpers/apk-test-signer.ts`
  checks both signatures.

## On the device

A running host rewrites `files/runtime.txt` in its private directory every 60
frames: the frame count, the logical and surface sizes, and four times in
microseconds over those 60 frames. `tick_us` is the mean of the guest's
`frame()` with the core's tick, `render_us` the mean of the GL submission,
`frame_us_max` the slowest sum of the two, and `interval_us` the mean time a
frame took with its swap.

```sh
adb install -r dist/redmi-1s/pocket-clear.apk
adb shell am start -n dev.pocket_nexus.clear/dev.pocketnexus.android.PocketActivity
adb shell run-as dev.pocket_nexus.clear cat files/runtime.txt   # a development build
```

MIUI V5 shows two confirmation screens on the phone for each `adb install`,
and `adb exec-out` is absent on Android 4.3: `adb shell screencap -p
/sdcard/frame.png` followed by `adb pull` takes a frame.

**The MIUI V5 launcher keeps the bitmap of an icon it has drawn.** After a
package is replaced, and after an uninstall followed by an install, the
launcher page shows the earlier icon until the launcher restarts: `adb shell
am force-stop com.miui.home`, then the Home key. MIUI writes the plated icon
it will draw to `/data/system/customized_icons/<package>.png` (136 pixels a
side) at install time; `adb pull` reads it.

Measured with Pocket Clear on the Redmi 1S at 55 °C: **`tick_us` 1600 to 2000
and `render_us` 1500 to 1900 on the Lists screen at rest and under repeated
swipes, `interval_us` 16400 to 17700**, and 125 consecutive presented frames
16.67 ms apart in `dumpsys SurfaceFlinger --latency SurfaceView`. The slowest
single frame under swipes took 28.6 ms.
