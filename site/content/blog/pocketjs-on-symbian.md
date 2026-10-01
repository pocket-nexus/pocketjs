Symbian has no threads to wait in. Its concurrency primitive is the **active object**: a class with one method, one word of shared status, and a cooperative scheduler that freezes the entire phone if your callback takes too long.

A UI runtime whose whole design is one frame function that must return turns out to be exactly the shape that operating system wants — which is why [PocketJS](/blog/introducing-pocketjs/) now runs on a 2011 Nokia E7, natively, as installed Symbian applications with their own UIDs, drawn by the phone's GPU, and why that took two days rather than two months.

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-hero-landscape.png" alt="The PocketJS Hero demo at 640 by 360 on the Nokia E7: a PocketJS header with FPS, NODES and DRAWS counters, the headline 'JSX at 60 FPS.', a gradient underline, body text reading 'Flexbox, springs and baked type — running on a 2005 handheld', a blue 'Press Circle' button, and 'Count: 6'" />

<p class="text-sm text-slate-500 -mt-4">The Hero demo at the E7's native 640×360. This frame — and every application screenshot in this post — is the real Symbian guest bundle, resolved against the E7 build profile, booted at the E7's exact viewport, and rasterized by the same wasm core our byte-exact pixel goldens run on. Photographs of a 4-inch AMOLED would tell you less.</p>

