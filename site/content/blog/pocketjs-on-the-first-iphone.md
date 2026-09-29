<img class="rounded-xl border border-line" width="320" src="/assets/blog/iphone2g-device-gl-frame.png" alt="The PocketJS Hero demo at 320 by 480 read off an original iPhone: a PocketJS header with FPS, NODES and DRAWS counters reading 60, 42 and 9, the headline 'JSX on ARMv6.', a spinner, a gradient underline, body text reading 'Flexbox, springs and baked type — running on a 2007 touchscreen', a blue 'Tap Hero' button and 'Count: 0'" />

<p class="text-sm text-slate-500 -mt-4">This is not a render of the demo. It is the original iPhone's own framebuffer, read back with <code>glReadPixels</code> over a USB cable and encoded on the Mac — drawn by a PowerVR MBX Lite through a fixed-function pipeline with no shaders anywhere. The <code>60</code> is the presentation rate the app is <em>told</em> it has; the rate actually delivered is 47–49, and that gap is discussed at the end.</p>

Xcode 26.6 still compiles ARMv6. Its `ld-classic` still links against a 2008 `UIKit`. What the current toolchain will *not* do is hand its own Objective-C output to a loader from 2008 — so the host that puts [PocketJS](/blog/introducing-pocketjs/) on the original iPhone contains no Objective-C at all. And the GPU in that phone predates programmable shading, so the renderer feeding it has no shaders either.

Neither of those turned out to be the hard part.

