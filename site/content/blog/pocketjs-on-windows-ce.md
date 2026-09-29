On the Meizu M8, `MessageBoxW` is a trapdoor.

Call it from an otherwise polished full-screen application and the illusion opens: a blue Windows title bar, a tiny system font, a desktop-sized information icon, and one little grey button. Beneath Meizu's touch interface was Windows CE 6, still thinking in windows, handles, messages, and device contexts.

<img class="mx-auto w-full max-w-sm rounded-xl border border-line" src="/assets/blog/meizu-m8-native-dialog.png" alt="A native Windows CE message box running on a real Meizu M8. The blue title bar, compact system font, information icon and small OK button contrast with the phone's touch-oriented shell behind it." />

<p class="text-sm text-slate-500 -mt-4">A real <code>MessageBoxW</code> on the M8, captured through the phone's own GDI path during the PocketJS port. No new device capture was made for this post.</p>

This screenshot changed the question I wanted the port to answer. Getting [PocketJS](/blog/introducing-pocketjs/) onto the phone was useful, but the interesting part was no longer how to persuade a 2026 Mac to build and deploy a Windows CE executable. It was this:

**What does a modern component UI look like when it lands on an operating system whose native unit of thought is a message? And how did Meizu make that operating system feel, at least from the outside, so much like the first iPhone?**

The answer is not that Windows CE was secretly modern. It is that Meizu built a new phone experience over an older, lower-level programming model, then fought the hardware until the disguise held. Porting PocketJS let us repeat a small version of the same exercise and see every seam.

## A window is an address for messages

Windows CE inherited the shape of Win32, but it was not desktop Windows squeezed into a phone. It was a configurable embedded operating system. An OEM selected the kernel components, drivers, graphics and windowing system, shell, synchronization stack, and APIs that a particular device would ship. Microsoft's own documentation repeatedly warns that an API in the complete CE package might still be absent from an OEM image.

When the graphical subsystem is present, the application model is recognizable. A native executable enters through `WinMain`. It registers a **window class** containing a callback, creates an `HWND`, then runs a loop that removes messages from the thread's queue and dispatches them to that callback.

```c
static LRESULT CALLBACK WindowProc(
    HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam
) {
    switch (message) {
        case WM_TIMER:       run_one_frame(hwnd); return 0;
        case WM_PAINT:       paint_pixels(hwnd);  return 0;
        case WM_LBUTTONDOWN: touch_down(lparam);  return 0;
        case WM_LBUTTONUP:   touch_up(lparam);    return 0;
        case WM_KEYDOWN:
            if (wparam == VK_HOME || wparam == VK_ESCAPE)
                PostMessage(hwnd, WM_CLOSE, 0, 0);
            return 0;
        case WM_DESTROY:     PostQuitMessage(0);  return 0;
    }
    return DefWindowProc(hwnd, message, wparam, lparam);
}

int WINAPI WinMain(HINSTANCE app, HINSTANCE previous,
                   LPWSTR command_line, int show) {
    RegisterClass(&window_class);
    HWND hwnd = CreateWindow(/* class, title, style, position ... */);
    SetTimer(hwnd, 1, 17, NULL);

    MSG message;
    while (GetMessage(&message, NULL, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
    return (int)message.wParam;
}
```

An `HWND` is a handle, not the window itself. The application passes that opaque value back to the operating system whenever it wants to show, move, invalidate, focus, close, or otherwise address the window. The window procedure is where the other direction arrives: touch, keys, timers, paint requests, focus changes, commands from child controls, and requests to close.