If you have not met PocketJS: it runs real [Solid](https://www.solidjs.com/) and Vue Vapor components — JSX, reactivity, flexbox, Tailwind classes, springs — on hardware with no browser and no JIT, starting with a 2004 Sony PSP at 333 MHz. The runtime is a Rust core plus [QuickJS](https://bellard.org/quickjs/), and applications are ordinary TypeScript.

Symbian is the newest machine family it targets, and the first that is a *phone* — the first with an operating system that owns the screen, the keys, and the scheduler, and expects to be asked. This post is the field guide: what Symbian's programming model actually is, in full (it is genuinely unlike anything you use today), what a 2011 toolchain looks like when you pin it in 2026, and — the part we actually care about — **which parts of a UI runtime have to change when the target changes, and which parts must not.**

The whole port is six merged PRs across three repositories.

## The machine

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="Comparison table of three PocketJS targets: Sony PSP-1000 at 333 megahertz MIPS with 32 megabytes of RAM and a 480 by 272 screen with a fixed-function GE; PS Vita at 4-core ARM Cortex-A9 with 512 megabytes and 960 by 544 through GXM; Nokia E7 at 680 megahertz ARM11 with 256 megabytes and 640 by 360 through OpenGL ES 2. The E7 row is highlighted." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="22" fill="#64748b" font-size="11">MACHINE</text>
  <text x="200" y="22" fill="#64748b" font-size="11">CPU</text>
  <text x="376" y="22" fill="#64748b" font-size="11">RAM</text>
  <text x="452" y="22" fill="#64748b" font-size="11">SCREEN</text>
  <text x="600" y="22" fill="#64748b" font-size="11">GPU</text>
  <line x1="14" y1="32" x2="746" y2="32" stroke="#1e293b"/>
  <text x="14" y="58" fill="#e2e8f0" font-size="12.5">Sony PSP-1000 · 2004</text>
  <text x="200" y="58" fill="#94a3b8" font-size="12">333 MHz MIPS, 1 core</text>
  <text x="376" y="58" fill="#94a3b8" font-size="12">32 MB</text>
  <text x="452" y="58" fill="#94a3b8" font-size="12">480×272</text>
  <text x="600" y="58" fill="#94a3b8" font-size="12">fixed-function GE</text>
  <text x="14" y="84" fill="#e2e8f0" font-size="12.5">Sony PS Vita · 2011</text>
  <text x="200" y="84" fill="#94a3b8" font-size="12">4× ARM Cortex-A9</text>
  <text x="376" y="84" fill="#94a3b8" font-size="12">512 MB</text>
  <text x="452" y="84" fill="#94a3b8" font-size="12">960×544</text>
  <text x="600" y="84" fill="#94a3b8" font-size="12">GXM (vita2d)</text>
  <rect x="8" y="94" width="744" height="34" rx="6" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="14" y="116" fill="#f1f5f9" font-size="12.5" font-weight="700">Nokia E7-00 · 2011</text>
  <text x="200" y="116" fill="#22d3ee" font-size="12">680 MHz ARM11</text>
  <text x="376" y="116" fill="#22d3ee" font-size="12">256 MB</text>
  <text x="452" y="116" fill="#22d3ee" font-size="12">640×360 ⇄ 360×640</text>
  <text x="600" y="116" fill="#22d3ee" font-size="12">OpenGL ES 2.0</text>
  <line x1="14" y1="146" x2="746" y2="146" stroke="#1e293b"/>
  <text x="14" y="172" fill="#94a3b8" font-size="11.5">The E7 has ~8× the PSP's memory and ~2× its clock — and 1.76× the pixels to fill, on a CPU with no NEON.</text>
  <text x="14" y="192" fill="#94a3b8" font-size="11.5">It is also the first PocketJS target whose screen <tspan fill="#f1f5f9">rotates</tspan>, the first with a <tspan fill="#f1f5f9">keyboard</tspan>, and the first</text>
  <text x="14" y="212" fill="#94a3b8" font-size="11.5">whose OS wants to be asked politely before it lets you have the framebuffer.</text>
  <text x="14" y="250" fill="#64748b" font-size="11">The exact unit: E7-00, Nokia type RM-626 · Belle Refresh, firmware 111.040.1514 · 4″ AMOLED · slide-out QWERTY</text>
  <text x="14" y="270" fill="#64748b" font-size="11">Symbian was the best-selling smartphone OS in the world as recently as 2010. Nokia announced its retirement in</text>
  <text x="14" y="288" fill="#64748b" font-size="11">February 2011 — the year this phone shipped. The E7 is a flagship from an OS that knew it was cancelled.</text>
</svg>

The E7 is not a weak machine by PocketJS standards. On paper it should be the *easiest* target we have taken on: eight times the PSP's memory, twice its clock, a programmable GPU, and a real operating system with a filesystem and a process model.

What makes it hard is that everything about how you talk to that operating system is unfamiliar. So let us start there, because Symbian's model is genuinely interesting, and it explains three later decisions in this port.

## Interlude: how Symbian programs actually work

Symbian was designed in the 1990s for devices with a few megabytes of RAM, no MMU-backed virtual memory to spare, and a battery that had to last a week. Every major design decision follows from those constraints, and the result is an idiom that looks alien if you grew up on POSIX threads or an event loop with callbacks.

**Threads exist, but they are not how you wait.** A Symbian thread has a stack you must size up front, and context switching costs power you do not have. So the primitive you actually reach for is not a thread — it is the **active object** from the first paragraph. Here it is properly.

An active object is a C++ class deriving from `CActive`. It owns a `TRequestStatus` (a single word of shared memory), and it implements one method: `RunL()`. You start an asynchronous operation by handing your `TRequestStatus` to a *service* — a timer, a socket, the file server, the window server — and then calling `SetActive()`. The service is usually a separate server process, or the kernel. When it finishes, it writes a completion code into your `TRequestStatus` and signals your thread.

Meanwhile your thread is inside `CActiveScheduler::Start()`, which is a loop around `User::WaitForAnyRequest()` — a kernel call that blocks until *any* of that thread's outstanding requests completes. When one does, the scheduler walks its list of active objects, finds the highest-priority one whose status is no longer pending, and calls its `RunL()`.

That is abstract until you see it. Here is a complete, ordinary Symbian asynchronous operation — a cursor that blinks every 500 ms:

```cpp
class CBlinker : public CActive {
public:
    static CBlinker* NewL();
    ~CBlinker();
    void Blink(TTimeIntervalMicroSeconds32 aDelay);
private:
    CBlinker();
    void ConstructL();
    void RunL();      // the completion callback — the whole point
    void DoCancel();  // you MUST be able to retract the request
    RTimer iTimer;    // an R class: a handle to a kernel object
};

CBlinker* CBlinker::NewL() {
    CBlinker* self = new (ELeave) CBlinker();  // cannot leave
    CleanupStack::PushL(self);                 // …so this is safe
    self->ConstructL();                        // this one CAN leave
    CleanupStack::Pop(self);
    return self;
}

CBlinker::CBlinker() : CActive(EPriorityStandard) {
    CActiveScheduler::Add(this);     // join this thread's scheduler
}

void CBlinker::ConstructL() {
    User::LeaveIfError(iTimer.CreateLocal());   // no exceptions: leave
}

void CBlinker::Blink(TTimeIntervalMicroSeconds32 aDelay) {
    Cancel();                        // at most ONE request outstanding
    iTimer.After(iStatus, aDelay);   // hand the kernel our status word
    SetActive();                     // "scheduler: watch iStatus"
}

void CBlinker::RunL() {              // runs when iStatus completes
    if (iStatus != KErrNone) return;
    ToggleTheCursor();
    Blink(TTimeIntervalMicroSeconds32(500000));  // re-arm; there is no loop
}

void CBlinker::DoCancel() {
    iTimer.Cancel();                 // completes iStatus with KErrCancel
}

CBlinker::~CBlinker() {
    Cancel();                        // CActive::Cancel() → DoCancel()
    iTimer.Close();
}
```

Forty lines. Here is the same program today:

```ts
async function blink(signal: AbortSignal) {
  while (!signal.aborted) {
    await sleep(500, signal);
    toggleTheCursor();
  }
}
```

These are not different approaches. They are **the same state machine**, and the second one is the first one with a compiler doing the transcription:

| Symbian, by hand | Modern, generated |
| --- | --- |
| `iStatus` — one word the service writes into | the promise's resolution slot |
| `SetActive()` | reaching an `await` and registering the continuation |
| `RunL()` | the code *after* the `await` |
| `CActiveScheduler` | the event loop |
| `EPriorityStandard` | nothing — microtasks have no priorities |
| `DoCancel()`, mandatory | `AbortSignal`, optional and frequently forgotten |
| `RunError()` | the `catch` block |
| `NewL()` + `CleanupStack` | nothing — you have a garbage collector |
| the `L` suffix | nothing — every function may throw |

`await` did not invent anything here. It *automated* this, and the automation is why a modern async function can be read top to bottom while `CBlinker` has to be read by chasing four methods that never call each other.

What Symbian bought with that cost is worth naming, because it is the reason the model survived on 16 MB phones: every state machine is a named object with a known size, allocated when you say so; the wait is one kernel call for the entire thread, not one per task; there is no hidden queue growing behind your back; and priorities are explicit, so a redraw can outrank a network reply. It is `async/await` with the allocations made visible and the scheduler made yours.

And it comes with one non-negotiable rule, which is the reason any of this matters to a UI runtime: **`RunL()` runs to completion and nothing preempts it.** No other thread is keeping the phone's UI alive while you are inside it.

<svg viewBox="0 0 760 388" width="100%" role="img" aria-label="Diagram of the Symbian active scheduler: one thread runs CActiveScheduler::Start, which loops on User::WaitForAnyRequest. Three active objects — a timer, a socket read, and a window server event — each hold a TRequestStatus handed to a server process or the kernel. On completion the scheduler dispatches the highest-priority ready object's RunL, which must return quickly because the loop is cooperative and non-preemptive. A second panel shows Qt 4.7 on Symbian implementing QEventDispatcherSymbian on top of the same scheduler, so a QTimer is a CActive and PocketJS's frame loop is its RunL." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="14" y="10" width="380" height="240" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="28" y="34" fill="#f1f5f9" font-size="13" font-weight="700">one thread</text>
  <text x="28" y="52" fill="#64748b" font-size="11">no second stack, no mutex, no preemption</text>
  <rect x="28" y="64" width="352" height="52" rx="8" fill="#0e1626" stroke="#38bdf8" stroke-width="1.3"/>
  <text x="42" y="84" fill="#e2e8f0" font-size="12">CActiveScheduler::Start()</text>
  <text x="42" y="104" fill="#38bdf8" font-size="11">loop { WaitForAnyRequest(); dispatch RunL(); }</text>
  <rect x="28" y="128" width="112" height="46" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="38" y="147" fill="#e2e8f0" font-size="11">CTimer</text>
  <text x="38" y="164" fill="#64748b" font-size="10">iStatus ●</text>
  <rect x="148" y="128" width="112" height="46" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="158" y="147" fill="#e2e8f0" font-size="11">RSocket::Read</text>
  <text x="158" y="164" fill="#64748b" font-size="10">iStatus ○</text>
  <rect x="268" y="128" width="112" height="46" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="278" y="147" fill="#e2e8f0" font-size="11">RWsSession</text>
  <text x="278" y="164" fill="#64748b" font-size="10">iStatus ○</text>
  <text x="28" y="198" fill="#94a3b8" font-size="11">● complete → RunL() runs to completion, then the loop</text>
  <text x="28" y="216" fill="#94a3b8" font-size="11">   waits again. Nothing preempts it. A slow RunL() is</text>
  <text x="28" y="234" fill="#94a3b8" font-size="11">   a frozen UI — this is the whole contract.</text>
  <path d="M400 130 L426 130" stroke="#475569" stroke-width="1.5"/>
  <path d="M426 130 l-8 -5 M426 130 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="432" y="10" width="314" height="240" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="446" y="34" fill="#f1f5f9" font-size="13" font-weight="700">server processes + kernel</text>
  <text x="446" y="52" fill="#64748b" font-size="11">the async half lives outside your process</text>
  <rect x="446" y="64" width="286" height="34" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="458" y="86" fill="#94a3b8" font-size="11">Window Server — input, redraw, rotation</text>
  <rect x="446" y="106" width="286" height="34" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="458" y="128" fill="#94a3b8" font-size="11">File Server, Socket Server, Font Server…</text>
  <rect x="446" y="148" width="286" height="34" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="458" y="170" fill="#94a3b8" font-size="11">kernel timers, DMA, power management</text>
  <text x="446" y="206" fill="#94a3b8" font-size="11">Each completion writes one word into your</text>
  <text x="446" y="224" fill="#94a3b8" font-size="11">TRequestStatus and signals the thread.</text>
  <rect x="14" y="262" width="732" height="116" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.3"/>
  <text x="28" y="286" fill="#f1f5f9" font-size="13" font-weight="700">…and Qt 4.7 for Symbian is a shim over exactly this</text>
  <text x="28" y="308" fill="#94a3b8" font-size="11.5">QEventDispatcherSymbian owns a CActiveScheduler. QTimer is implemented by a CActive subclass.</text>
  <text x="28" y="328" fill="#94a3b8" font-size="11">PocketJS's host is a QGLWidget with a 30 Hz timer — its <tspan fill="#22d3ee">timerEvent() is an active object's RunL()</tspan>.</text>
  <text x="28" y="348" fill="#94a3b8" font-size="11">We never write CActive by hand, but we inherit its contract: <tspan fill="#f1f5f9">the frame function may not block, ever</tspan>,</text>
  <text x="28" y="368" fill="#94a3b8" font-size="11">because there is no other thread to keep the phone's UI alive while it runs.</text>
</svg>

The rest of the idiom follows from the same austerity:

- **No C++ exceptions.** Symbian predates usable exception support on ARM, so it invented its own: `User::Leave()` unwinds to the nearest `TRAP` macro. Any function that can leave is named with a trailing `L` — `ConstructL()`, `NewL()`, `RunL()`. The `L` is part of the type system, enforced by convention and code review.
- **A cleanup stack.** Because a leave is a `longjmp`-shaped unwind, destructors of stack objects do not run for heap pointers you are holding. So you push them onto a `CleanupStack` and pop them on success. This is why every Symbian class is constructed in *two phases*: `new (ELeave) CFoo` first (which cannot leave), then `ConstructL()` (which can), with the cleanup stack covering the gap.
- **Hungarian-flavored type prefixes that mean something.** `T` types are plain values with no destructor, `C` types are heap classes derived from `CBase`, `R` types are handles to server-owned resources, `M` types are pure interfaces. You can read a Symbian header and know each object's ownership and lifetime from its name.
- **Descriptors instead of strings.** `TDesC`/`TBuf`/`HBufC` carry their length and their maximum length; there is no NUL terminator and no unbounded copy.
- **Capabilities in the binary.** An executable's E32 header carries a capability set (`NetworkServices`, `ReadUserData`, `AllFiles`…). The loader enforces them, and anything above the lowest tier needs a signature from Symbian Signed. Our runtime declares `CAPABILITY NONE` so a self-signed development certificate is enough to install it.
- **UIDs, not bundle identifiers.** Every application has a 32-bit UID3 that the installer, the app menu, and the private data directory all key on. Two apps with the same UID are the *same app*; installing one replaces the other.

That last bullet turns into a real architectural requirement later, so hold onto it.

The relevant conclusion for a UI runtime: **Symbian gives you exactly one thread to be interactive in, and hands you the display through a server you must not stall.**

PocketJS never writes `CActive` by hand — Qt already did, and our host is an ordinary `QGLWidget` with a 30 Hz timer. But look at what that timer callback actually is, once you know the machinery underneath it:

```cpp
void PocketJsRuntime::timerEvent(QTimerEvent *event)   // ← a CActive::RunL()
{
    if (event->timerId() == timer_.timerId()) {
        if (failed_) return;
        queueViewport(size());          // Qt delivered a rotation? take it
        // …context checks…
        if (!applyPendingViewport()) { recoverGuestFailure(currentApp_); return; }
        runFrame();                     // guest → core ticks → GLES2 present
        if (failed_) recoverGuestFailure(currentApp_);
        return;
    }
    QGLWidget::timerEvent(event);
}
```

`QTimer` is implemented by a `CActive` subclass, so `timerEvent()` is dispatched by the same `CActiveScheduler` loop as `CBlinker::RunL()` above, under the same rule: return, or the phone stops responding. A runtime whose entire contract is already *one frame function, called once, that must return* did not need to be taught that. It is the first reason this port took days rather than months.

## What "porting PocketJS" actually means

PocketJS applications do not draw pixels. A Solid or Vue Vapor component tree mutates a *native* tree through a small set of host operations (`createNode`, `setStyle`, `setText`, …). The Rust core, `pocketjs-core`, owns that retained tree: layout, styles, text measurement, animation, focus, hit testing. Once per frame it emits a **DrawList** — a flat, deterministic buffer of drawing commands. Something host-specific submits that DrawList to the machine.

That last sentence is the entire port surface.

<svg viewBox="0 0 760 476" width="100%" role="img" aria-label="Architecture diagram: one application bundle of app.js plus app.pak runs inside QuickJS against HostOps, which drives pocketjs-core, which emits a DrawList. Four host backends consume the same DrawList: PSP sceGu at 480 by 272, Vita GXM at 960 by 544, ESP32-P4 PPA at RGB565, and the new Symbian GLES2 backend at 640 by 360. Below, a panel lists what the Symbian port added: a Qt QGLWidget host, a no-std armv6 core build, a GLES2 DrawList backend, a live viewport, physical key input, and SIS packaging — and what it did not change: the DrawList format, the core, the framework, or the production target registry." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="196" y="8" width="368" height="66" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="32" fill="#f1f5f9" font-size="13.5" font-weight="700" text-anchor="middle">app.tsx → app.js + app.pak</text>
  <text x="380" y="52" fill="#38bdf8" font-size="11" text-anchor="middle">Solid / Vue Vapor — identical bytes on every target</text>
  <text x="380" y="68" fill="#64748b" font-size="10.5" text-anchor="middle">styles, fonts and images are baked into the .pak</text>
  <rect x="196" y="88" width="368" height="46" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="107" fill="#e2e8f0" font-size="12.5" text-anchor="middle">QuickJS + HostOps</text>
  <text x="380" y="125" fill="#64748b" font-size="10.5" text-anchor="middle">~30 calls: createNode · setStyle · setText · animate …</text>
  <rect x="196" y="148" width="368" height="46" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="167" fill="#e2e8f0" font-size="12.5" text-anchor="middle">pocketjs-core — layout, text, animation</text>
  <text x="380" y="185" fill="#22d3ee" font-size="10.5" text-anchor="middle">no_std Rust · the same crate on every target</text>
  <rect x="266" y="208" width="228" height="34" rx="8" fill="#0e1626" stroke="#38bdf8" stroke-width="1.3"/>
  <text x="380" y="230" fill="#f1f5f9" font-size="12" text-anchor="middle">DrawList — the portable seam</text>
  <path d="M290 242 L120 276 M340 242 L300 276 M420 242 L470 276 M470 242 L648 276" stroke="#475569" stroke-width="1.3" fill="none"/>
  <rect x="16" y="282" width="196" height="62" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="28" y="302" fill="#e2e8f0" font-size="11.5">PSP · sceGu</text>
  <text x="28" y="320" fill="#64748b" font-size="10.5">480×272, fixed function</text>
  <text x="28" y="336" fill="#64748b" font-size="10.5">2 MB VRAM</text>
  <rect x="220" y="282" width="164" height="62" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="232" y="302" fill="#e2e8f0" font-size="11.5">Vita · GXM</text>
  <text x="232" y="320" fill="#64748b" font-size="10.5">960×544, density 2</text>
  <rect x="392" y="282" width="164" height="62" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="404" y="302" fill="#e2e8f0" font-size="11.5">ESP32-P4 · PPA</text>
  <text x="404" y="320" fill="#64748b" font-size="10.5">RGB565 strips</text>
  <rect x="564" y="282" width="180" height="62" rx="8" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="576" y="302" fill="#f1f5f9" font-size="11.5" font-weight="700">Symbian · GLES2</text>
  <text x="576" y="320" fill="#22d3ee" font-size="10.5">640×360 ⇄ 360×640</text>
  <text x="576" y="336" fill="#22d3ee" font-size="10.5">new in this port</text>
  <rect x="16" y="358" width="356" height="104" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="30" y="380" fill="#f1f5f9" font-size="12" font-weight="700">the port added</text>
  <text x="30" y="400" fill="#94a3b8" font-size="11">a Qt/QuickJS host · an ARMv6 no_std build</text>
  <text x="30" y="416" fill="#94a3b8" font-size="11">a GLES2 backend · a live viewport</text>
  <text x="30" y="432" fill="#94a3b8" font-size="11">physical-key input · SIS packaging, per-app UIDs</text>
  <text x="30" y="448" fill="#94a3b8" font-size="11">a native extension ABI for 3D apps</text>
  <rect x="388" y="358" width="356" height="104" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="402" y="380" fill="#f1f5f9" font-size="12" font-weight="700">the port did not change</text>
  <text x="402" y="400" fill="#22d3ee" font-size="11">the DrawList format · the core's semantics</text>
  <text x="402" y="416" fill="#22d3ee" font-size="11">one line of framework code</text>
  <text x="402" y="432" fill="#22d3ee" font-size="11">the production target registry</text>
  <text x="402" y="448" fill="#22d3ee" font-size="11">49 pixel goldens · 180 frame hashes</text>
</svg>

That last line is the honest measure of whether an architecture scales to a new machine. If adding Symbian had needed one pixel of change in the PSP's goldens, the seam would have been in the wrong place.

## Part 1: the toolchain is archaeology

Before any of that could run, we needed a compiler. This turned out to be the least glamorous and most fragile part of the whole project, and it is worth describing because "get a 2011 toolchain to behave like a 2026 one" is a genuinely recurring problem.

The inputs are historical artifacts:

- **GCCE 4.6.3** — the GCC targeting Symbian's ARM EABI. Shipped as a 32-bit **i686 Linux** binary.
- **Belle SDK (`SymbianSR1Qt474`)** — headers, import libraries, and the E32 tools.
- **Qt 4.7.4 source**, used to build a native `qmake` — the phone's ROM has Qt 4.8, which happily runs an application built against 4.7.4.
- **GnuPoc** — [mstorsjo's](https://github.com/mstorsjo/gnupoc-package) native reimplementations of `elf2e32`, `petran`, and the SIS packaging and signing tools, so we don't need Windows.
- **QuickJS**, pinned to a revision with a Symbian/GCCE patch.

The 32-bit-Intel-binary detail decides the architecture: the build runs in a `linux/amd64` container with i386 multiarch enabled. On an Apple Silicon Mac that means the toolchain executes under two layers of emulation, which is fine, because it is a build, not a game.

Then repeatability. Pinning the *downloads* by SHA-256 is easy. The trap is that a Dockerfile which runs `apt-get install` is not pinned at all — rebuild it in six months and you get different native tools under the same image tag, still labelled "reproducible". So the container installs from exact [Debian snapshot](https://snapshot.debian.org/) timestamps, and the resolved package set is itself hashed into the toolchain's implementation digest.

<svg viewBox="0 0 760 344" width="100%" role="img" aria-label="Pipeline diagram of the Symbian build: five SHA-256 pinned downloads plus a pinned Rust nightly feed an isolated linux/amd64 container built from Debian snapshots. Inside, the app pipeline runs the PocketJS two-pass build to app.js and app.pak, cross-compiles the no-std Rust core for armv6-symbian-eabi, compiles the Qt host with GCCE 4.6.3 in C++98, links everything, converts the ELF to an E32 image with elf2e32, packages a SIS and signs it with a development certificate held in a separate Docker volume. The output is one signed SIS plus a receipt JSON recording every input hash. Deployment goes over USB MTP with a byte-for-byte readback, and remote launch goes over the CODA agent." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="14" y="14" width="152" height="150" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="26" y="36" fill="#f1f5f9" font-size="12" font-weight="700">pinned inputs</text>
  <text x="26" y="56" fill="#94a3b8" font-size="10.5">Belle SDK · Qt 4.7.4</text>
  <text x="26" y="74" fill="#94a3b8" font-size="10.5">GCCE 4.6.3 · i686</text>
  <text x="26" y="92" fill="#94a3b8" font-size="10.5">Qt 4.7.4 → qmake</text>
  <text x="26" y="110" fill="#94a3b8" font-size="10.5">GnuPoc E32 / SIS</text>
  <text x="26" y="128" fill="#94a3b8" font-size="10.5">QuickJS @ 0fc946fb</text>
  <text x="26" y="150" fill="#38bdf8" font-size="10.5">all SHA-256 verified</text>
  <path d="M166 88 L186 88" stroke="#475569" stroke-width="1.5"/>
  <path d="M186 88 l-8 -5 M186 88 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="192" y="14" width="348" height="238" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.4"/>
  <text x="366" y="36" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">linux/amd64 container · no network</text>
  <text x="366" y="53" fill="#38bdf8" font-size="10.5" text-anchor="middle">Debian snapshot imports · i386 multiarch</text>
  <text x="206" y="80" fill="#94a3b8" font-size="11">1 · two-pass app build → app.js + app.pak</text>
  <text x="206" y="102" fill="#94a3b8" font-size="11">2 · cargo build-std → armv6-symbian-eabi .a</text>
  <text x="206" y="124" fill="#94a3b8" font-size="11">3 · GCCE 4.6.3, C++98 → Qt host objects</text>
  <text x="206" y="146" fill="#94a3b8" font-size="11">4 · link host + core + QuickJS (--no-undefined)</text>
  <text x="206" y="168" fill="#94a3b8" font-size="11">5 · elf2e32 → E32 image, UID3, CAPABILITY NONE</text>
  <text x="206" y="190" fill="#94a3b8" font-size="11">6 · makesis + signsis → one installable .sis</text>
  <text x="206" y="220" fill="#64748b" font-size="10.5">repo mounted read-only · one writable output dir</text>
  <text x="206" y="238" fill="#64748b" font-size="10.5">signing key in its own volume, never rotated</text>
  <path d="M540 88 L560 88" stroke="#475569" stroke-width="1.5"/>
  <path d="M560 88 l-8 -5 M560 88 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="566" y="14" width="180" height="112" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.4"/>
  <text x="578" y="36" fill="#f1f5f9" font-size="12" font-weight="700">outputs</text>
  <text x="578" y="58" fill="#22d3ee" font-size="10.5">app.sis — installable</text>
  <text x="578" y="78" fill="#94a3b8" font-size="10.5">app.receipt.json —</text>
  <text x="578" y="94" fill="#94a3b8" font-size="10.5">hashes of JS, pak, plan,</text>
  <text x="578" y="110" fill="#94a3b8" font-size="10.5">core, data, QuickJS rev</text>
  <rect x="566" y="140" width="180" height="112" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="578" y="162" fill="#f1f5f9" font-size="12" font-weight="700">to the phone</text>
  <text x="578" y="184" fill="#94a3b8" font-size="10.5">USB MTP upload, then</text>
  <text x="578" y="200" fill="#94a3b8" font-size="10.5">read the object back and</text>
  <text x="578" y="216" fill="#94a3b8" font-size="10.5">compare SHA-256 before</text>
  <text x="578" y="232" fill="#94a3b8" font-size="10.5">claiming delivery</text>
  <rect x="14" y="272" width="732" height="60" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="28" y="294" fill="#f1f5f9" font-size="12" font-weight="700">and one small piece of luck: CODA</text>
  <text x="28" y="314" fill="#94a3b8" font-size="11">Qt SDK 1.2.1 shipped an on-device agent speaking TCF over USB. We reimplemented enough of Qt Creator's</text>
  <text x="28" y="330" fill="#94a3b8" font-size="11">transport to run `coda usb launch App.exe` from a Mac — no driver, no IP. <tspan fill="#22d3ee">Reply: “CODA process: p2399”.</tspan></text>
</svg>

Two things about that diagram are worth calling out for anyone doing similar work.

**The signing identity is infrastructure, not a build artifact.** Symbian will only upgrade an installed package if the new one is signed by the same certificate and carries a higher version. A `docker volume prune` that takes out your development key means every installed app is permanently stuck — you cannot upgrade them, only uninstall. So the key lives in its own named volume, the setup step refuses to rotate a valid identity, and `doctor` prints its fingerprint.

**Byte delivery deserves a proof.** MTP over USB to a phone is not a reliable channel in the "either it worked or it errored" sense. The deploy command uploads once, reads the object back by the ID the phone returned, and compares SHA-256 — and then explicitly *does not* claim the app is installed, because on Symbian installation is a human tapping through a self-signed-certificate warning.

The one genuinely funny obstacle: CODA's original SIS is signed by a Nokia certificate that expired on 2016-01-02. The documented workaround is to disconnect the phone from the network, turn off automatic time, set the date to 2015, install, and set the clock back.

## Part 2: Rust, no_std, on a phone from 2011

The core is a `no_std` Rust crate. Getting it onto Symbian needed a custom target JSON (`armv6-symbian-eabi`), a pinned nightly, and `-Z build-std`, since no prebuilt `core` exists for a target Rust has never heard of. Two details are worth passing on:

**The allocator has to be honest about alignment.** The core's global allocator forwards to Symbian's C `malloc`, which guarantees 8-byte alignment. Rust's `GlobalAlloc` may ask for more. The first version silently ignored that; the fixed version returns null for any alignment above 8, in both `alloc` and `realloc`, so an impossible request fails loudly instead of producing a misaligned pointer that works until it doesn't.

**No weak symbols.** Applications that need their own native code (we will get to OpenStrike) export an extension table the host looks up. The obvious C idiom is a weak symbol that defaults to null — but Symbian's E32 conversion tools cannot safely consume ELF weak relocations. So the stock core exports an explicit *null provider* and application cores disable that Cargo feature and export the real one. It is uglier than a weak symbol and it survives `elf2e32`.

## Part 3: a screen that rotates

Every previous PocketJS target had one resolution, forever. The PSP is 480×272. The Vita renders the same logical 480×272 world at 960×544. Both are compile-time facts.

The E7 is 640×360 in landscape, and 360×640 the moment you slide the keyboard shut and turn it. Both are the *native* viewport — there is no letterbox, no PSP-shaped island in the middle of the screen.

The first plan was to pick one orientation and pillarbox the other, and it did not survive being said out loud: writing a resolution into an application is exactly the class of thing this runtime exists to make impossible. So the E7 got the real version.

<div class="grid gap-4 sm:grid-cols-[1.6fr_1fr]">
  <img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-hero-landscape.png" alt="Hero demo in landscape at 640 by 360: a single row with the headline, body copy, and the Press Circle button beside the counter" />
  <img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-hero-portrait.png" alt="The same Hero demo in portrait at 360 by 640: the header statistics wrap under the logo, the body copy breaks across two lines, and the button and counter stack" />
</div>

<p class="text-sm text-slate-500 -mt-2">The same app, the same build, the same running instance — 640×360 and 360×640. The count is preserved across rotation because nothing remounts.</p>

The mechanism has three parts:

1. **The manifest declares a dynamic viewport.** `pocket.json` gains a `dynamic` block — `default: [640,360]`, `min: [360,360]`, `max: [640,640]` — alongside the existing `fixed` PSP/Vita contract. An app that has not declared one is *rejected* by the E7 build, rather than silently stretched.
2. **The host resizes the core first, then tells the framework.** Qt's automatic orientation delivers a resize event; the host calls `ui_set_viewport()` and then a live-viewport hook shared by both frameworks.
3. **Solid and Vue Vapor update their roots in place.** No unmount, no remount. Application state, focus ownership, timers, and animation phase all survive rotation, because from the framework's perspective nothing happened except two numbers changing.

That third point is where a UI runtime earns its keep. Rotation on this phone is *not* an app restart, and it is not a media query either — it is the same reactive graph observing a different viewport.

## Part 4: many apps, one runtime

Symbian's UID model, from the interlude, has a consequence: if every PocketJS app shipped as "the PocketJS runtime", installing the second one would replace the first.

So the packager derives a stable private-range UID from each app's Pocket id, along with a collision-resistant executable name, its own app-menu caption, and its own SIS and receipt filenames. Pocket Figma is `0xEEB7A533`; OpenStrike is `0xE86B9226`. They are separate applications on the phone's menu, installable and removable independently, that happen to share a runtime the way two Electron apps share Chromium.

Then there is the other direction: the **Pocket Launcher**, which packs many `.pocket` app bundles into *one* SIS and switches between them.

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-launcher.png" alt="The PocketJS Cover Flow launcher at 640 by 360 on the E7: a perspective carousel of app covers receding to both sides with mirrored reflections below, the centred card showing a retro Chrome-style window, and the caption 'Chrome — 3 / 18 — dev.pocket-nexus.chrome'" />

<p class="text-sm text-slate-500 -mt-4">The Cover Flow launcher at 640×360 — real perspective, not a scaled sprite strip. The core projects and depth-sorts the cards, then subdivides each into textured triangles; the E7 backend decodes those triangles straight into GLES2 draw calls. (The "this host cannot switch apps" hint is the wasm oracle telling on itself — the capability is a host feature, and on the phone this line reads differently.)</p>

The launcher holds exactly one live guest. Choosing a card captures a frozen shot of the outgoing frame as a texture, tears down that guest's realm and core, and cold-boots the next package behind the still image. On a machine with 256 MB and one thread, "keep them all warm" is not an option, so the switch is honest about being a switch.

Home or Backspace summons the launcher back. The whole flow is the same Cover Flow launcher that shipped on PSP and Vita, retargeted — the app-switching machinery is host-level, so it came along with the host.

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-launcher-portrait.png" alt="The same launcher rotated to portrait at 360 by 640: the carousel occupies the upper half of the taller screen with the caption below" />

<p class="text-sm text-slate-500 -mt-4">And in portrait, because the launcher is an app too, and the live viewport contract does not have exceptions.</p>

## Part 5: the day it ran at less than one frame per second

Here is the part of the story where the architecture paid off, after first sending the bill.

The first working host presented like this: the Rust core rasterized the DrawList on the CPU into an ARGB32 buffer, wrapped it in a `QImage`, and blitted it with `QPainter`. That is exactly how the PSP and the ESP32 work, minus their hardware blitters, and it is the reason the port booted so quickly — the same software rasterizer that produces our pixel goldens produced the phone's first frame.

Then we installed Pocket Figma and the launcher on the device. My note from that session, in full, was: *figma 和 launcher 真机实测非常卡顿 < 1fps* — under one frame per second, on hardware.

The diagnosis was not subtle: **the phone's GPU was not involved at all.** We were asking a 680 MHz in-order ARM11 with no NEON to software-rasterize 230,400 pixels — 1.76× the PSP's frame — including a perspective-warped Cover Flow and full-screen image tiles, and then to memcpy the result through Qt's painter into the window server. The PSP survives this workload because it has a GPU doing the rasterizing; here we had simply not used the one in the phone.

So the fix was to write the fourth DrawList backend.

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="Before and after diagram. Before: pocketjs-core emits a DrawList, the software rasterizer converts it to an ARGB32 framebuffer, QImage wraps it, QPainter blits it to the window server, and the Broadcom GPU is unused — result under 1 frame per second. After: the same DrawList is decoded by a GLES2 backend into vertex buffers and texture uploads, submitted to the Broadcom GPU through a QGLWidget's EGL context, with a per-texture revision cache so unchanged textures are never re-uploaded — result: the launcher is smooth and Pocket Figma is fluid on the device." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#f87171" font-size="12" font-weight="700">BEFORE — PR #176</text>
  <rect x="14" y="30" width="150" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="26" y="48" fill="#e2e8f0" font-size="11">DrawList</text>
  <text x="26" y="64" fill="#64748b" font-size="10">from the core</text>
  <path d="M164 51 L188 51" stroke="#475569" stroke-width="1.4"/><path d="M188 51 l-8 -4 M188 51 l-8 4" stroke="#475569" stroke-width="1.4" fill="none"/>
  <rect x="192" y="30" width="186" height="42" rx="7" fill="#1a0e12" stroke="#7f1d1d"/>
  <text x="204" y="48" fill="#fca5a5" font-size="11">software raster → ARGB32</text>
  <text x="204" y="64" fill="#7f1d1d" font-size="10">230,400 px/frame on the CPU</text>
  <path d="M378 51 L402 51" stroke="#475569" stroke-width="1.4"/><path d="M402 51 l-8 -4 M402 51 l-8 4" stroke="#475569" stroke-width="1.4" fill="none"/>
  <rect x="406" y="30" width="160" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="418" y="48" fill="#e2e8f0" font-size="11">QImage → QPainter</text>
  <text x="418" y="64" fill="#64748b" font-size="10">blit to window server</text>
  <rect x="580" y="30" width="166" height="42" rx="7" fill="#0b0f1a" stroke="#3f2130" stroke-dasharray="4 3"/>
  <text x="592" y="48" fill="#64748b" font-size="11">Broadcom GPU</text>
  <text x="592" y="64" fill="#7f1d1d" font-size="10">idle — never asked</text>
  <text x="14" y="94" fill="#f87171" font-size="11.5">measured on the device: under 1 fps for Pocket Figma and the launcher</text>
  <line x1="14" y1="112" x2="746" y2="112" stroke="#1e293b"/>
  <text x="14" y="140" fill="#22d3ee" font-size="12" font-weight="700">AFTER — PR #183</text>
  <rect x="14" y="150" width="150" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="26" y="168" fill="#e2e8f0" font-size="11">DrawList</text>
  <text x="26" y="184" fill="#22d3ee" font-size="10">unchanged, byte-exact</text>
  <path d="M164 171 L188 171" stroke="#475569" stroke-width="1.4"/><path d="M188 171 l-8 -4 M188 171 l-8 4" stroke="#475569" stroke-width="1.4" fill="none"/>
  <rect x="192" y="150" width="186" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.3"/>
  <text x="204" y="168" fill="#e2e8f0" font-size="11">GLES2 backend · Rust</text>
  <text x="204" y="184" fill="#22d3ee" font-size="10">8 ops → VBOs + textures</text>
  <path d="M378 171 L402 171" stroke="#475569" stroke-width="1.4"/><path d="M402 171 l-8 -4 M402 171 l-8 4" stroke="#475569" stroke-width="1.4" fill="none"/>
  <rect x="406" y="150" width="160" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="418" y="168" fill="#e2e8f0" font-size="11">QGLWidget · EGL</text>
  <text x="418" y="184" fill="#64748b" font-size="10">synchronous updateGL()</text>
  <path d="M566 171 L590 171" stroke="#475569" stroke-width="1.4"/><path d="M590 171 l-8 -4 M590 171 l-8 4" stroke="#475569" stroke-width="1.4" fill="none"/>
  <rect x="594" y="150" width="152" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.3"/>
  <text x="606" y="168" fill="#f1f5f9" font-size="11">Broadcom GPU</text>
  <text x="606" y="184" fill="#22d3ee" font-size="10">rasterize · blend</text>
  <rect x="14" y="206" width="732" height="82" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="28" y="228" fill="#f1f5f9" font-size="11.5" font-weight="700">what the backend owns — and what it deliberately does not</text>
  <text x="28" y="248" fill="#94a3b8" font-size="11">Owns: vertex assembly, texture upload and format conversion (5650 / 4444 / 8888 / palettized T8 → RGBA),</text>
  <text x="28" y="264" fill="#94a3b8" font-size="11">scissor in GL's bottom-left space, straight-alpha blending, and a per-texture <tspan fill="#22d3ee">revision</tspan> so an in-place</text>
  <text x="28" y="280" fill="#94a3b8" font-size="11">update re-uploads one texture. Does not own: geometry, clipping, layout, z-order — the core decides those.</text>
</svg>

Note what did *not* move. The GPU did not get to decide geometry. The core still emits the same CPU-clipped, depth-sorted DrawList it emits for the PSP's fixed-function GE, and the perspective Cover Flow still arrives as pre-subdivided textured triangles rather than as a projection matrix. That is a deliberate constraint: it is what keeps one deterministic frame definition across a fixed-function GPU from 2004, a programmable one from 2011, `wgpu` on a laptop, and a software rasterizer in a test.

The device verdict after the GLES2 backend landed: the launcher was smooth, Pocket Figma went from unusable to acceptable.

### The text turned black

Then a regression appeared that is a perfect small illustration of "portable format, per-target contract".

Text on the E7 rendered *black*, everywhere, regardless of the color the app asked for. Not missing, not garbled — black.

The DrawList's color encoding was fine. The bug was in the new backend's glyph atlas: it uploaded font coverage as a `GL_ALPHA` texture, and the shared fragment shader does `texture2D(...) * v_color`. OpenGL ES 2.0 specifies that sampling a `GL_ALPHA` texture yields `(0, 0, 0, coverage)` — the RGB channels are *defined* to be zero. So every text color, whatever it was, got multiplied by black.

This is not a driver quirk; it is the spec, and every other backend had quietly avoided it in a different way. The software rasterizer, the PSP, and `wgpu` use coverage only to scale alpha. The Vita uploads white RGB alongside coverage alpha. The fix was to match them at half the memory cost of RGBA: upload the atlas as `GL_LUMINANCE_ALPHA`, two bytes per texel, `[255, coverage]`.

A "portable" intermediate format does not mean every backend can be written without reading the target's spec. It means the *contract* is written down in one place, so a backend that violates it produces a bug you can name in one sentence.

## Part 6: Pocket Figma, and the cost of a copy

[Pocket Figma](/blog/pocket-figma/) opens real `.fig` design files on handhelds. Its content is a pyramid of pre-baked image tiles — the same idea as a slippy map — streamed as you pan and zoom.

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-figma-fit.png" alt="Pocket Figma at 640 by 360 on the E7 showing the Welcome page of a design file fitted to the screen: a Paper Kit wireframe cover on the left and a grid of white artboards with illustrations, with a status bar reading 'Welcome — T/S page  Q/E zoom  Esc fit — 10%'" />

<p class="text-sm text-slate-500 -mt-4">A real design file at 10% fit on the E7's 640×360 — and, in the status bar, the discoverability fix: <code>T/S</code> page, <code>Q/E</code> zoom, <code>Esc</code> fit. Keyboard-driven controls are useless if nothing on screen says they exist.</p>

Even after the GLES2 backend, Figma was the last app to feel right. The reason was on the *other* side of the JS boundary.

The tile path went: the guest reads the pack from its `__pak` ArrayBuffer, slices out the tile it needs, and hands the bytes to `ui.uploadTexture()`. On a 6 MB pack, in a QuickJS heap living inside a Symbian process, every pan that crosses a tile boundary and every mip change means JavaScript-side slicing and copying of image data — and the copies are large enough that the process heap notices.

So the host grew one more operation: `ui.loadTileTexture(name, index)`. The guest names a tile; the *host* looks the entry up in the pack it already owns, and hands the bytes straight to Rust for upload. No JS-side slice, no second copy, no decompression in the interpreter.

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-figma-zoom.png" alt="Pocket Figma zoomed to 29 percent on the E7, showing crisp artboard content: illustrations of people, a 'Downloads' artboard with credit lines, and a small navigation menu" />

<p class="text-sm text-slate-500 -mt-4">Zoomed to 29%. The tiles the viewport needs are uploaded by the host straight from the pack; the guest only ever names them.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/symbian-e7-figma-components.png" alt="Pocket Figma showing a different page of the same file, 'Components', at 4 percent zoom: a long horizontal row of dozens of small artboards spread across the canvas" />

<p class="text-sm text-slate-500 -mt-4">A second page of the same file at 4% — the `T`/`S` page switch. It was implemented before it was discoverable; the status bar came later, after the obvious feedback that nobody can press a key they don't know about.</p>

There is a small governance point hidden in `loadTileTexture`. It would have been easy to expose "read arbitrary bytes from the pack" to JavaScript. Instead the operation is narrow — name a tile, get a texture handle — because the pack bytes are host-owned and the guest gets a separate writable buffer. Script code cannot mutate storage that native code is borrowing.

The user's verdict after the final build reached the phone: **实测流畅** — fluid in real use.

## Part 7: OpenStrike, and how an app brings its own engine

[OpenStrike](/blog/shipping-openstrike/) is our Counter-Strike-shaped FPS: BSP maps, bots, a Solid JSX HUD, holding 60 FPS on a real PSP. Getting it onto the E7 was the point at which "PocketJS is a 2D UI runtime" had to stop being true.

<img class="w-full rounded-xl border border-line" src="/assets/blog/openstrike-psp-dust2.png" alt="OpenStrike running on a PSP: the sunlit dust2 courtyard with cliffs, green ammo crates, a rifle viewmodel, and a JSX HUD showing HP 100, ammo 30/90 and HOSTILES 3/3" />

<p class="text-sm text-slate-500 -mt-4">This frame is the PSP build, from OpenStrike's launch post — we do not have a device capture of the E7 running it. The E7 runs the same <code>openstrike-core</code> simulation and the same cooked <code>.p3d</code> maps, through a GLES2 renderer instead of the PSP's fixed-function GE, at 640×360 instead of 480×272. All eight maps ship in one 22.8 MB installable.</p>

An FPS cannot be expressed in host operations. It needs its own renderer, its own map loader, its own simulation running at a fixed step. But forking the Qt/QuickJS host per application would have been the end of the port as a *platform*.

So the host grew a **versioned native extension ABI**: an application supplies a prebuilt static library implementing the ordinary `ui_*` core surface, which may *also* export a table of callbacks — `boot`, `before_guest`, `after_guest`, `resize`, `render`, `shutdown` — plus a flag requesting a depth buffer.

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Diagram of one E7 frame with a native extension: at 30 hertz the host samples buttons and physical keys, calls the extension's before_guest with a native key bitset, calls the JavaScript frame function once, drains QuickJS promise jobs, calls after_guest, advances the core two fixed 60 hertz ticks, then renders — the extension draws its 3D world into the depth-tested color buffer first and the core composites the retained PocketJS HUD over it without clearing. Beneath, a split shows what PocketJS owns versus what the application extension owns." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE HOST FRAME · 30 Hz · QTimer → timerEvent() → an active object's RunL()</text>
  <rect x="14" y="30" width="732" height="150" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="28" y="46" width="150" height="36" rx="6" fill="#0e1626" stroke="#38bdf8"/>
  <text x="40" y="62" fill="#e2e8f0" font-size="11">sample input</text>
  <text x="40" y="76" fill="#38bdf8" font-size="9.5">buttons + native keys</text>
  <rect x="188" y="46" width="134" height="36" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="200" y="62" fill="#e2e8f0" font-size="11">before_guest()</text>
  <text x="200" y="76" fill="#64748b" font-size="9.5">its sim steps here</text>
  <rect x="332" y="46" width="170" height="36" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="344" y="62" fill="#e2e8f0" font-size="11">frame(buttons, touches)</text>
  <text x="344" y="76" fill="#22d3ee" font-size="9.5">one call into QuickJS</text>
  <rect x="508" y="46" width="110" height="36" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="520" y="62" fill="#e2e8f0" font-size="11">drain jobs</text>
  <text x="520" y="76" fill="#64748b" font-size="9.5">promise queue</text>
  <rect x="628" y="46" width="104" height="36" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="640" y="62" fill="#e2e8f0" font-size="11">after_guest()</text>
  <text x="640" y="76" fill="#64748b" font-size="9.5">drain commands</text>
  <rect x="28" y="96" width="216" height="36" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="40" y="112" fill="#e2e8f0" font-size="11">ui_tick() × 2</text>
  <text x="40" y="126" fill="#64748b" font-size="9.5">the core advances at a fixed 60 Hz</text>
  <rect x="254" y="96" width="238" height="36" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="266" y="112" fill="#e2e8f0" font-size="11">extension render() — the 3D world</text>
  <text x="266" y="126" fill="#64748b" font-size="9.5">depth-tested, owns the color buffer</text>
  <rect x="502" y="96" width="230" height="36" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="514" y="112" fill="#e2e8f0" font-size="11">ui_gl_render_over() — the HUD</text>
  <text x="514" y="126" fill="#22d3ee" font-size="9.5">composites without clearing</text>
  <text x="28" y="158" fill="#94a3b8" font-size="11">The JavaScript frame is consulted exactly once and can never stall the simulation — the same</text>
  <text x="28" y="174" fill="#94a3b8" font-size="11">one-crossing-per-frame discipline as every other target, which on this OS also keeps the phone alive.</text>
  <rect x="14" y="196" width="360" height="124" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.3"/>
  <text x="28" y="218" fill="#f1f5f9" font-size="12" font-weight="700">PocketJS owns</text>
  <text x="28" y="240" fill="#94a3b8" font-size="11">QuickJS, lifecycle, the GLES2 context, packaging,</text>
  <text x="28" y="258" fill="#94a3b8" font-size="11">physical-key sampling, the app UID and SIS, the</text>
  <text x="28" y="276" fill="#94a3b8" font-size="11">JSX overlay, rotation, and the receipt that pins</text>
  <text x="28" y="294" fill="#94a3b8" font-size="11">every byte that went into the package.</text>
  <text x="28" y="314" fill="#22d3ee" font-size="10.5">unchanged for every other app on the platform</text>
  <rect x="386" y="196" width="360" height="124" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="400" y="218" fill="#f1f5f9" font-size="12" font-weight="700">the application extension owns</text>
  <text x="400" y="240" fill="#94a3b8" font-size="11">the OpenStrike simulation, BSP map loading, and</text>
  <text x="400" y="258" fill="#94a3b8" font-size="11">Pocket3D's GLES2 world renderer — actors,</text>
  <text x="400" y="276" fill="#94a3b8" font-size="11">viewmodels, progressive textures, effects.</text>
  <text x="400" y="296" fill="#94a3b8" font-size="11">Maps live outside app.pak, in the app's private</text>
  <text x="400" y="314" fill="#94a3b8" font-size="11">mass-memory directory, hash-pinned in the receipt.</text>
</svg>

That last line solves a problem specific to this class of device. Eight cooked CS maps do not belong inside `app.pak`: the pack is embedded in the executable's read-only data and mirrored into the guest, so a 20 MB pack would be duplicated inside a process heap that does not have room for it. So custom cores can declare a `--mass-storage-data-root` — an ordinary directory tree, staged into `E:\private\<UID>\data\`, with every path, byte count, and SHA-256 recorded in the build receipt and re-validated inside the offline container.

The path validation is deliberately paranoid: no symlinks, no special files, no unsafe relative paths, no case-insensitive collisions (Symbian's filesystem does not distinguish `Dust2.p3d` from `dust2.p3d`), no overlap with the build payload. A packaging step that silently follows a symlink out of the source tree is a supply-chain bug with a friendly face.

## Part 8: the W key does not report W

OpenStrike ran. Dust2 rendered. Looking around was smooth. And you could not walk.

This is the part of the port that cost the most wall-clock time for the least code, and it ends on a fact about this phone that is worth carrying away: **the Nokia E7's `W` key does not report `W`. It reports scan code `2`.**

The debugging went in three rounds, and they are worth listing because each one *looked* like a complete answer:

**Round 1 — nothing works.** The host matched `Qt::Key_W`, which is the uppercase ASCII value `0x57`. Qt 4.7's Symbian backend forwards ordinary character keysyms straight through, so an unshifted physical W arrives as lowercase `'w'`. Special keys — Enter, Backspace, arrows — go through Qt's own translation and worked fine, which is exactly the kind of partial success that makes you trust the wrong hypothesis. Fix: normalize ASCII letters before mapping. Shipped as PR #187.

**Round 2 — A, S and D work; W and R do not.** This is the report that makes no sense. A single normalization bug does not spare four letters and hit two.

The answer is in the hardware. The E7's keyboard is a 4-row slide-out QWERTY with no dedicated number row: digits live on the top letter row, reached through `Fn`. And at the driver level, that top row identifies itself by the *digits*. The physical `Q` key reports native scan code `'1'`, `W` reports `'2'`, `E` reports `'3'`, `R` reports `'4'` — right across to `P` reporting `'0'`. The other letters report their own alphabetic scan codes, which is why A, S and D behaved and W and R did not.

Above that sits the **FEP** — Symbian's Front-End Processor, the input-method layer that turns key events into characters. What Qt hands you as a "key" is the FEP's *interpretation*, which depends on the input mode, the `Fn` state, and the active editor. It is the right abstraction for a text field and the wrong one for a game controller.

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Diagram of the Nokia E7 key resolution. Top: the physical top row Q W E R T Y U I O P reports native scan codes 1 2 3 4 5 6 7 8 9 0, while the home row A S D F and the rest report their own letter scan codes. Middle: two paths — the FEP-dependent logical key, which varies with input mode and Fn state, and the stable physical scan code. The host resolves the physical matrix first and only falls back to the logical key when no recognized scan code is present. Bottom: the resulting controller mapping, W A S D movement, arrows look, E or Enter fire, R reload, Space jump, Shift walk." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">WHAT THE E7 KEYBOARD REPORTS</text>
  <g font-size="11">
    <rect x="14" y="30" width="66" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="47" y="50" fill="#fca5a5" font-size="14" text-anchor="middle" font-weight="700">Q</text><text x="47" y="68" fill="#f87171" text-anchor="middle">scan '1'</text>
    <rect x="86" y="30" width="66" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="119" y="50" fill="#fca5a5" font-size="14" text-anchor="middle" font-weight="700">W</text><text x="119" y="68" fill="#f87171" text-anchor="middle">scan '2'</text>
    <rect x="158" y="30" width="66" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="191" y="50" fill="#fca5a5" font-size="14" text-anchor="middle" font-weight="700">E</text><text x="191" y="68" fill="#f87171" text-anchor="middle">scan '3'</text>
    <rect x="230" y="30" width="66" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="263" y="50" fill="#fca5a5" font-size="14" text-anchor="middle" font-weight="700">R</text><text x="263" y="68" fill="#f87171" text-anchor="middle">scan '4'</text>
    <rect x="302" y="30" width="150" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="377" y="50" fill="#fca5a5" font-size="13" text-anchor="middle">T Y U I O</text><text x="377" y="68" fill="#f87171" text-anchor="middle">scan '5'…'9'</text>
    <rect x="458" y="30" width="66" height="46" rx="6" fill="#1a0e12" stroke="#7f1d1d"/><text x="491" y="50" fill="#fca5a5" font-size="14" text-anchor="middle" font-weight="700">P</text><text x="491" y="68" fill="#f87171" text-anchor="middle">scan '0'</text>
    <rect x="546" y="30" width="200" height="46" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="646" y="50" fill="#e2e8f0" font-size="13" text-anchor="middle">A S D F … Z</text><text x="646" y="68" fill="#22d3ee" text-anchor="middle">scan 'A'…'Z' — as expected</text>
  </g>
  <text x="14" y="96" fill="#94a3b8" font-size="11">The top row has no dedicated digits: numbers are Fn-layer characters, so the matrix names those keys by digit.</text>
  <line x1="14" y1="112" x2="746" y2="112" stroke="#1e293b"/>
  <rect x="14" y="128" width="352" height="94" rx="9" fill="#1a0e12" stroke="#7f1d1d"/>
  <text x="28" y="150" fill="#fca5a5" font-size="12" font-weight="700">QKeyEvent::key() — the logical key</text>
  <text x="28" y="170" fill="#94a3b8" font-size="11">produced by the FEP: depends on input mode,</text>
  <text x="28" y="188" fill="#94a3b8" font-size="11">Fn state, Shift, and the focused editor.</text>
  <text x="28" y="210" fill="#f87171" font-size="11">W could arrive as 'w', as 'W', or as '2'.</text>
  <rect x="394" y="128" width="352" height="94" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.3"/>
  <text x="408" y="150" fill="#e2e8f0" font-size="12" font-weight="700">QKeyEvent::nativeScanCode() — the switch</text>
  <text x="408" y="170" fill="#94a3b8" font-size="11">the physical matrix position, independent of</text>
  <text x="408" y="188" fill="#94a3b8" font-size="11">every input-method decision above it.</text>
  <text x="408" y="210" fill="#22d3ee" font-size="11">W is always scan '2' — on this device.</text>
  <rect x="14" y="238" width="732" height="84" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="28" y="260" fill="#f1f5f9" font-size="12" font-weight="700">the resolution order the host settled on</text>
  <text x="28" y="280" fill="#94a3b8" font-size="11">1 · map the whole target-specific physical matrix from the scan code — '1'…'0' → Q…P, 'A'…'Z' → themselves</text>
  <text x="28" y="298" fill="#94a3b8" font-size="11">2 · fall back to the normalized logical key only when no scan code is recognized — never reinterpret a digit</text>
  <text x="28" y="316" fill="#94a3b8" font-size="11">3 · same function for press and release · stay out of Qt's text-input mode · clear held keys on focus loss</text>
</svg>

**Round 3 — D works, W still doesn't, and R never reloads.** The remaining piece is not a mapping problem at all: it is a *sampling* problem. The host runs its frame at 30 Hz while the window server can deliver a press and its matching release between two samples. A quick tap became a key that was never held on any frame the guest saw. The fix is a latch — a press sets both the held bitset and a "pressed this frame" bitset, and the frame function ORs them, so every pulse survives for exactly one frame. Held and latched state is cleared across focus, rotation, viewport, and guest boundaries, so a rotation can never leave a key stuck down.

After that landed, the device acceptance pass was clean end to end: WASD movement with W and D pointing the right way, Enter to fire, R to reload, Backspace to the map menu, smooth first-person look, and all eight maps selectable and loadable. No sticky keys.

The generalizable lesson is not "check scan codes". It is that **an input abstraction has a domain**, and text input is not the same domain as a game controller. Symbian's FEP is a good design for the thing it was designed for. The moment we wanted "which physical switch is closed", we had to step under it — and, importantly, we had to do so in a *target-specific* table, because "scan code `2` means W" is a fact about the Nokia E7's keyboard matrix and nothing else.

## What the port cost, and what it didn't

<svg viewBox="0 0 760 268" width="100%" role="img" aria-label="Summary table of the six merged pull requests: PocketJS 176 the toolchain, host, orientation and CODA at plus 7796 lines; 183 the app catalog and GLES2 renderer at plus 5884; 185 native Pocket3D extensions at plus 3203; 186 mass-storage data packaging at plus 643; 187 letter-key normalization at plus 81; 188 physical scan-code input at plus 179. Plus OpenStrike PR 14 at plus 2848 and Pocket Figma PRs 4 and 5 at plus 609. Total roughly 21,000 lines added across three repositories in about two days, with zero changes to the production target registry and zero golden updates." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE WHOLE PORT</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="11.5">
    <text x="14" y="50" fill="#38bdf8">pocketjs #176</text><text x="150" y="50" fill="#e2e8f0">toolchain · Qt/QuickJS host · orientation · CODA over USB</text><text x="700" y="50" fill="#94a3b8" text-anchor="end">+7,796</text>
    <text x="14" y="74" fill="#38bdf8">pocketjs #183</text><text x="150" y="74" fill="#e2e8f0">per-app UIDs · launcher catalog · <tspan fill="#22d3ee">GLES2 renderer</tspan> · tile bridge</text><text x="700" y="74" fill="#94a3b8" text-anchor="end">+5,884</text>
    <text x="14" y="98" fill="#38bdf8">pocketjs #185</text><text x="150" y="98" fill="#e2e8f0">native extension ABI · Pocket3D GLES2 backend</text><text x="700" y="98" fill="#94a3b8" text-anchor="end">+3,203</text>
    <text x="14" y="122" fill="#38bdf8">pocketjs #186</text><text x="150" y="122" fill="#e2e8f0">private mass-storage data, hash-pinned in the receipt</text><text x="700" y="122" fill="#94a3b8" text-anchor="end">+643</text>
    <text x="14" y="146" fill="#38bdf8">pocketjs #187</text><text x="150" y="146" fill="#e2e8f0">normalize lowercase letter keysyms</text><text x="700" y="146" fill="#94a3b8" text-anchor="end">+81</text>
    <text x="14" y="170" fill="#38bdf8">pocketjs #188</text><text x="150" y="170" fill="#e2e8f0">resolve controls from physical scan codes · one-frame latch</text><text x="700" y="170" fill="#94a3b8" text-anchor="end">+179</text>
    <text x="14" y="194" fill="#a78bfa">open-strike #14</text><text x="150" y="194" fill="#e2e8f0">full 3D game · 8 maps · E7 controls</text><text x="700" y="194" fill="#94a3b8" text-anchor="end">+2,848</text>
    <text x="14" y="218" fill="#a78bfa">pocket-figma #4/#5</text><text x="150" y="218" fill="#e2e8f0">E7 build path · live viewport · discoverable controls</text><text x="700" y="218" fill="#94a3b8" text-anchor="end">+609</text>
  </g>
  <line x1="14" y1="232" x2="746" y2="232" stroke="#1e293b"/>
  <text x="14" y="254" fill="#22d3ee" font-size="11">≈21,000 lines · three repos · ~2 days · target registry unchanged · goldens updated: 0 · framework lines: 0</text>
</svg>

The shape of that table is the argument. The two PRs that fixed the most user-visible problems — text you can read, controls that work — are 81 and 179 lines. The large ones are a *toolchain* and a *backend*: things a new machine genuinely needs, in the two places the architecture reserved for machine-specific code.

Everything else held: the DrawList did not gain a Symbian case, the framework did not gain a platform check, the target registry did not gain an entry, and the 49 pixel goldens and 180 frame hashes that pin PSP behaviour never moved.

## The honest boundary

Symbian is **not** a production PocketJS target. It builds through a private `symbian-e7-dev` profile that lives in the tools directory, deliberately outside the production registry, and it stays there until it earns its way out:

- Installation, launch, rotation, GLES2 output, keyboard input, app switching, and three real applications are confirmed on **one** physical E7. That is a manual pass, not repeatable validation. There are no Symbian pixel goldens yet.
- Touch works on the device and is exercised by Pocket Figma, but stays outside the published contract during the private period.
- CODA gives us remote launch, not source-level debugging. Run control, breakpoints, memory and registers are all in the protocol; the CODA-to-GDB adapter, a Symbian GDB, and matching symbol artifacts are not built.
- Signed SIS packages carry a timestamp, so a build is repeatable but not byte-for-byte reproducible.

None of the historical SDK inputs are redistributed. If you want to reproduce this, you supply your own copies under their original terms — the toolchain verifies their hashes and does the rest.

## Why bother

The E7 is not a market. Nobody is shipping a Symbian app in 2026, and this port will never have users in the ordinary sense.

It is a *test*, and specifically the test we could not run any other way. PocketJS's claim is that a UI runtime can be structured so that supporting a new machine means writing a submission backend and a host, not forking a framework. Two Sony handhelds and an ESP32 do not prove that — they are all machines where you own the hardware outright, boot into your own code, and never negotiate with an operating system.

Symbian negotiates. It has a window server that owns your framebuffer, an installer that owns your identity, an input-method layer between you and the keys, a capability system that owns your privileges, and a cooperative scheduler that will freeze the phone if your frame function takes too long. It is much closer to a modern OS than a PSP is — it is, in a real sense, the *oldest* device here and the most *normal* one.

The runtime went onto it in two days, and the parts that had to change were exactly the parts we had designed to be changeable. The parts that did not change are the evidence.

Also, a slide-out QWERTY is a genuinely great way to play Counter-Strike, and it took a physical scan code table to find that out.

---

*PocketJS is open source at [pocket-nexus/pocketjs](https://github.com/pocket-nexus/pocketjs). The Symbian workflow is documented in [`docs/SYMBIAN_E7.md`](https://github.com/pocket-nexus/pocketjs/blob/main/docs/SYMBIAN_E7.md); the port is PRs [#176](https://github.com/pocket-nexus/pocketjs/pull/176), [#183](https://github.com/pocket-nexus/pocketjs/pull/183), [#185](https://github.com/pocket-nexus/pocketjs/pull/185), [#186](https://github.com/pocket-nexus/pocketjs/pull/186), [#187](https://github.com/pocket-nexus/pocketjs/pull/187) and [#188](https://github.com/pocket-nexus/pocketjs/pull/188), with [open-strike#14](https://github.com/pocket-nexus/open-strike/pull/14) and [pocket-figma#4](https://github.com/pocket-nexus/pocket-figma/pull/4) downstream.*
