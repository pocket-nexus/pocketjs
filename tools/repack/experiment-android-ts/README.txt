Experiment, not wired into tools/repack.ts: an Android repack with no SDK tools.

patch.ts  rewrites aapt2's binary AndroidManifest.xml (package name, versionCode,
          versionName) and resources.arsc (package name, label).
sign.ts   v1 (JAR) + v2 APK signatures with WebCrypto RSASSA-PKCS1-v1_5 / SHA-256.
run.ts    the 2026-10-07 run: patching Twenty48 Remix's manifest and table gave
          aapt2's bytes for Snack Snake Remix; a whole APK built from a template
          and signed with a throwaway key passed apksigner verify (v1 + v2) and
          zipalign -c, and the Redmi 1S (Android 4.3) installed and ran it.
          Its paths point at that session's scratch files.