<svg viewBox="0 0 760 370" width="100%" role="img" aria-label="Windows CE UI programming model. The operating system and hardware turn time, touch, keys and invalid regions into messages in one UI-thread queue. GetMessage removes one message, DispatchMessage selects a window procedure by HWND, and the callback mutates application or control state. Paint messages grant a device context through BeginPaint, the application issues GDI drawing commands, and EndPaint validates the region. The callback must return before the queue can continue." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">WINDOWS CE UI · CONTROL RETURNS TO THE MESSAGE PUMP AFTER EVERY CALLBACK</text>
  <rect x="14" y="34" width="732" height="316" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="11">
    <rect x="30" y="54" width="108" height="36" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="84" y="77" fill="#e2e8f0" text-anchor="middle">touch / key</text>
    <rect x="146" y="54" width="108" height="36" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="200" y="77" fill="#e2e8f0" text-anchor="middle">timer</text>
    <rect x="262" y="54" width="108" height="36" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="316" y="77" fill="#e2e8f0" text-anchor="middle">invalid region</text>
    <rect x="378" y="54" width="108" height="36" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="432" y="77" fill="#e2e8f0" text-anchor="middle">shell / system</text>
  </g>
  <path d="M84 94 V116 H258" stroke="#475569" fill="none"/><path d="M200 94 V116" stroke="#475569"/><path d="M316 94 V116 H258" stroke="#475569" fill="none"/><path d="M432 94 V116 H258" stroke="#475569" fill="none"/>
  <rect x="126" y="116" width="264" height="46" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="258" y="136" fill="#f1f5f9" text-anchor="middle" font-size="12">thread message queue</text><text x="258" y="152" fill="#22d3ee" text-anchor="middle" font-size="10">GetMessage → DispatchMessage</text>
  <path d="M394 139 H442" stroke="#475569"/><path d="M442 139 l-8 -5 M442 139 l-8 5" stroke="#475569" fill="none"/>
  <rect x="446" y="112" width="270" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="581" y="134" fill="#e2e8f0" text-anchor="middle" font-size="12">WindowProc(HWND, message, wParam, lParam)</text><text x="581" y="153" fill="#64748b" text-anchor="middle" font-size="10">decode → mutate → request work → return</text>
  <path d="M581 170 V200 H468" stroke="#475569" fill="none"/><path d="M468 200 l8 -5 M468 200 l8 5" stroke="#475569" fill="none"/>
  <rect x="246" y="180" width="218" height="54" rx="7" fill="#0b0f1a" stroke="#2b3a55"/><text x="355" y="202" fill="#e2e8f0" text-anchor="middle" font-size="12">application + control state</text><text x="355" y="221" fill="#64748b" text-anchor="middle" font-size="10">globals · structs · HWND properties</text>
  <path d="M355 238 V264" stroke="#475569"/><path d="M355 264 l-5 -8 M355 264 l5 -8" stroke="#475569" fill="none"/>
  <rect x="56" y="268" width="246" height="52" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="179" y="289" fill="#e2e8f0" text-anchor="middle" font-size="12">WM_PAINT → BeginPaint</text><text x="179" y="308" fill="#22d3ee" text-anchor="middle" font-size="10">HDC clipped to damaged region</text>
  <path d="M306 294 H344" stroke="#475569"/><path d="M344 294 l-8 -5 M344 294 l-8 5" stroke="#475569" fill="none"/>
  <rect x="348" y="268" width="194" height="52" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="445" y="289" fill="#e2e8f0" text-anchor="middle" font-size="12">GDI commands</text><text x="445" y="308" fill="#64748b" text-anchor="middle" font-size="10">text · bitmap · line · fill</text>
  <path d="M546 294 H584" stroke="#475569"/><path d="M584 294 l-8 -5 M584 294 l-8 5" stroke="#475569" fill="none"/>
  <rect x="588" y="268" width="128" height="52" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="652" y="289" fill="#e2e8f0" text-anchor="middle" font-size="12">EndPaint</text><text x="652" y="308" fill="#22d3ee" text-anchor="middle" font-size="10">region valid</text>
  <path d="M716 139 V102 H520 V139 H446" stroke="#475569" fill="none" stroke-dasharray="4 4"/>
  <text x="520" y="340" fill="#64748b" text-anchor="middle" font-size="10.5">If WindowProc does not return, this thread does not process its next message.</text>
</svg>

The phrase **message pump** is literal. `GetMessage` waits when the queue is empty. `DispatchMessage` looks at the destination `HWND` and calls its registered window procedure. A `WM_TIMER` is not permission to run forever on a special timer thread; it is another item competing for the same UI thread. A five-second callback means five seconds without paint, touch, Home, or close handling.

Painting is a protocol too. The application invalidates a region. Windows eventually delivers `WM_PAINT`. `BeginPaint` lends the callback an `HDC` clipped to that damaged region, drawing commands write through it, and `EndPaint` marks the region handled. Forget to validate the region and the system keeps asking.

The native dialog in the opening screenshot hides all of this. `MessageBoxW` creates native controls, disables its owner, and remains inside a modal operation until the button is pressed. A declarative-looking line of C is concealing a second event-processing scope. That is convenient, but nested modality also makes ordering and re-entrancy harder to reason about.

None of this was primitive in the sense of being thoughtless. Handles kept ABI boundaries small. An ordered thread queue made interaction deterministic. Invalid-region painting avoided redrawing an entire low-power screen. OEM configurability let the same kernel family serve a scanner, a car computer, a PDA, or a phone. Windows CE 6 even replaced the old 32-process and 32 MB per-process ceilings with a substantially larger kernel model. The GUI contract, however, remained the Windows contract: **the operating system reports what happened; application code must decide what to mutate and what to redraw.**

## The modern mental model reverses ownership

The event loop did not disappear from modern GUI systems. iOS, Android, browsers, SwiftUI, React, Compose, and Solid all still require a responsive main thread somewhere underneath. What changed is the level at which most application authors work.

