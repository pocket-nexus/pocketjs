# Museum native builds

**`pocket compile` produces an application package; `pocket build` consumes that package or builds a reusable native runtime.** The native recipes live in `tools/build/programs/`. Their runtime configs live in `programs/<id>/pocket.runtime-config.ts`; the host source remains in `hosts/`.

| Program | Profile | Native artifact | Application input |
|---|---|---|---|
| `pocketbook` | `pocketbook` | ARM Linux executable, payload directory and `.app` launcher | `--pocket` |
| `moto-g-play` | `moto-g-play-dev` | `runtime/template.apk` and `runtime.json` | supplied to `pack` |
| `redmi-1s` | `redmi-1s-dev` | `runtime/template.apk` and `runtime.json` | supplied to `pack` |
| `blackberry-classic` | `blackberry-qnx-dev` | `pocketjs-blackberry-classic-hero.bar` | `--pocket` |
| `meizu-m8` | `meizu-m8-dev` | `PocketJS.exe` and `PocketJSStop.exe` | `--pocket` |
| `nokia-e7` | `symbian-e7-dev` | `<output>.sis` | `--pocket` |
| `ios-simulator` | `ios-dev` | `PocketShell.app` and `PocketApple.xcframework` | `--pocket` |
| `iphone2g` | `iphone2g-dev` | `PocketJSDemo.app` | `--pocket` |
| `iphone4s` | `iphone4s-dev` | `PocketJSiPhone4S.app` | `--pocket` |
| `ipodtouch6` | `ipodtouch-dev` | `PocketJSiPod.app` | `--pocket` |
| `ipodtouch4` | `ipodtouch4-dev` | `runtime/PocketJSRuntime` and `runtime.json` | supplied to `pack` |

## Programs that embed an application

Compile against the same runtime config used for the native build:

```sh
bun tools/pocket.ts compile --manifest apps/iphone2g-demo/pocket.json \
  --project-root . --runtime-config programs/iphone2g/pocket.runtime-config.ts \
  --output dist/iphone2g/application.pocket
bun tools/pocket.ts build --config programs/iphone2g/pocket.runtime-config.ts \
  --pocket dist/iphone2g/application.pocket --out dist/iphone2g
```

**The build executor checks the package generation, profile hash, manifest and resolved plan before starting a native tool.** Native recipes use the admitted JavaScript and resource bytes. Application source files are not needed for this step. A missing package is an error; the recipe does not select a demo.

The Nokia E7 recipe retains its native extension and presentation options. Pass those after `--`, for example `-- --frame-rate 60 --core-library /absolute/path/lib.a`. The iPod touch 4 compatibility command retains application-specific native cores and artwork selected by its descriptor; it takes `build --pocket <file>` and uses the same package admission checks.

## Reusable runtimes

Android and the default iPod touch 4 config build without application code. Packaging combines a runtime with an application:

```sh
bun tools/pocket.ts build --config programs/redmi-1s/pocket.runtime-config.ts \
  --out dist/redmi-runtime
bun tools/pocket.ts compile --manifest apps/clear/pocket.redmi-1s.json \
  --project-root . --runtime-config programs/redmi-1s/pocket.runtime-config.ts \
  --output dist/clear-redmi.pocket
bun tools/pocket.ts pack --config programs/redmi-1s/pocket.runtime-config.ts \
  --runtime dist/redmi-runtime/runtime --pocket dist/clear-redmi.pocket \
  --out dist/clear-redmi.apk
```

**The runtime directory records its profile hash and hashes of the native files.** `pack` verifies those records and the selected package variant. Android packaging uses the configured APK signer; iPod packaging preserves the runtime's native signature and adds the application payload.

## Toolchains and deployment

The existing host setup and doctor commands inspect pinned toolchains. Build recipes report missing SDKs, sysroots or compiler images and do not substitute a host executable. iOS simulator builds use `ns build ios --emulator`; they do not boot or launch a simulator.

The existing deployment commands remain separate. Compatibility `build --pocket` commands write their established `dist/` directories; deployment consumes the built artifact and its native receipt. QNX and Meizu receipts use `native-build-receipt.json` beside the artifact, leaving `build-receipt.json` for the common build executor. Apple bundle receipts remain inside their `.app` directories.
