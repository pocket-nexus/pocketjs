# Pocket Museum migration

**Device programs and their build policy live in the separate `pocket-museum`
repository.** This includes PocketBook, Moto G Play, Redmi 1S, BlackBerry Classic,
Meizu M8, Nokia E7, the NativeScript iOS shell, iPhone 2G and 4S, and iPod touch
4 and 6. Their source, profiles, runtime configurations, toolchains, deployment
commands, tests and runbooks move together.

The framework retains shared UIKit integration, GLES renderers, Android JNI and
input helpers, package admission, the native compatibility program and the
generic APK repacker. A platform driver does not import Museum code.

## Dependency and checkout

**`framework.lock.json` pins one full framework commit.** Museum's `bootstrap.ts`
creates an independent checkout under ignored `.pocket-deps/framework` and
checks its revision and working state. It does not copy engine sources into the
Museum repository. Before a framework commit is published, supply a local Git
repository containing that commit:

```sh
cd /path/to/pocket-museum
bun bootstrap.ts --source /path/to/pocketjs
(cd .pocket-deps/framework && bun install --frozen-lockfile)
bun install --frozen-lockfile
```

The local source changes the clone origin; it does not change the required
commit. A dependency with local changes or a different revision is rejected.
Preserve local changes before replacing an existing dependency checkout.

## Command migration

**Device profile IDs are no longer built-in framework targets.** Import a
Museum profile by module path, or select its runtime configuration. A compile
step produces the application package; the program consumes that package:

```sh
bun run pocket compile --target ./profiles/iphone2g-dev.ts \
  --manifest apps/iphone2g-demo/pocket.json --project-root . \
  --output .pocket-build/app.pocket
bun run pocket build --config programs/iphone2g/pocket.runtime-config.ts \
  --pocket .pocket-build/app.pocket --out .pocket-build/native
```

Use the package filename reported by `compile`; it comes from the application's
`app.output`. Museum's `tools/ios.ts`, `tools/symbian.ts` and device commands own
deployment. The framework CLI no longer dispatches `pocket ios`, `pocket
symbian`, or the removed device aliases. The device profiles retain their
software facts and content hashes.

Museum has its own Bun and Cargo lockfiles. PocketBook consumes framework
crates through versioned path dependencies into the pinned checkout. C-shell
programs link one archive built from `programs/native/cabi` in that checkout.
**Run evidence stays in ignored `.pocket-build/validation/`.** Tests retain
fixtures required to reproduce package, signing and input behavior.