In a classic Win32-style program, the callback receives an event and performs the updates:

```c
case WM_COMMAND:
    if (LOWORD(wparam) == ID_PLAY) {
        playing = !playing;
        SetWindowText(play_button, playing ? L"Pause" : L"Play");
        EnableWindow(stop_button, playing);
        InvalidateRect(progress_window, NULL, FALSE);
    }
    return 0;
```

The Boolean, the button label, the enabled state, and the invalid region are four pieces of state that the programmer must keep synchronized.

In PocketJS with Solid, the application changes one value and describes the UI that depends on it:

```tsx
import { Button, Text, View } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const [playing, setPlaying] = createSignal(false);

<View>
  <Button onPress={() => setPlaying(value => !value)}>
    <Text>{playing() ? "Pause" : "Play"}</Text>
  </Button>
  <Button disabled={!playing()}>Stop</Button>
</View>
```

Solid tracks which computations read `playing()`. PocketJS owns the retained UI tree, layout, hit testing, invalidation, animation, and rasterization. The app does not locate a button handle and push a new string into it. It updates the source of truth; the framework makes the rendered tree agree.

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Comparison between the Windows CE and modern declarative GUI mental models across six concerns. Windows CE begins with a message and asks application callbacks to mutate handles and draw pixels. A modern declarative UI begins with state and derives a view tree, layout, semantics and pixels. Both end at an event loop and physical screen, but ownership moves from application bookkeeping into the framework." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">SAME SCREEN · DIFFERENT UNIT OF THOUGHT</text>
  <rect x="14" y="34" width="356" height="372" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="390" y="34" width="356" height="372" rx="10" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="32" y="64" fill="#f1f5f9" font-size="13" font-weight="700">Windows CE / classic Win32</text>
  <text x="408" y="64" fill="#f1f5f9" font-size="13" font-weight="700">Solid / modern declarative UI</text>
  <g font-size="10.8">
    <text x="32" y="96" fill="#64748b">TRIGGER</text><text x="126" y="96" fill="#e2e8f0">message code + packed parameters</text>
    <text x="408" y="96" fill="#22d3ee">TRIGGER</text><text x="502" y="96" fill="#e2e8f0">event mutates application state</text>
    <line x1="32" y1="112" x2="352" y2="112" stroke="#1e293b"/><line x1="408" y1="112" x2="728" y2="112" stroke="#164e63"/>
    <text x="32" y="140" fill="#64748b">IDENTITY</text><text x="126" y="140" fill="#e2e8f0">HWND / control ID / pointer</text>
    <text x="408" y="140" fill="#22d3ee">IDENTITY</text><text x="502" y="140" fill="#e2e8f0">component position + stable key</text>
    <line x1="32" y1="156" x2="352" y2="156" stroke="#1e293b"/><line x1="408" y1="156" x2="728" y2="156" stroke="#164e63"/>
    <text x="32" y="184" fill="#64748b">UPDATE</text><text x="126" y="184" fill="#e2e8f0">imperatively mutate each control</text>
    <text x="408" y="184" fill="#22d3ee">UPDATE</text><text x="502" y="184" fill="#e2e8f0">derive affected UI from state</text>
    <line x1="32" y1="200" x2="352" y2="200" stroke="#1e293b"/><line x1="408" y1="200" x2="728" y2="200" stroke="#164e63"/>
    <text x="32" y="228" fill="#64748b">LAYOUT</text><text x="126" y="228" fill="#e2e8f0">coordinates, dialog units, callbacks</text>
    <text x="408" y="228" fill="#22d3ee">LAYOUT</text><text x="502" y="228" fill="#e2e8f0">constraints / flex over a tree</text>
    <line x1="32" y1="244" x2="352" y2="244" stroke="#1e293b"/><line x1="408" y1="244" x2="728" y2="244" stroke="#164e63"/>
    <text x="32" y="272" fill="#64748b">PAINT</text><text x="126" y="272" fill="#e2e8f0">respond to invalid regions with HDC</text>
    <text x="408" y="272" fill="#22d3ee">PAINT</text><text x="502" y="272" fill="#e2e8f0">framework schedules and composites</text>
    <line x1="32" y1="288" x2="352" y2="288" stroke="#1e293b"/><line x1="408" y1="288" x2="728" y2="288" stroke="#164e63"/>
    <text x="32" y="316" fill="#64748b">LIFETIME</text><text x="126" y="316" fill="#e2e8f0">create/destroy handles and resources</text>
    <text x="408" y="316" fill="#22d3ee">LIFETIME</text><text x="502" y="316" fill="#e2e8f0">mount/unmount scopes resources</text>
  </g>
  <rect x="32" y="344" width="320" height="42" rx="6" fill="#111827" stroke="#334155"/><text x="192" y="362" fill="#94a3b8" text-anchor="middle" font-size="10.5">message → callback → mutations → paint</text><text x="192" y="378" fill="#64748b" text-anchor="middle" font-size="9.8">application owns synchronization</text>
  <rect x="408" y="344" width="320" height="42" rx="6" fill="#0e2530" stroke="#22d3ee"/><text x="568" y="362" fill="#e2e8f0" text-anchor="middle" font-size="10.5">state → reactive dependencies → pixels</text><text x="568" y="378" fill="#22d3ee" text-anchor="middle" font-size="9.8">framework owns synchronization</text>