If you have not met PocketJS: it runs real [Solid](https://www.solidjs.com/), Vue Vapor and [Octane](/blog/octane-on-psp/) components — JSX, reactivity, flexbox, Tailwind classes, springs — on hardware with no browser and no JIT. It started on a 2004 Sony PSP at 333 MHz and has since reached a [PS Vita](/blog/pocketjs-on-ps-vita/), a [Nokia E7](/blog/pocketjs-on-symbian/), an ESP32-P4 and an e-reader. The runtime is a Rust core plus [QuickJS](https://bellard.org/quickjs/); applications are ordinary TypeScript.

The iPhone is the newest target and the oldest touchscreen: `iPhone1,1`, June 2007, one ARM1176JZF-S, 128 MB of RAM, 320×480. This post is the port — a compiler back end that survived, a linker that cannot read its own compiler's output, two mutually incompatible UIKits in one executable, and two lines of GLSL that turned out to be expressible as fixed-function state, exactly.

Then it is about how we measured the result wrong three times running, published the opposite of the truth, and only found out because somebody picked up the phone and looked at it.

## The machine

<svg viewBox="0 0 760 236" width="100%" role="img" aria-label="Comparison of four PocketJS targets. Sony PSP-1000 from 2004: 333 megahertz MIPS single core, 32 megabytes RAM, 480 by 272 screen, fixed-function GE graphics. PS Vita from 2011: four-core ARM Cortex-A9, 512 megabytes, 960 by 544, SceGxm. Nokia E7 from 2011: 680 megahertz ARM11, 256 megabytes, 640 by 360, OpenGL ES 2. Original iPhone from 2007, highlighted: ARM1176JZF-S single core, 128 megabytes, 320 by 480, OpenGL ES 1.1 with no shaders at all." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">MACHINE</text>
  <text x="212" y="20" fill="#64748b" font-size="11">CPU</text>
  <text x="392" y="20" fill="#64748b" font-size="11">RAM</text>
  <text x="466" y="20" fill="#64748b" font-size="11">SCREEN</text>
  <text x="576" y="20" fill="#64748b" font-size="11">GRAPHICS</text>
  <line x1="14" y1="30" x2="746" y2="30" stroke="#1e293b"/>
  <text x="14" y="56" fill="#e2e8f0" font-size="12.5">Sony PSP-1000 · 2004</text>
  <text x="212" y="56" fill="#94a3b8" font-size="12">333 MHz MIPS, 1 core</text>
  <text x="392" y="56" fill="#94a3b8" font-size="12">32 MB</text>
  <text x="466" y="56" fill="#94a3b8" font-size="12">480×272</text>
  <text x="576" y="56" fill="#94a3b8" font-size="12">fixed-function GE</text>
  <text x="14" y="82" fill="#e2e8f0" font-size="12.5">Sony PS Vita · 2011</text>
  <text x="212" y="82" fill="#94a3b8" font-size="12">4× ARM Cortex-A9</text>
  <text x="392" y="82" fill="#94a3b8" font-size="12">512 MB</text>
  <text x="466" y="82" fill="#94a3b8" font-size="12">960×544</text>
  <text x="576" y="82" fill="#94a3b8" font-size="12">SceGxm</text>
  <text x="14" y="108" fill="#e2e8f0" font-size="12.5">Nokia E7 · 2011</text>
  <text x="212" y="108" fill="#94a3b8" font-size="12">680 MHz ARM11</text>
  <text x="392" y="108" fill="#94a3b8" font-size="12">256 MB</text>
  <text x="466" y="108" fill="#94a3b8" font-size="12">640×360</text>
  <text x="576" y="108" fill="#94a3b8" font-size="12">OpenGL ES 2</text>
  <rect x="8" y="118" width="738" height="34" rx="7" fill="#0e1626" stroke="#38bdf8" stroke-width="1.2"/>
  <text x="14" y="140" fill="#f1f5f9" font-size="12.5" font-weight="700">Apple iPhone · 2007</text>
  <text x="212" y="140" fill="#38bdf8" font-size="12">ARM1176JZF-S, 1 core</text>
  <text x="392" y="140" fill="#38bdf8" font-size="12">128 MB</text>
  <text x="466" y="140" fill="#38bdf8" font-size="12">320×480</text>
  <text x="576" y="140" fill="#38bdf8" font-size="12">GL ES 1.1, no shaders</text>
  <line x1="14" y1="170" x2="746" y2="170" stroke="#1e293b"/>
  <text x="14" y="192" fill="#94a3b8" font-size="11">It is the first PocketJS target where the OS owns app identity — a signed bundle in /Applications that</text>
  <text x="14" y="210" fill="#94a3b8" font-size="11">SpringBoard launches — and the first whose GPU could not run the renderer we already had.</text>
  <text x="14" y="230" fill="#22d3ee" font-size="11">Asking the device beats reading the SDK. A probe that makes a context the way the host does reports:</text>
</svg>

```text
GL_VENDOR      Imagination Technologies
GL_RENDERER    PowerVR MBXLite with VGPLite
GL_VERSION     OpenGL ES-CM 1.1 (48)
MAX_TEXTURE    1024
GL_EXTENSIONS  … GL_OES_framebuffer_object GL_OES_draw_texture
               GL_IMG_texture_format_BGRA8888 …
```

`OpenGLES.framework` is in the sysroot — ARMv6, 189 exported symbols — exporting `glTexImage2D`, `glVertexPointer`, `glEnableClientState` and `glOrthof`. It does not export `glCreateShader`, `glShaderSource`, `glCompileShader` or `glUseProgram`. PocketJS's existing GL backend was 1,431 lines of ES 2 with GLSL in it, so it could not run here at all.

## The toolchain that survived

The first question is whether a 2026 Mac can produce a binary a 2007 loader accepts. The encouraging answer is that **Apple never removed the ARMv6 back end or the classic linker.** Both are one flag away:

```sh
$ xcrun clang -target armv6-apple-darwin8 -miphoneos-version-min=1.1.4 \
    -march=armv6 -Os -c probe.c -o probe.o
$ file probe.o
probe.o: Mach-O object arm_v6
$ xcrun -f ld-classic
…/XcodeDefault.xctoolchain/usr/bin/ld-classic
```

Apple clang 21 emits `cputype 12, cpusubtype 6`. What is gone is everything *around* the compiler: no SDK, no `crt1.o` for this target, and a default linker that produces a Mach-O the old loader will not read. Each of those is supplied by hand.

**The sysroot is a stock root filesystem, pinned file by file.** `-syslibroot` points at an extracted iPhone OS root image with `-L/usr/lib -F/System/Library/Frameworks`, and `doctor` hashes each binary the build links — `libSystem.B.dylib`, `libgcc_s.1.dylib`, `libobjc.A.dylib`, `UIKit`, `Foundation`, `CoreGraphics`, `OpenGLES` — plus the SHA-256 of the raw image they came out of. Not files copied off a running phone, where anything installed later could have replaced them.

**The C runtime startup is compiled from Apple's own open source.** There is no `crt1.o` to link against, so the build assembles [`Csu-76`](https://github.com/apple-oss-distributions/Csu)'s `start.s` and `dyld_glue.s` from a hash-pinned checkout and links with `-e start`.

**The link line is mostly a list of Mach-O features to switch off.** Every one is something the 2008 dyld has never heard of, and any one left on produces a binary that is perfectly valid and will not load:

```text
-no_pie  -no_uuid  -no_function_starts  -no_data_in_code_info
-no_source_version  -no_compact_unwind  -no_adhoc_codesign  -no_encryption
```

Then `ldid -S` applies a pseudo-signature, which a jailbroken device accepts in place of a real one. That is the first of exactly two places the jailbreak matters, and its whole extent: **the device must accept an unsigned binary and must offer SSH over USB.** How it got that way is somebody else's article.

### Why link against an SDK older than the target

One choice here looks like a mistake and is not. The executable carries `LC_VERSION_MIN_IPHONEOS` of **1.1.4** while the bundle declares `MinimumOSVersion 3.1.3` and the device runs 3.1.3.

On this device family the *oldest* ABI is the portable one. Symbols and selectors were added across 1.x → 3.x, not removed, so a binary linked against the earliest root filesystem resolves on every later one; a binary linked against 3.1.3 would not run on anything before it. Linking low and probing high gets one executable that loads across the family, and it lets the bytes we verify by hash be the oldest and best-pinned image available rather than whatever is on the phone in front of us.

The cost is that the *running* OS then disagrees with the *linked* OS about how to start an application.

## A UIKit application in C

A UIKit app needs at least two classes: a view that draws and an application delegate. The obvious way to write them is Objective-C, and that is where the toolchain stops.

Modern Clang, asked for ARMv6 with a 1.1.4 deployment target, will happily compile an `@implementation`. `ld-classic` then **crashes** translating the ObjC1 class-reference relocations Clang emitted for it. Not a diagnostic — a crash. The old ABI and the new compiler's metadata are far enough apart that the compatibility path inside the classic linker gives up.

There is no flag for this. There is, however, a way to need zero Objective-C metadata in the object file at all, and the API for it is already in the phone's own runtime. The `libobjc.A.dylib` in the sysroot is dated **11 February 2008**, and among its 185 exported symbols are `_objc_allocateClassPair`, `_objc_registerClassPair`, `_class_addMethod` and `_objc_msgSend_stret`:

```c
static Class register_view_class(void) {
  Class cls = objc_allocateClassPair(objc_getClass("UIView"), "PocketJSRuntimeView", 0);
  BOOL methods_added =
    class_addMethod(cls, sel_registerName("drawRect:"),
      (void (*)(void))pocket_draw_rect,
      "v@:{CGRect={CGPoint=ff}{CGSize=ff}}") &&
    class_addMethod(cls, sel_registerName("touchesBegan:withEvent:"),
      (void (*)(void))pocket_touches_began, "v@:@@") &&
    /* … touchesMoved/Ended/Cancelled, the 1.x mouse* path, and the tick … */
    class_addMethod(cls, sel_registerName("pocketJSTick:"),
      (void (*)(void))pocket_tick, "v@:@");
  if (!methods_added) return NULL;
  objc_registerClassPair(cls);
  return cls;
}
```

Two classes, registered at startup, from a translation unit the classic linker sees as ordinary C. `UIApplicationMain` is handed the class *names* as strings and never knows the difference.

The costs are real but bounded. You write the type encodings yourself — `"v@:{CGRect={CGPoint=ff}{CGSize=ff}}"` is `-(void)drawRect:(CGRect)` spelled out for the runtime — and every message send is an explicit cast of `objc_msgSend`.

**The trap is struct returns.** On ARMv6 a method returning a `CGRect` does not use the same calling convention as one returning an `id`; it uses the struct-return variant, where the caller passes a hidden pointer to the result. Send `bounds` through plain `objc_msgSend` and you get a plausible-looking rectangle full of garbage — no crash, no warning, and a layout that is quietly wrong forever. Geometry goes through its own helper:

```c
static CGRect send_rect(id receiver, const char *selector) {
  CGRect rect;
  ((void (*)(CGRect *, id, SEL))objc_msgSend_stret)(&rect, receiver, sel_registerName(selector));
  return rect;
}
```

None of this is clever; it is the shape the constraint forces. But the shape is worth knowing exists: **you can write a complete UIKit application in C, with no Objective-C compiler involved anywhere, and a 2008 runtime supports it.**

## One executable, two incompatible UIKits

Linking low and running high means the two UIKits disagree about nearly every lifecycle detail. The host asks before it acts — `respondsToSelector:` for methods, `dlsym` for functions:

<svg viewBox="0 0 760 288" width="100%" role="img" aria-label="Table of six UIKit differences the host resolves at runtime. Status bar: iPhone OS 1.x uses UIHardware underscore setStatusBarHeight zero plus setStatusBarMode colon orientation colon duration colon fenceID colon, while 3.1.3 uses setStatusBarHidden colon. Window creation: 1.x uses initWithContentRect colon, 3.1.3 uses initWithFrame colon. View attachment: 1.x uses setContentView colon then orderFront colon, makeKey colon and underscore setHidden colon; 3.1.3 uses addSubview colon then makeKeyAndVisible. Graphics context: 1.x exports UICurrentContext, 3.1.3 exports UIGraphicsGetCurrentContext. Touch: 1.x delivers GSEvents through mouseDown, mouseDragged and mouseUp; 3.1.3 delivers UITouch objects through touchesBegan withEvent. Launch callback: 1.x calls applicationDidFinishLaunching colon, 3.1.3 calls application colon didFinishLaunchingWithOptions colon." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">CONCERN</text>
  <text x="150" y="20" fill="#64748b" font-size="11">iPHONE OS 1.x — THE LINKED ABI</text>
  <text x="466" y="20" fill="#64748b" font-size="11">3.1.3 — THE RUNNING OS</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="10.5">
    <text x="14" y="50" fill="#e2e8f0">status bar</text>
    <text x="150" y="50" fill="#94a3b8">UIHardware _setStatusBarHeight: 0</text>
    <text x="150" y="66" fill="#94a3b8">+ setStatusBarMode:orientation:duration:fenceID:</text>
    <text x="466" y="50" fill="#38bdf8">setStatusBarHidden:</text>
    <text x="14" y="92" fill="#e2e8f0">window</text>
    <text x="150" y="92" fill="#94a3b8">initWithContentRect:</text>
    <text x="466" y="92" fill="#38bdf8">initWithFrame:</text>
    <text x="14" y="118" fill="#e2e8f0">attach view</text>
    <text x="150" y="118" fill="#94a3b8">setContentView:</text>
    <text x="150" y="134" fill="#94a3b8">then orderFront: · makeKey: · _setHidden:</text>
    <text x="466" y="118" fill="#38bdf8">addSubview:</text>
    <text x="466" y="134" fill="#38bdf8">then makeKeyAndVisible</text>
    <text x="14" y="160" fill="#e2e8f0">draw context</text>
    <text x="150" y="160" fill="#94a3b8">UICurrentContext()</text>
    <text x="466" y="160" fill="#38bdf8">UIGraphicsGetCurrentContext()</text>
    <text x="14" y="184" fill="#e2e8f0">touch</text>
    <text x="150" y="184" fill="#94a3b8">GSEvent via mouseDown:/Dragged:/Up:</text>
    <text x="466" y="184" fill="#38bdf8">UITouch via touchesBegan:withEvent:</text>
    <text x="14" y="208" fill="#e2e8f0">launch</text>
    <text x="150" y="208" fill="#94a3b8">applicationDidFinishLaunching:</text>
    <text x="466" y="208" fill="#38bdf8">application:didFinishLaunchingWithOptions:</text>
  </g>
  <line x1="14" y1="226" x2="746" y2="226" stroke="#1e293b"/>
  <text x="14" y="248" fill="#94a3b8" font-size="11">Methods are probed with respondsToSelector:, functions with dlsym against RTLD_DEFAULT.</text>
  <text x="14" y="266" fill="#22d3ee" font-size="11">That is also why the 3.1.3 binary carries no load command for GraphicsServices —</text>
  <text x="14" y="282" fill="#22d3ee" font-size="11">an install name that moved out of the public Frameworks directory after 1.x.</text>
</svg>

That last line is the trap that makes the whole "link low" strategy nearly not work. The 1.x touch path needs `GSEventGetLocationInWindow`, which lived in a public `GraphicsServices.framework` in 1.1.4 and does not in 3.1.3. Declare it `extern`, let the linker record the dependency, and you get a binary that links perfectly on your Mac and is **rejected by dyld on the phone** — it now demands a library that is no longer there. Resolving it through `dlsym` keeps the older path available without putting the obsolete install name in the load commands. A test asserts the `extern` declaration is absent, because that is exactly the kind of line a well-meaning cleanup puts back.

The status bar is the other difference with a visible consequence: 1.1.4 reserves 20 pixels and hands you a 320×460 content rect unless you take it away, while 3.1.3 has `setStatusBarHidden:`. The app owns all 320×480 either way — and the C never hardcodes those numbers, because `POCKET_LOGICAL_WIDTH` and `POCKET_LOGICAL_HEIGHT` arrive as `-D` defines derived from the resolved build plan, with an `#error` if they are missing.

## Two lines of GLSL, as fixed-function state

The core is a `no_std` Rust crate that can either rasterize the retained UI tree on the CPU or walk its DrawList into a GPU. Getting it onto this target needed a custom target JSON, because Rust has never heard of `armv6-apple-ios`:

```json
{
  "llvm-target": "armv6-apple-ios",
  "cpu": "arm1176jzf-s",
  "features": "+v6,+soft-float,+vfp2,-neon,+strict-align",
  "binary-format": "mach-o",
  "archive-format": "darwin",
  "panic-strategy": "abort",
  "is-like-darwin": true
}
```

plus a pinned nightly and `-Z build-std=core,alloc,compiler_builtins`, since no prebuilt `core` exists for a target that does not exist. Two libc symbols were missing — `clock_gettime`, which postdates this libc and which QuickJS uses only for `Atomics`, and `memset_pattern16`, a Darwin entry point LLVM emits as an optimization. Together they are `compat.c`, **23 lines including the includes**. That is the entire platform shim.

Now the interesting part. Here is the whole ES 2 pipeline PocketJS used on Symbian:

```glsl
// vertex
vec2 ndc = vec2(a_position.x * 2.0 / u_viewport.x - 1.0,
                1.0 - a_position.y * 2.0 / u_viewport.y);
gl_Position = vec4(ndc, 0.0, 1.0);
// fragment
gl_FragColor = texture2D(u_texture, v_uv) * v_color;
```

Both lines have exact fixed-function equivalents, and they are one-liners:

- The vertex transform — pixel coordinates to NDC including the Y flip that puts the origin at the top left — is `glOrthof(0, w, h, 0, -1, 1)` on the projection matrix. Left, right, bottom, top, in that order.
- `texture2D(…) * v_color` is `GL_MODULATE`, the *default* texture environment, over a per-vertex colour array.
- The three shader attributes become `glVertexPointer` / `glTexCoordPointer` / `glColorPointer` reading the **same interleaved buffer at the same offsets** — 0, 8, 16, stride 20. The vertex struct did not change by a byte.

So this was a substitution, not a rewrite. `gles2.rs` became `gl/mod.rs` — the DrawList walk, the image and font-atlas caches, batching by texture and scissor, the clip arithmetic, all generation-independent — plus `gl/es2.rs` and `gl/es1.rs` holding the ~90 lines that differ. Both satisfy one six-method interface, one is compiled in, and the ten existing unit tests pass on either.

Three things bit along the way, and they are the useful part of this section.

**A `cfg` that names one platform is a bug with a delay on it.** The crate's `no_std` switch was `cfg(target_os = "none")`, so it gained a `bare-platform` feature to admit a Mach-O target whose `target_os` is `ios`. Then eight *more* `#[cfg(target_os = "none")]` gates guarded the GL entry points, plus three fallback arms returning zero for everyone else. The build succeeded, the link succeeded, and the archive contained no GL code whatsoever, because the whole module had been compiled out of existence for this target. Same trap, same file, twice.

**MBX Lite has no `GL_OES_blend_func_separate`,** so the ES 1.1 path cannot give destination alpha its own blend factors the way ES 2 does. That is sound here because the drawable is opaque and nothing reads its alpha back — but that is an argument, not an assumption, and it belongs in a comment next to the `glBlendFunc` call.

**The 2008 `OpenGLES.framework` has the core ES 1.1 entry points and not the two things you need to put them on screen:** no EAGL, no `GL_OES_framebuffer_object`. Both exist on 3.1.3. So `EAGLContext` and `CAEAGLLayer` are fetched with `objc_getClass` and all nine framebuffer-object functions with `dlsym` — not a workaround but the only correct option, since a link-time reference to any of them would produce a binary dyld rejects. The build now fails if one ever becomes a link-time reference, right beside the check that does the same for GraphicsServices.

The piece that makes UIKit hand over a GL-capable layer is a class method, added to the metaclass before the pair is registered:

```c
static Class pocket_layer_class(id self, SEL command) {
  if (access(POCKET_FORCE_SOFTWARE_PATH, F_OK) == 0) {
    return objc_getClass("CALayer");
  }
  return objc_getClass("CAEAGLLayer");
}
```

That `access` check is there because of a bug you will meet shortly.

## Proving it, by reading pixels off the phone

A screenshot of a demo proves that somebody had a demo. What we wanted was the phone's own framebuffer, compared against the reference rasterizer, as a number.

`glReadPixels` is in the 2008 framework, and `GL_RGBA` with `GL_UNSIGNED_BYTE` is the one combination ES 1.1 always allows. So the host grew a one-shot capture: touch a marker file, and the next GL frame is read back and written beside it as raw RGBA — 614,400 bytes for 320×480. Pull it over the USB SSH channel, flip it (GL reports rows bottom-up) and encode it on the Mac.

Then render the *same guest bundle* through the wasm core at the same viewport, 200 frames in with animations settled and no presses, and subtract.

<img class="w-full rounded-xl border border-line" src="/assets/blog/iphone2g-gl-parity.png" alt="Three panels side by side, each 320 by 480. Left: the frame read off the iPhone's GPU. Middle: the same frame rendered by the reference software rasterizer. Right: the absolute difference between them amplified twenty times, almost entirely black except faint outlines around text glyph edges." />

<p class="text-sm text-slate-500 -mt-4">Left: the iPhone's framebuffer, drawn by the MBX Lite. Middle: the reference rasterizer, same guest, same viewport. Right: the absolute difference, <strong>amplified 20×</strong> — at 1× it is black.</p>

```text
mean abs channel diff : 0.04 / 255
channels off by >32   : 0 of 460800  (0.00%)
worst single channel  : 7
```

**A fixed-function GPU from 2007 renders the same frame as the reference rasterizer**, to within seven levels on the worst single channel. The only signal in that third panel is antialiased glyph edges, which is exactly what should differ: the GPU interpolates the gradient in hardware and filters the font atlas, where the software path does exact integer math. This is the first PocketJS host verified by reading pixels back off the physical device instead of by looking at it.

It would also have caught, in about a second, every one of the three bugs in the next section.

## Three measurement bugs, stacked

We shipped the GL backend, benchmarked it against the software rasterizer, and published that **the CPU won by 2.4×**. That was wrong, and it was wrong three times over in a way that compounded.

**Bug one: the timer stopped before the work.** On the software path the tick calls `setNeedsDisplay` and returns; UIKit calls `drawRect:` later in the run loop, and *that* is where the CGImage composite happens. Our timers ended at the tick. So GL was charged for rasterize **and** present, while software was credited with rasterize **only** — a comparison between one renderer's whole job and another's first half.

**Bug two: the software path was not drawing at all.** `+layerClass` returned `CAEAGLLayer` unconditionally, and a GL-backed layer never receives `drawRect:`. So on the software path frames were computed and never composited. The documented fallback — the one the code carefully drops to whenever GL fails — could never have worked. That is why the `access` check appears in `pocket_layer_class` above: the layer type has to agree with the renderer, and UIKit asks for it before the renderer is chosen.

**Bug three: the GPU was drawing colour blocks.** In ES 1.1, texturing is a per-unit **enable**. Without `glEnable(GL_TEXTURE_2D)` every fragment takes only the vertex colour: geometry and flat fills look correct while all text, images and atlas content silently vanish. ES 2 has no equivalent — sampling is written into the fragment shader — so nothing in the shared backend ever needed it, and deriving the ES 1 pipeline from the ES 2 one is precisely the way not to notice. A test now asserts it, along with `GL_MODULATE`, `glShadeModel(GL_SMOOTH)` for the gradients, and an identity texture matrix.

None of the three was found by a test. The first two were found by a measurement that did not add up: software was doing 2.4× less *timed* work and delivering no more frames, which is impossible unless something is uncounted. The third was found by a human holding the phone and saying **it is still only colour blocks.**

## What the numbers actually are

Same binary, same `CADisplayLink`, switched by a marker file, screen on,
complete UI on both paths — and with one change that turns out to matter more
than the renderer choice.

<svg viewBox="0 0 760 286" width="100%" role="img" aria-label="Benchmark of the two render paths on the same binary. The software rasterizer with a damage-scoped composite delivers 59.99 frames per second: 1.44 milliseconds in JavaScript plus core, 5.93 milliseconds rasterizing only damaged spans, and 0.26 milliseconds compositing only the damaged rectangle, totalling 7.63 milliseconds. The OpenGL ES 1.1 path delivers 48.6 to 50.7 frames per second: 1.8 to 2.3 milliseconds in JavaScript plus core and 12.8 to 16.2 milliseconds submitting the whole DrawList, totalling 17.2 to 19.7 milliseconds. Before the composite was scoped the software path was 21.9 to 26.5 frames per second with a 22 to 27 millisecond full-screen composite." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE BINARY · ONE DISPLAY LINK · COMPLETE UI ON BOTH · MEAN ms PER FRAME</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <text x="14" y="52" fill="#64748b" font-size="11">PATH</text>
  <text x="186" y="52" fill="#64748b" font-size="11">FPS</text>
  <text x="284" y="52" fill="#64748b" font-size="11">JS + CORE</text>
  <text x="404" y="52" fill="#64748b" font-size="11">DRAW</text>
  <text x="536" y="52" fill="#64748b" font-size="11">COMPOSITE</text>
  <text x="666" y="52" fill="#64748b" font-size="11">TOTAL</text>
  <rect x="8" y="62" width="738" height="30" rx="7" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="14" y="82" fill="#f1f5f9" font-size="12" font-weight="700">software, scoped</text>
  <text x="186" y="82" fill="#22d3ee" font-size="12">59.99</text>
  <text x="284" y="82" fill="#22d3ee" font-size="12">1.44</text>
  <text x="404" y="82" fill="#22d3ee" font-size="12">5.93</text>
  <text x="536" y="82" fill="#22d3ee" font-size="12">0.26</text>
  <text x="666" y="82" fill="#22d3ee" font-size="12">7.63</text>
  <text x="14" y="116" fill="#e2e8f0" font-size="12" font-weight="700">OpenGL ES 1.1</text>
  <text x="186" y="116" fill="#94a3b8" font-size="12">48.6–50.7</text>
  <text x="284" y="116" fill="#94a3b8" font-size="12">1.8–2.3</text>
  <text x="404" y="116" fill="#eab308" font-size="12">12.8–16.2</text>
  <text x="536" y="116" fill="#94a3b8" font-size="12">—</text>
  <text x="666" y="116" fill="#eab308" font-size="12">17.2–19.7</text>
  <text x="14" y="146" fill="#64748b" font-size="12">software, full-screen</text>
  <text x="186" y="146" fill="#64748b" font-size="12">21.9–26.5</text>
  <text x="284" y="146" fill="#64748b" font-size="12">1.4–2.7</text>
  <text x="404" y="146" fill="#64748b" font-size="12">9.6–11.5</text>
  <text x="536" y="146" fill="#64748b" font-size="12">22.1–26.9</text>
  <text x="666" y="146" fill="#64748b" font-size="12">33.9–40.8</text>
  <line x1="14" y1="164" x2="746" y2="164" stroke="#1e293b"/>
  <text x="14" y="186" fill="#e2e8f0" font-size="11">The third row is the second row's own past. Scoping the composite to the damage rectangle took it from</text>
  <text x="14" y="204" fill="#e2e8f0" font-size="11">22–27 ms to 0.26 ms, and the software path from 22–26 fps to a locked 60.</text>
  <text x="14" y="230" fill="#64748b" font-size="11">The GL path is unchanged: it does no damage tracking, and re-fills the whole screen every frame.</text>
  <text x="14" y="248" fill="#64748b" font-size="11">Giving it the same treatment — scissor to the plan's bounds — is the open work.</text>
  <line x1="14" y1="264" x2="746" y2="264" stroke="#1e293b"/>
  <text x="14" y="282" fill="#38bdf8" font-size="11">Frame rate comes from the device: window_frames and window_us, not two coarse samples differenced.</text>
</svg>

Getting these required fixing the ruler as well as the renderer. The earlier fps
figures came from differencing two fetched status records, whose timestamps have
one-second resolution and which are only written every heartbeat — worth about
±4 fps of uncertainty, comfortably enough to hide the discrepancy that exposed
bug one.

### The composite was never damage-limited

The rasterizer always was. `ui_render_incremental` writes only the spans the
damage plan covers, and it works: instrumenting the plan the core already
returns — and which `engine/ui-cabi` was discarding — gives
`damage_failures=0`, two full redraws in 361 frames, and an **empty** plan on
most frames, because a mostly-still UI mostly does not change.

The composite threw all of that away. The tick called `setNeedsDisplay`, which
invalidates the whole view, and `pocket_draw_rect` began with `(void)rect;` —
discarding the dirty rectangle UIKit hands you — then re-read full `bounds` and
rebuilt a `CGImage` over all 320×480. Every frame. That is the 22–27 ms.

Two changes, neither clever:

- An empty damage plan now invalidates **nothing**, so the frame costs no
  composite at all. In one sample that was 626 of 961 frames.
- A non-empty plan goes to `setNeedsDisplayInRect:`, and `drawRect:` clips to
  whatever UIKit passes back.

This needs no preservation guarantee, which is what makes it sounder than the
GL equivalent: when UIKit does discard the backing store it passes the full
bounds, and the code draws the full frame. The fallback is the default.

**And this is where the earlier claim gets superseded rather than corrected.**
"The GPU path is 1.8–2× faster" was true of the code as it stood. Then the CPU
path got the optimization the GPU path still lacks, and the ordering flipped.
That is not a fourth measurement bug; it is the first time the instrument was
good enough to aim.

Verifying it needed the capture again, and the capture had a trap of its own.
The two paths disagree about pixel format: `glReadPixels` gives R,G,B,A
bottom-up, while the core's ARGB32 words are B,G,R,A top-down. Comparing the
software capture without swapping red and blue reports a mean difference of
9.3/255 and produces a picture in which every blue is orange — a completely
convincing failure that is entirely in the comparison. Swapped, after 2,581
frames of damage-limited rendering:

```text
mean abs channel diff : 0.039 / 255
worst single channel  : 186, in 109 pixels
```

Those 109 pixels sit inside x 37..56, y 253..281 — within the animating
spinner's own 40×40 box, at a different phase than the reference. Everywhere
else the framebuffer is identical after 2,581 incremental frames, which is the
test that matters: the framebuffer persists and only damaged spans are
rewritten, so under-reported damage would accumulate as staleness that a
from-scratch render catches.

**Locked 60 fps on a 2007 iPhone, compositing 0.26 ms per frame.** The GPU path
stays in the tree, opt-in, correct and pixel-verified, waiting for the same
treatment.

## The icon, which took four tries

<p style="display:inline-block;background:#4b5563;padding:14px;border-radius:14px">
  <img width="236" height="240" src="/assets/blog/iphone2g-icon-4x.png" alt="The PocketJS SpringBoard icon at 4x: a black enamel rounded square with a bright chrome bevel, a curved glass highlight across the top half, and the silver PocketJS mark centered" />
</p>

<p class="text-sm text-slate-500">The shipped <code>Icon.png</code> at 4× nearest-neighbour, on a neutral plate so the transparent corners read. It is 59×60, and a test pins its SHA-256 plus the alpha at all four corners and four interior pixels.</p>

A 59×60 PNG does not usually earn a section. This one does, because it was wrong three times in three different ways, and each was a category error rather than a taste disagreement: the demo's in-app player logo, which belongs to the Hero header and not to an application identity; the white-plate brand asset, correct in a README and a white square on a phone home screen; and the black-plate brand asset, correct on this website and functionally invisible against the black wallpaper it was about to sit on. The fourth version is above — pre-baked bevel, glass highlight, transparent corners, with pixel-level assertions so the next asset sweep cannot quietly replace it. The audit that followed found the same mistake in the site's own `favicon.svg`.

## What the port cost

<svg viewBox="0 0 760 288" width="100%" role="img" aria-label="Summary of the iPhone port. Commit 11245e0, the ARMv6 UIKit host, toolchain, demo and runbook, plus 6319 lines. Commit 8a61b11, the 3.1.3 device workflow with signing and key-only SSH, plus 1549. Commit 1ab8d74, recording the first live runtime receipt, plus 79. Commit 655a8a3, the shared Hero on the phone plus a tilt input, plus 846. Commit 0198a98, baking the classic icon and removing the tilt input again, plus 115. A review pass hardening the bootstrap, the acceptance protocol, the single source of truth and CI, plus 1202. Then the GL work: splitting the shared backend into a generation-independent DrawList walker plus ES 2 and ES 1.1 pipelines, the EAGL drawable, and glReadPixels pixel parity. Total roughly 8600 lines, with the production target registry unchanged, zero pixel goldens updated and zero Hero tape hashes changed." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE WHOLE PORT</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="11.5">
    <text x="14" y="52" fill="#38bdf8">11245e0</text><text x="110" y="52" fill="#e2e8f0">ARMv6 UIKit host · toolchain · demo · runbook</text><text x="700" y="52" fill="#94a3b8" text-anchor="end">+6,319</text>
    <text x="14" y="76" fill="#38bdf8">8a61b11</text><text x="110" y="76" fill="#e2e8f0">3.1.3 device workflow · signing · key-only SSH</text><text x="700" y="76" fill="#94a3b8" text-anchor="end">+1,549</text>
    <text x="14" y="100" fill="#38bdf8">1ab8d74</text><text x="110" y="100" fill="#e2e8f0">record the first live runtime receipt</text><text x="700" y="100" fill="#94a3b8" text-anchor="end">+79</text>
    <text x="14" y="124" fill="#38bdf8">655a8a3</text><text x="110" y="124" fill="#e2e8f0">the shared Hero on the phone · <tspan fill="#eab308">a tilt input</tspan></text><text x="700" y="124" fill="#94a3b8" text-anchor="end">+846</text>
    <text x="14" y="148" fill="#38bdf8">0198a98</text><text x="110" y="148" fill="#e2e8f0">bake the classic icon · <tspan fill="#eab308">remove the tilt input again</tspan></text><text x="700" y="148" fill="#94a3b8" text-anchor="end">+115</text>
    <text x="14" y="172" fill="#a78bfa">review pass</text><text x="110" y="172" fill="#e2e8f0">bootstrap safety · acceptance protocol · one source of truth · CI</text><text x="700" y="172" fill="#94a3b8" text-anchor="end">+1,202</text>
    <text x="14" y="196" fill="#a78bfa">GL work</text><text x="110" y="196" fill="#e2e8f0">gl/{mod,es1,es2}.rs · EAGL drawable · <tspan fill="#22d3ee">glReadPixels parity</tspan></text><text x="700" y="196" fill="#94a3b8" text-anchor="end">shared</text>
  </g>
  <line x1="14" y1="212" x2="746" y2="212" stroke="#1e293b"/>
  <text x="14" y="234" fill="#22d3ee" font-size="11">≈8,600 lines · production target registry unchanged · framework additions: one optional receipt sink</text>
  <text x="14" y="252" fill="#22d3ee" font-size="11">pixel goldens updated: 0 · Hero tape hashes changed: 0 · GL backend tests on both pipelines: 10/10</text>
  <text x="14" y="274" fill="#64748b" font-size="11">The two yellow rows are an accelerometer input that shipped and was then deleted in full.</text>
</svg>

That deletion is worth a sentence. The accelerometer went in as a hardware-neutral `input.tilt` capability — a fifth frame argument, a DevTools tape version, a contract entry, `UIAccelerometer` on the device — and on the Hero screen it moved the headline a few pixels. It was decorative, so it came out completely: the public API, the frame argument, the tape version, the native code, the acceptance field. Adding an input capability to a portable frame contract is cheap to write and expensive to keep.

## The honest boundary

This is **not** a production PocketJS target.

- The build profile lives in `tools/`, deliberately outside the production registry, with a test asserting it stays there.
- Everything is verified on **one** device: `iPhone1,1` running iPhone OS 3.1.3. The pixel parity above is one frame, at rest, on one phone — a strong result, and not a golden suite.
- The default path holds **59.99 fps**; the GL path, which is opt-in, delivers 48.6–50.7 because its work exceeds the 16.67 ms budget. Damage-aware GL submission is the open work, and it is now clearly worth doing.
- `Ui::draw()` calls `draw::build()` unconditionally, so the whole DrawList is rebuilt from the tree every frame on **both** paths. That cost sits inside the timed window and nobody has separated it yet. It is the next thing to measure.
- **The GL path's submit cost fluctuates by about 2×, and I cannot explain it.** Five long-window samples in one run: submit 15.40, 12.72, 15.79, 14.62 and 7.68 ms, delivering 47.0, 53.2, 47.6, 50.8 and 60.0 fps. It is not warm-up, because the cost rises as well as falls. The fast sample arrived after the device sat untouched for about a minute, so display dimming changing what the window server composites is a candidate and nothing here establishes it. The software path over the same window is tight — four of five samples between 59.68 and 59.98 — which is why one number is quoted for it and a range for GL.
- To reproduce any of this you need a jailbroken `iPhone1,1` on 3.1.3, because the host relies on an `ldid` pseudo-signature being accepted and on SSH over USB. Getting a device into that state is out of scope here and there is no repository command for it.
- No firmware, system file or extracted sysroot is in the repository. You supply your own copies of the historical inputs under their original terms; the toolchain verifies their hashes.

## Why bother

There is no market here. Nobody is shipping an app for a 2007 iPhone, and this port will never have users.

It is a test, and it tests something the other targets cannot. The PSP, the Vita and the ESP32 are machines you own outright: you boot your own code and negotiate with nothing. [Symbian](/blog/pocketjs-on-symbian/) was the first target with an operating system that owns the screen and the scheduler and expects to be asked. The iPhone is the first that owns **identity** — a bundle, a signature, an installer, a home screen, a launch protocol — and the first whose GPU could not run the renderer we already had.

The runtime went onto it without a fork. What changed was a toolchain, a host, one optional diagnostic sink, and a GL backend that now serves two generations instead of one. What did not change was the core, the framework, the goldens and the target registry — the same parts that did not change for Symbian and for the Vita.

The rest of it is a lesson about evidence I would rather have learned more cheaply. We published that a GPU backend lost to a CPU rasterizer by 2.4×. Every number in that claim was real. The stage we forgot to time was the largest one; the fallback we measured against was not drawing; and the renderer we were defending was painting rectangles where the text should be. **Three separate mistakes, each individually plausible, composing into a confident published conclusion that was exactly backwards.**

What broke the chain was not a cleverer benchmark. It was `glReadPixels` — pulling the actual pixels off the actual phone and subtracting them from the reference — and a person picking up the device to say it still looked like colour blocks.

And once the instrument existed it kept paying. It showed that the rasterizer's damage plan was fine and the *composite* was throwing it away, which is worth 22 ms a frame and a locked 60. It caught a red/blue swap in my own comparison that would otherwise have read as a rendering bug. It proved 2,581 frames of incremental rendering leave no stale pixels. Every one of those is a question I would previously have answered by looking at the screen and forming an impression.

On hardware you can only touch one machine at a time. The cheapest thing you can build is the instrument that shows you what the machine is really doing — and the most valuable participant is whoever is holding it.

---

*PocketJS is open source at [pocket-nexus/pocketjs](https://github.com/pocket-nexus/pocketjs). The iPhone workflow and its acceptance layers are documented in [`docs/IPHONE2G.md`](https://github.com/pocket-nexus/pocketjs/blob/main/docs/IPHONE2G.md); the port is PR [#219](https://github.com/pocket-nexus/pocketjs/pull/219), with the GL fixes and this correction in [#233](https://github.com/pocket-nexus/pocketjs/pull/233). The C runtime startup is Apple's [Csu](https://github.com/apple-oss-distributions/Csu), and the historical map of this toolchain territory is still [saurik's](https://www.saurik.com/toolchain.html).*
