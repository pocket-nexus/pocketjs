# Android platform primitives

`src/input.c` owns an input context and implements the generated
`pocket_input_source_v1` contract. Create one context for each runtime, pass
Android key and surface-relative touch events to it, and poll at the runtime
frame boundary. Contact lifetime ids remain stable from the first sampled
frame through release or cancellation. A down/up pair between polls appears
for one frame. Failed builder appends retain the entire snapshot for retry.
The append callback runs outside the context mutex; recursive polling fails
without consuming another snapshot. Stop producers and polling before destroy.

`src/jni.c` copies a bounded Java byte array into caller-owned memory, with a
NUL byte outside its reported length. It does not retain JNI array borrows.
`src/hooks.c` provides a monotonic clock and length-bounded Android logging.
These functions do not define the six `pocket_host_*` symbols; the linked
runtime archive owns those hooks.

Compile the three sources with `engine/runtime/compat/input.c`, and include
`platforms/android/include`, `engine/runtime/include`, and
`contracts/generated`. JNI and Android log headers come from the NDK. Link
with the platform C library, math and Android log libraries. Java activity
names, surface lifecycle, package identity, APK assets and product profiles
belong to the consuming program.

Run `bun test tests/android-platform.test.ts tests/pocket-input.test.ts` for
portable input checks. Set `POCKET_TEST_JNI_INCLUDE` to an NDK JNI include
directory to enable the real JNI table test; a JDK also requires
`POCKET_TEST_JNI_PLATFORM_INCLUDE` for its platform-specific JNI header.

The CMake project exports `pocket::android_input`, plus
`pocket::android_jni` when `POCKET_ANDROID_JNI=ON`. Android builds enable JNI
and export `pocket::android_hooks` linked to the NDK log library. Host builds
require POSIX threads and default to input alone. Host JNI uses `find_package(JNI)`;
`POCKET_ANDROID_JNI_INCLUDE_DIR` can select a real JNI header directory for
API conformance builds.

```sh
cmake -S platforms/android -B .pocket-build/android-input
cmake --build .pocket-build/android-input
```