</svg>

This reversal changes the everyday failure mode.

With the message model, it is easy for the visible interface to become a stale copy of the program's state. One branch updates the label but forgets the enabled state. One early return leaks a brush or device context. A resize handler recomputes three rectangles but misses a fourth. A modal dialog runs messages at a point the caller assumed was synchronous.

With a declarative framework, it is easier to make the state graph itself confusing: duplicate sources of truth, effects that feed back into signals, unstable component identity, or expensive recomputation. Modern frameworks do not abolish complexity. They move the central question from **“Which objects must I mutate after this message?”** to **“What UI follows from this state?”**

That shift is especially important on a phone. A desktop-era API can report a finger as `WM_LBUTTONDOWN`, but calling touch a mouse does not provide finger-sized controls, gesture arbitration, kinetic scrolling, density-aware layout, orientation handling, animation, or a coherent Back/Home contract. Those policies must exist somewhere above the message.

## What felt old and inconvenient

Windows CE's programming model was coherent, but by modern GUI standards it made application developers carry a great deal of mechanism:

- **A message is only a number plus two machine words.** The meaning of `wParam` and `lParam` changes for every message. Coordinates may be packed into bits; child-control notifications share `WM_COMMAND`; ownership is documented rather than expressed by types.
- **State is distributed.** Some lives in application structs, some inside native controls, some in window properties, some in the registry, and some only in the pixels last painted. The OS does not derive one from another.
- **Layout is not a default service.** Dialog resources and coordinates work for known screens. A 480×720, 255-ppi finger interface exposes every assumption made for a stylus PDA or desktop monitor.
- **Painting is manual and immediate.** GDI gives useful clipping and device independence, but the application still decides what must be redrawn, selects resources into a device context, and restores or deletes them correctly.
- **Lifetime is procedural.** `CreateWindow` must eventually meet `DestroyWindow`; `GetDC` must meet `ReleaseDC`; selected GDI objects have rules about when they can be deleted. The compiler cannot prove most pairings.
- **Responsiveness is a convention.** The message pump gives clean serialization only while callbacks return quickly. Long work freezes the entire UI, while adding threads introduces synchronization around state that was previously single-threaded.
- **The platform is whatever the OEM shipped.** Windows CE was a kit for device makers. That flexibility was excellent for embedded products and awkward for third-party applications expecting one stable phone platform.

The last point explains an apparent contradiction. Windows CE made it relatively easy to get *a Windows program* running on the M8. It did not make that program feel like *an M8 application*. Contemporary users noticed the gap: raw Windows CE software could run, yet its tiny controls and stylus assumptions looked alien beside Meizu's software.

Our first PocketJS frames found the same gap in a different form.

<div class="grid grid-cols-1 gap-5 sm:grid-cols-3">
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-first-frame-320.png" alt="The first PocketJS frame on the M8 using an inherited 320 by 480 surface. The headline is clipped and the result does not fill the 480 by 720 display correctly." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">1 · Valid pixels, wrong world.</strong> A 320×480 assumption compiled and launched, then failed the physical screen.</figcaption>
  </figure>
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-native-frame-480.png" alt="PocketJS at the M8's native 480 by 720 resolution, crisp but with text and controls too small for comfortable finger use." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">2 · Correct pixels, wrong body.</strong> Native resolution made the image crisp, not readable or touchable.</figcaption>
  </figure>
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-readable-frame-480.png" alt="The final PocketJS demo on the M8 at native 480 by 720 with larger text, spacing and a comfortable touch target." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">3 · A phone interface.</strong> The framebuffer stayed native while type, spacing and touch targets grew for the panel.</figcaption>
  </figure>
</div>

All three are device artifacts from the original porting session, not browser mockups. The sequence is a compact lesson in GUI models: an API can tell you the screen's coordinates and still know nothing about the human hand holding it.

## PocketJS as a translator between the two models

PocketJS does not replace Windows CE's event loop. It sits inside it.

The M8 host still creates an `HWND`, receives `WM_LBUTTONDOWN`, returns from `WindowProc`, and paints through GDI. But those mechanisms stop at a narrow boundary. The host turns messages into device-neutral frame input and hands the guest one 60 Hz tick. In the other direction, PocketJS returns one complete 480×720 BGRA framebuffer, and the host presents it with `SetDIBitsToDevice`.

<svg viewBox="0 0 760 402" width="100%" role="img" aria-label="PocketJS translating between modern declarative UI and Windows CE. On the left, state drives Solid reactive computations, a retained PocketJS tree, layout, hit testing and a software-rendered 480 by 720 BGRA framebuffer. One SetDIBitsToDevice call crosses into Windows CE and GDI. In reverse, Windows CE touch, key and timer messages are normalized by the host into one device-neutral frame input. App code never receives Windows messages." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE PORT IS A MODEL TRANSLATOR, NOT A WINDOWS CE UI TOOLKIT</text>
  <rect x="14" y="34" width="440" height="340" rx="10" fill="#0c1a22" stroke="#22d3ee"/>
  <rect x="474" y="34" width="272" height="340" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="32" y="62" fill="#f1f5f9" font-size="13" font-weight="700">Modern app model</text>
  <text x="492" y="62" fill="#f1f5f9" font-size="13" font-weight="700">Windows CE host model</text>
  <rect x="34" y="84" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="125" y="104" fill="#e2e8f0" text-anchor="middle" font-size="11.5">Solid signals + TSX</text><text x="125" y="121" fill="#22d3ee" text-anchor="middle" font-size="9.8">declare relationships</text>
  <path d="M220 108 H250" stroke="#475569"/><path d="M250 108 l-8 -5 M250 108 l-8 5" stroke="#475569" fill="none"/>
  <rect x="254" y="84" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="345" y="104" fill="#e2e8f0" text-anchor="middle" font-size="11.5">PocketJS retained tree</text><text x="345" y="121" fill="#22d3ee" text-anchor="middle" font-size="9.8">layout · focus · hit test</text>
  <path d="M345 136 V164" stroke="#475569"/><path d="M345 164 l-5 -8 M345 164 l5 -8" stroke="#475569" fill="none"/>
  <rect x="254" y="168" width="182" height="48" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="345" y="188" fill="#e2e8f0" text-anchor="middle" font-size="11.5">software rasterizer</text><text x="345" y="205" fill="#64748b" text-anchor="middle" font-size="9.8">complete 480×720 BGRA</text>
  <path d="M440 192 H506" stroke="#22d3ee"/><path d="M506 192 l-8 -5 M506 192 l-8 5" stroke="#22d3ee" fill="none"/>
  <rect x="510" y="168" width="216" height="48" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="618" y="188" fill="#e2e8f0" text-anchor="middle" font-size="11.5">SetDIBitsToDevice</text><text x="618" y="205" fill="#22d3ee" text-anchor="middle" font-size="9.8">GDI → LCD · no stretching</text>
  <line x1="32" y1="244" x2="728" y2="244" stroke="#1e293b"/>
  <text x="32" y="266" fill="#64748b" font-size="10">INPUT RETURNS THROUGH THE SAME NARROW SEAM</text>
  <rect x="510" y="282" width="216" height="46" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="618" y="301" fill="#e2e8f0" text-anchor="middle" font-size="11">WM_TIMER · WM_LBUTTON* · KEY</text><text x="618" y="317" fill="#64748b" text-anchor="middle" font-size="9.8">ordered OS messages</text>
  <path d="M506 305 H440" stroke="#475569"/><path d="M440 305 l8 -5 M440 305 l8 5" stroke="#475569" fill="none"/>
  <rect x="254" y="282" width="182" height="46" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="345" y="301" fill="#e2e8f0" text-anchor="middle" font-size="11">M8 host adapter</text><text x="345" y="317" fill="#22d3ee" text-anchor="middle" font-size="9.8">coordinates · edges · one tick</text>
  <path d="M250 305 H220" stroke="#475569"/><path d="M220 305 l8 -5 M220 305 l8 5" stroke="#475569" fill="none"/>
  <rect x="34" y="282" width="182" height="46" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="125" y="301" fill="#e2e8f0" text-anchor="middle" font-size="11">frame input</text><text x="125" y="317" fill="#22d3ee" text-anchor="middle" font-size="9.8">touches + hits · no HWND</text>
  <text x="234" y="356" fill="#22d3ee" text-anchor="middle" font-size="10.5">app owns state and desired UI</text>
  <text x="610" y="356" fill="#64748b" text-anchor="middle" font-size="10.5">host owns pump and presentation</text>
</svg>

This made Windows CE an unusually clear test of PocketJS's boundary. The operating system is responsible for time, physical input, process exit, a shell entry, and the final pixel copy. Solid and the app never learn `HWND`, `WM_PAINT`, GDI, or Meizu registry keys. Conversely, the host never learns what a button or component means.

The port did uncover two places where translating events into state is not mechanical. The M8's vertical coordinate reaches 719, beyond the 511 maximum of PocketJS's older packed touch word, so the host contract needed wider coordinates. A quick down-and-up can also occur between two 60 Hz guest samples, so the host must latch the press until one frame observes it. Windows CE delivered both messages correctly; the bug existed in the difference between an **event stream** and a **sampled state**.

That is the deeper continuity between 1990s Win32 and modern reactive UI. Both need events and state. They disagree about which one application code should organize itself around.

## How Meizu made Windows CE look like an iPhone

The easy answer is “by copying the iPhone.” Contemporary reviewers called the resemblance obvious, sometimes mercilessly so. The icon grid, glossy surfaces, touch gestures, photo browsing, inertial movement, and full-screen transitions all arrived in the wake of Apple's 2007 device. Pretending otherwise would make the history less honest.

But resemblance describes the target, not the work.

Meizu did not license Windows Mobile and reskin a finished phone shell. It licensed Windows CE as an embedded foundation and built its own system, usually called Mymobile or Mmobile, above it. In a later oral history, M8 engineer Zhu Guozhi recalled responsibility for power-on and power-off, the desktop, lock screen, notification bar, and surrounding frameworks. The team replaced the stock shell, removed desktop-like buttons and operations, and constructed touch-oriented behavior of its own.

<svg viewBox="0 0 760 438" width="100%" role="img" aria-label="Layer diagram of how Meizu turned Windows CE into the M8 experience. At the bottom are the CE 6 kernel, drivers, filesystem, registry, networking, GWES and GDI. Meizu supplied hardware adaptation, phone services and synchronization, then rewrote the shell including boot and shutdown, desktop, lock screen, notification bar and application registry. A custom component and interaction layer supported finger targets, scrolling, animation and caching. EICO and Meizu designed icons, typography, visual states and interaction. The top layer is the iPhone-like experience users saw." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE IPHONE-LIKE SURFACE WAS THE TOP OF A REBUILT STACK</text>
  <rect x="14" y="34" width="732" height="376" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="36" y="54" width="688" height="58" rx="7" fill="#14251d" stroke="#65a30d"/>
  <text x="54" y="78" fill="#ecfccb" font-size="12" font-weight="700">What the owner saw</text><text x="218" y="78" fill="#d9f99d" font-size="11">icon launcher · full-screen apps · gestures · fluid transitions</text>
  <text x="54" y="98" fill="#84a35b" font-size="10">familiar iPhone-era interaction language, adapted into Meizu's product</text>
  <path d="M380 116 V136" stroke="#475569"/><path d="M380 136 l-5 -8 M380 136 l5 -8" stroke="#475569" fill="none"/>
  <rect x="36" y="140" width="688" height="58" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="54" y="164" fill="#f1f5f9" font-size="12" font-weight="700">Interaction and visual system</text><text x="270" y="164" fill="#e2e8f0" font-size="11">EICO + Meizu · icons · states · typography · motion</text>
  <text x="54" y="184" fill="#22d3ee" font-size="10">paper-on-prototype iteration · 16-bit gradient dithering · finger-sized geometry</text>
  <path d="M380 202 V222" stroke="#475569"/><path d="M380 222 l-5 -8 M380 222 l5 -8" stroke="#475569" fill="none"/>
  <rect x="36" y="226" width="688" height="58" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="54" y="250" fill="#f1f5f9" font-size="12" font-weight="700">Meizu phone framework and shell</text><text x="284" y="250" fill="#e2e8f0" font-size="11">boot · desktop · lock screen · status · app registry</text>
  <text x="54" y="270" fill="#22d3ee" font-size="10">custom image and text caches · phone services · Home behavior · MiniOneShell</text>
  <path d="M380 288 V308" stroke="#475569"/><path d="M380 308 l-5 -8 M380 308 l5 -8" stroke="#475569" fill="none"/>
  <rect x="36" y="312" width="688" height="76" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="54" y="336" fill="#f1f5f9" font-size="12" font-weight="700">Windows CE 6 foundation</text><text x="244" y="336" fill="#e2e8f0" font-size="11">kernel · drivers · GWES · GDI · files · registry · networking</text>
  <text x="54" y="356" fill="#64748b" font-size="10">a configurable embedded OS, not a ready-made capacitive smartphone experience</text>
  <text x="54" y="374" fill="#64748b" font-size="10">Win32 compatibility remains available — which is why the native MessageBox can break through</text>
  <text x="14" y="430" fill="#64748b" font-size="10.5">Each layer is useful. Only the whole stack feels like the product.</text>
</svg>

The visual work was equally physical. EICO took over much of the interaction and interface design. Designer accounts describe a scope stretching from interaction and visuals to packaging and launch material. The engineering oral history remembers an earlier period with too few working prototypes: interface sheets were printed, cut out, and glued onto hardware models so they could be judged at phone scale. More than a thousand paper screens were reportedly used.

The finished graphics still had to survive the M8 display path. Engineers described visible banding in gradients on its 16-bit output and used dithering in the assets to hide it. That is a small detail with a large implication: the glassy, continuous surfaces associated with the iPhone era were not native properties of the platform. They were premeditated illusions encoded into pixels.

Then the pixels had to move.

<svg viewBox="0 0 760 272" width="100%" role="img" aria-label="Historical performance account from Meizu's M8 engineers. Early desktop scrolling ran around 10 to 20 frames per second. Image caching improved it to roughly 17 to 18 frames per second. Adding text caching brought it above the team's 24 frames per second smoothness threshold. The diagram notes these are retrospective engineer recollections rather than PocketJS measurements." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">M8 SHELL SCROLLING · RETROSPECTIVE ENGINEER ACCOUNT</text>
  <rect x="14" y="34" width="732" height="204" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <line x1="200" y1="194" x2="704" y2="194" stroke="#475569"/>
  <g fill="#64748b" font-size="9.5" text-anchor="middle"><text x="200" y="214">0</text><text x="368" y="214">10</text><text x="536" y="214">20</text><text x="704" y="214">30 FPS</text></g>
  <text x="34" y="78" fill="#e2e8f0" font-size="11">early rendering</text><rect x="200" y="60" width="336" height="24" rx="5" fill="#3f1d2e" stroke="#be123c"/><text x="548" y="77" fill="#fda4af" font-size="10.5">10–20</text>
  <text x="34" y="128" fill="#e2e8f0" font-size="11">image cache</text><rect x="200" y="110" width="302" height="24" rx="5" fill="#172554" stroke="#2563eb"/><text x="514" y="127" fill="#93c5fd" font-size="10.5">17–18</text>
  <text x="34" y="178" fill="#e2e8f0" font-size="11">+ text cache</text><rect x="200" y="160" width="420" height="24" rx="5" fill="#14251d" stroke="#65a30d"/><text x="632" y="177" fill="#bef264" font-size="10.5">24+</text>
  <line x1="603" y1="48" x2="603" y2="194" stroke="#a3e635" stroke-dasharray="4 4"/><text x="603" y="46" fill="#a3e635" text-anchor="middle" font-size="9.5">team's smoothness line · 24 FPS</text>
  <text x="14" y="260" fill="#64748b" font-size="10">Source: 2016 interviews with the original team; values are recollections, not a controlled benchmark.</text>
</svg>

The M8's GPU was not carrying the shell to an iPhone-like result. Zhu recalled early desktop scrolling around 10–20 FPS. Caching images raised part of that range to roughly 17–18 FPS. The team then discovered that Windows CE text rendering was also consuming a large share of the frame and added a text cache, finally clearing the 24 FPS line they considered acceptable.

This is where “they copied the iPhone” stops being a sufficient technical explanation. A screenshot can be copied by a designer. A responsive shell requires input dispatch, animation timing, resource lifetime, caching, font rendering, application conventions, recovery behavior, and thousands of small decisions that hold together outside the screenshot.

There were limits. The opening `MessageBoxW` still has tiny controls because native Win32 compatibility remained underneath. Third-party software that used raw CE controls could look like a stylus application accidentally enlarged onto a high-density phone. The new experience was strongest where Meizu owned the whole path: shell, bundled applications, custom libraries, assets, and interaction.

## What our small port learned from their large one

PocketJS took the opposite route from Meizu. Meizu turned Windows CE into a whole phone platform. We brought a self-contained modern UI runtime and asked Windows CE for the smallest possible hosting surface.

That difference explains why the PocketJS host can stay narrow, but the same hardware still taught us some of the same lessons:

- Native resolution is not the same as usable scale.
- A pointer message is not yet a reliable touch interaction.
- A full-screen window is not entitled to outrank the shell; our first topmost window trapped the Home experience until the host stopped claiming system-topmost status.
- A program is not integrated because its executable launches. It needs an identity in `MiniOneShell`, a correct icon, an exit path, and behavior that returns the device to its owner.
- Compatibility APIs preserve old assumptions along with old software. The closer an app stays to those defaults, the more the old desktop leaks through.

Even the icon became a miniature version of that last point. Meizu's shell cached icon paths aggressively enough that replacing the file bytes could leave the old picture visible. The deployment flow had to install the corrected art at a build-qualified path and update the registry entry.

<div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
  <figure class="rounded-xl border border-line bg-slate-950 p-6 text-center">
    <img class="mx-auto h-20 w-20" src="/assets/blog/meizu-m8-icon-player.png" alt="The first incorrect M8 shell icon for PocketJS, a purple rounded-square media player symbol." />
    <figcaption class="mt-3 text-sm text-slate-500"><strong class="text-slate-300">The cached mistake.</strong> A valid shell entry with the wrong product identity.</figcaption>
  </figure>
  <figure class="rounded-xl border border-line bg-slate-950 p-6 text-center">
    <img class="mx-auto h-20 w-20" src="/assets/blog/meizu-m8-icon-pocketjs.png" alt="The corrected PocketJS icon installed in the M8 shell, showing a black and silver handheld mark." />
    <figcaption class="mt-3 text-sm text-slate-500"><strong class="text-slate-300">The repaired identity.</strong> A new path forced the shell to reconsider what it thought it knew.</figcaption>
  </figure>
</div>

For the record, the original session accepted build, deployment, launch, native 480×720 output, touch, Home/Escape exit, and shell registration on one physical M8/M8SE. The final post-review tree was rebuilt and passed all eleven host/build validation stages, but that last binary was not redeployed after the phone stopped enumerating over USB. The screenshots here belong to the earlier device-proven builds and dialog capture. The phone is not connected now, and this rewrite did not manufacture a fresh hardware result.

That evidence boundary matters because nostalgia is already generous enough. We do not need to make the machine more successful than it was to respect what its engineers achieved.

## A salute through the trapdoor

The Meizu M8 was derivative. It was also audacious.

In 2007, a comparatively small Chinese music-player company chose an embedded Windows kernel, negotiated for the pieces it could get, wrote the phone system it did not receive, and tried to meet the interaction standard the first iPhone had just made visible. The team rebuilt a shell that Windows CE never promised them. Designers evaluated printed interfaces on glued-up models. Engineers dithered gradients because the display path showed bands, cached images because scrolling was too slow, then cached text because the first cache was not enough.

They worked in the uncomfortable middle between two eras. Underneath were `HWND`, `WM_PAINT`, GDI, a registry, and OEM-selected components. Above them was a new public expectation: direct manipulation, continuous motion, finger-sized geometry, a coherent full-screen product, and no sight of the computer underneath.

The M8 did not erase Windows CE. The native dialog proves that. What the team accomplished was more difficult and more interesting: **they built a convincing modern interaction model on top of a system that offered mechanisms, not that model.**

Porting PocketJS let us look down through the same trapdoor. We arrived with reactive state, components, flex layout, hit testing, and a retained renderer; Windows CE offered a queue, a callback, a timer, an `HDC`, and a place to put 345,600 finished pixels. The two systems could coexist because the boundary between them was made explicit.

To Zhu Guozhi and the engineers who rebuilt the shell; to the people who chased every frame through image and text caches; to EICO and the designers who turned paper, 16-bit color, and borrowed visual language into a coherent object; and to everyone who kept going while the hardware, tools, and schedule argued back: the PocketJS port was tiny beside what you did, but it made the scale of your work legible.

Respect.

---

*Further reading: Microsoft's documentation on [messages and message queues](https://learn.microsoft.com/en-us/windows/win32/winmsg/about-messages-and-message-queues), the Windows CE [`DispatchMessage`](https://learn.microsoft.com/en-us/previous-versions/ms960205%28v%3Dmsdn.10%29) and [`BeginPaint`](https://learn.microsoft.com/en-us/previous-versions/ms959643%28v%3Dmsdn.10%29) contracts, and the [Windows Embedded CE 6 kernel changes](https://learn.microsoft.com/en-us/archive/msdn-magazine/2006/december/mobilize-explore-the-new-features-in-windows-embedded-ce-6-0) document the platform model. The M8 history and performance recollections come from [interviews with the original team](https://tech.sina.com.cn/mobile/n/n/2016-01-02/doc-ifxneept3520336.shtml); EICO's contribution is also preserved in a [designer's M8 portfolio](https://www.behance.net/gallery/69362417/Meizu-M8) and [contemporary coverage](https://www.engadget.com/2008-05-24-meizu-m8-interface-redesigned-gets-all-sparkly.html). Apple's description of [declarative view hierarchies](https://developer.apple.com/documentation/swiftui/declaring-a-custom-view) and Android's [Compose mental model](https://developer.android.com/develop/ui/compose/mental-model) provide modern points of comparison. PocketJS's M8 host is documented in [`docs/MEIZU_M8.md`](https://github.com/pocket-nexus/pocketjs/blob/main/docs/MEIZU_M8.md), and the port landed in [PR #279](https://github.com/pocket-nexus/pocketjs/pull/279).*
