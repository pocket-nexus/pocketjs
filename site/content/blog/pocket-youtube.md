<video class="w-full rounded-xl border border-line" autoplay muted loop controls playsinline preload="metadata" crossorigin="anonymous" aria-label="Hand-held footage of Pocket YouTube playing a PSP documentary on a real piano-black PSP, with the player HUD, pause and seek">
  <source src="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket-youtube-real-psp-7ae0b36c.mp4" type="video/mp4" />
  <a href="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket-youtube-real-psp-7ae0b36c.mp4">Watch Pocket YouTube running on a real PSP.</a>
</video>

<p class="text-sm text-slate-500 -mt-4">Pocket YouTube on a real PSP — playing, of all things, a documentary about the PSP. Un-mute for the part a screenshot can't prove: the 44.1&nbsp;kHz audio is coming out of the handheld too.</p>

The Sony PSP has WiFi. It is 802.11b, it tops out around 100 KB/s on a good day, and its idea of TLS predates the certificates, the ciphers, and frankly the internet that YouTube lives on. No amount of software on the device will make that radio speak to a 2026 CDN.

But look at the machine sitting next to it. During development, a PSP is tethered to a laptop anyway — [PSPLINK](https://github.com/pspdev/psplinkusb) mounts a directory of your machine as the device's `host0:` drive over USB 2.0. That cable moves about a megabyte per second of file I/O. A megabyte per second is not much by any modern standard, and it is also, if you are careful, *exactly enough to stream video*.

So that became the project: **YouTube on the PSP, where the network is a USB cable.** Search with an on-screen keyboard, browse real results — thumbnails, Chinese titles, view counts — pick one, and watch it, with sound, with pause and seek, on 2004 hardware. A Mac companion process owns everything the PSP cannot do (DNS, TLS, yt-dlp, H.264), and the handheld owns everything it *can*: a 60 Hz UI, a texture, and an audio ring. If you are new here, the device side is [PocketJS](/blog/introducing-pocketjs/) — our runtime that runs real Solid JSX on the PSP — and this app is one more entry in its [growing](/blog/shipping-openstrike/) [family](/blog/pocket-figma/) of proofs, merged as [#113](https://github.com/pocket-nexus/pocketjs/pull/113).

This post is the whole story: a stream container you can `ls`, a 256-color video plane, an audio thread with no allocator, and the three bugs — a GPU race, a leaked hardware channel, a build system that lied — that only a real device would ever have shown us.

## Split the app at the network boundary

The design rule is the same one every project in this family obeys: **the device never parses the world, it only consumes what a build step — here, a live one — has already chewed.** Pocket Figma froze a 22 MB design file into tile pyramids; Pocket YouTube does the same thing to a video, except the "build step" is a Mac process running while you watch.

<svg viewBox="0 0 760 442" width="100%" role="img" aria-label="Architecture: on the Mac, yt-dlp resolves searches and stream URLs, two ffmpeg processes decode video to raw RGB and audio to PCM, a quantizer turns frames into 256-color CLUT8, and a writer publishes into pocket-svc/youtube/ as a JSON-lines mailbox, card images, and a .pkst ring file. The PSPLINK usbhostfs cable mounts that directory as host0:. On the PSP, the PocketJS app polls the mailbox, loads card textures, and a bounded pump feeds the video plane and the audio ring. Caption: the Mac owns the network and the pixels; the PSP owns presentation" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="12" width="332" height="330" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="182" y="38" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">Mac — host/serve.ts</text>
  <text x="182" y="56" fill="#38bdf8" font-size="11" text-anchor="middle">owns DNS · TLS · YouTube · H.264</text>
  <rect x="36" y="72" width="292" height="50" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="182" y="93" fill="#e2e8f0" font-size="12" text-anchor="middle">yt-dlp — search · resolve itag 22/18</text>
  <text x="182" y="111" fill="#64748b" font-size="10.5" text-anchor="middle">one progressive URL, video+audio muxed</text>
  <rect x="36" y="132" width="140" height="64" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="106" y="155" fill="#e2e8f0" font-size="12" text-anchor="middle">ffmpeg ×2</text>
  <text x="106" y="172" fill="#64748b" font-size="10.5" text-anchor="middle">-re · 720p → 512×128</text>
  <text x="106" y="187" fill="#64748b" font-size="10.5" text-anchor="middle">audio → 22.05 kHz s16</text>
  <rect x="188" y="132" width="140" height="64" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="258" y="155" fill="#e2e8f0" font-size="12" text-anchor="middle">quantizer</text>
  <text x="258" y="172" fill="#64748b" font-size="10.5" text-anchor="middle">median cut · 256 colors</text>
  <text x="258" y="187" fill="#64748b" font-size="10.5" text-anchor="middle">Floyd–Steinberg dither</text>
  <rect x="36" y="208" width="292" height="118" rx="8" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="182" y="231" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">pocket-svc/youtube/ — the wire is a directory</text>
  <text x="52" y="255" fill="#94a3b8" font-size="11">out.jsonl / in.jsonl — command mailbox</text>
  <text x="52" y="276" fill="#94a3b8" font-size="11">thumbs/*.img — result rows, pre-rendered</text>
  <text x="52" y="297" fill="#94a3b8" font-size="11">media/play-N.pkst — THE STREAM, one file</text>
  <text x="52" y="316" fill="#22d3ee" font-size="10.5">every message carries the request id it answers</text>
  <path d="M364 262 L414 262" stroke="#475569" stroke-width="1.5"/>
  <path d="M414 262 l-8 -5 M414 262 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="389" y="242" fill="#94a3b8" font-size="10.5" text-anchor="middle">USB 2.0</text>
  <text x="389" y="284" fill="#64748b" font-size="10">usbhostfs</text>
  <text x="389" y="298" fill="#64748b" font-size="10">host0:/</text>
  <rect x="420" y="12" width="324" height="330" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="582" y="38" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">PSP — the PocketJS app</text>
  <text x="582" y="56" fill="#c4b5fd" font-size="11" text-anchor="middle">owns 60 Hz UI · texture · audio ring</text>
  <rect x="440" y="72" width="284" height="50" rx="8" fill="#0e1626" stroke="#2b3a55"/>
  <text x="582" y="93" fill="#e2e8f0" font-size="12" text-anchor="middle">PocketJS app — Solid JSX</text>
  <text x="582" y="111" fill="#64748b" font-size="10.5" text-anchor="middle">search · rows · player HUD · system keyboard</text>
  <rect x="440" y="132" width="284" height="60" rx="8" fill="#0e1626" stroke="#2b3a55"/>
  <text x="582" y="155" fill="#e2e8f0" font-size="12" text-anchor="middle">videoTick() — bounded pump</text>
  <text x="582" y="173" fill="#64748b" font-size="10.5" text-anchor="middle">≤26 KB of file I/O per 60 Hz tick, main thread</text>
  <rect x="440" y="204" width="136" height="66" rx="8" fill="#0e1626" stroke="#2b3a55"/>
  <text x="508" y="227" fill="#e2e8f0" font-size="12" text-anchor="middle">video plane</text>
  <text x="508" y="245" fill="#64748b" font-size="10.5" text-anchor="middle">512×128 CLUT8</text>
  <text x="508" y="260" fill="#64748b" font-size="10.5" text-anchor="middle">one GE texture</text>
  <rect x="588" y="204" width="136" height="66" rx="8" fill="#0e1626" stroke="#2b3a55"/>
  <text x="656" y="227" fill="#e2e8f0" font-size="12" text-anchor="middle">audio thread</text>
  <text x="656" y="245" fill="#64748b" font-size="10.5" text-anchor="middle">44.1 kHz native</text>
  <text x="656" y="260" fill="#64748b" font-size="10.5" text-anchor="middle">2× upsample</text>
  <text x="582" y="300" fill="#94a3b8" font-size="11" text-anchor="middle">no sockets · no decoder · no allocation surprises</text>
  <text x="582" y="320" fill="#64748b" font-size="10.5" text-anchor="middle">the device reads three kinds of files, and that is all</text>
  <text x="380" y="376" fill="#475569" font-size="11" text-anchor="middle">the Mac owns the network and the pixels; the PSP owns presentation</text>
  <text x="380" y="396" fill="#475569" font-size="11" text-anchor="middle">kill the Mac process mid-video and the app shows a frozen frame, not a crash — restart it and the session resumes</text>
</svg>

The mailbox deserves one sentence of respect. It is two append-only JSON-lines files — the device writes `{"t":"search","id":2,"q":"psp"}` into `out.jsonl`, the Mac appends `{"t":"results","id":2,...}` to `in.jsonl` — and it generalizes the transport our [time-travel debugger](/blog/time-travel-devtools/) already proved out. Every reply echoes the request `id`, so the app routes responses without ordering assumptions; every bulk payload (a thumbnail row, the stream itself) travels as a *side file* named in the message. Request/response over `tail -f`, effectively. It is not glamorous. It is inspectable with `cat`, testable with a canned driver, and survives either side restarting — the device detects a truncated mailbox and rewinds its read offset.

Search results are worth a look before we get to video, because they solve a problem PocketJS *cannot* solve on-device: arbitrary text. The PSP build bakes a font atlas of exactly the glyphs the app's source mentions — search results can name any Unicode codepoint in existence. So the Mac renders each result as one **512×64 CLUT8 image**: thumbnail, duration badge, title in any script, channel, view count, all typeset with opentype.js and shipped as a side file. The device shows a texture; it never meets a glyph it doesn't know.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-youtube-results.png" alt="Search results for psp on the PSP: three full-width rows with thumbnails, duration badges, titles, channels and view counts, a red focus ring on the first row, a 1/12 counter" />

<p class="text-sm text-slate-500 -mt-4">Host-rendered rows on the device: titles in any script the PSP's atlas could never bake (CJK included), a duration chip on each thumbnail, rounded corners masked into the pixels — because the GE's scissor is rectangular and cannot round anything.</p>

## A video stream you can ls

There is no socket to stream over, so the stream is a **file with the shape of a ring buffer** — a format we call `.pkst`. The Mac writes it in place, forever; the PSP polls its 96-byte header and chases the tail. The whole thing, for any length of video, is exactly **1,058,144 bytes**:

<svg viewBox="0 0 760 560" width="100%" role="img" aria-label="Byte layout of a .pkst stream file totaling 1,058,144 bytes. A 96-byte header block holds magic PKST, an epoch counter, and two ring descriptors with their latest sequence numbers. The video ring is 8 slots of 66,592 bytes; each slot is a 32-byte header, a 1,024-byte palette of 256 colors, and 65,536 bytes of 512 by 128 8-bit indices. The audio ring is 64 chunks of 8,208 bytes; each chunk is a 16-byte header plus 2,048 stereo frames of signed 16-bit PCM, 92.9 milliseconds each. The writer fills payload first and publishes the sequence number last; the reader re-reads the live sequence after a chunked copy and discards torn frames. Caption: one preallocated file, overwritten forever — a ring buffer that happens to live on a filesystem" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="28" fill="#f1f5f9" font-size="13" font-weight="700">media/play-1.pkst — 1,058,144 bytes, preallocated, overwritten in place</text>
  <rect x="16" y="44" width="188" height="74" rx="8" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="110" y="66" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">header block · 96 B</text>
  <text x="110" y="84" fill="#94a3b8" font-size="10.5" text-anchor="middle">'PKST' · epoch · flags</text>
  <text x="110" y="100" fill="#38bdf8" font-size="10.5" text-anchor="middle">latestSeq × 2 — the clock</text>
  <rect x="212" y="44" width="336" height="74" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="66" fill="#e2e8f0" font-size="12" text-anchor="middle">video ring — 8 slots × 66,592 B</text>
  <text x="380" y="84" fill="#64748b" font-size="10.5" text-anchor="middle">= 532,736 B ≈ 0.66 s at 12 fps</text>
  <text x="380" y="100" fill="#64748b" font-size="10.5" text-anchor="middle">slot = seq % 8</text>
  <rect x="556" y="44" width="188" height="74" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="650" y="66" fill="#e2e8f0" font-size="12" text-anchor="middle">audio ring</text>
  <text x="650" y="84" fill="#64748b" font-size="10.5" text-anchor="middle">64 × 8,208 B = 525,312 B</text>
  <text x="650" y="100" fill="#64748b" font-size="10.5" text-anchor="middle">≈ 5.9 s of PCM</text>
  <path d="M380 118 L380 146" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 146 l-5 -8 M380 146 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="150" width="728" height="128" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="174" fill="#f1f5f9" font-size="12.5" font-weight="700">one video slot — 66,592 bytes, a complete frame with its own palette</text>
  <rect x="36" y="188" width="120" height="30" rx="6" fill="#0e1626" stroke="#38bdf8"/>
  <text x="96" y="207" fill="#e2e8f0" font-size="11" text-anchor="middle">seq · frame idx</text>
  <rect x="162" y="188" width="150" height="30" rx="6" fill="#0e1626" stroke="#22d3ee"/>
  <text x="237" y="207" fill="#e2e8f0" font-size="11" text-anchor="middle">palette · 256 × ABGR</text>
  <rect x="318" y="188" width="406" height="30" rx="6" fill="#0e1626" stroke="#2b3a55"/>
  <text x="521" y="207" fill="#e2e8f0" font-size="11" text-anchor="middle">indices · 512 × 128 × u8 = 65,536 B</text>
  <text x="96" y="238" fill="#64748b" font-size="10">32 B</text>
  <text x="237" y="238" fill="#64748b" font-size="10">1,024 B</text>
  <text x="521" y="238" fill="#64748b" font-size="10">one byte per texel — the GE dereferences the palette in hardware</text>
  <text x="36" y="264" fill="#22d3ee" font-size="10.5">the palette rides INSIDE the frame: every frame brings its own 256 colors</text>
  <path d="M380 278 L380 306" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 306 l-5 -8 M380 306 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="310" width="728" height="120" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="334" fill="#f1f5f9" font-size="12.5" font-weight="700">the ordering contract — lock-free across a USB cable</text>
  <text x="36" y="360" fill="#94a3b8" font-size="11.5">writer:&#160;&#160;payload first → publish latestSeq LAST&#160;&#160;&#160;(a reader can never see a seq it can't safely read)</text>
  <text x="36" y="382" fill="#94a3b8" font-size="11.5">reader:&#160;&#160;copy slot in ≤26 KB installments → re-read the LIVE seq → discard if the writer lapped us</text>
  <text x="36" y="404" fill="#94a3b8" font-size="11.5">seek:&#160;&#160;&#160;&#160;writer bumps epoch → reader drops every cursor and rejoins at the tail</text>
  <text x="36" y="422" fill="#64748b" font-size="10.5">no locks, no fsync choreography — just publication order and a generation counter</text>
  <text x="380" y="456" fill="#475569" font-size="11" text-anchor="middle">one preallocated file, overwritten forever — a ring buffer that happens to live on a filesystem</text>
  <rect x="16" y="476" width="728" height="64" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="36" y="500" fill="#e2e8f0" font-size="11.5">the same trick handles pause and seek: pause is SIGSTOP on ffmpeg (the rings freeze), seek kills and respawns it at the</text>
  <text x="36" y="518" fill="#e2e8f0" font-size="11.5">new offset with an epoch bump — the device notices, flushes its audio queue, and chases the new tail. Play state is</text>
  <text x="36" y="534" fill="#e2e8f0" font-size="11.5">wherever the writer's cursor is. There is no play clock to keep — the tail IS the clock.</text>
</svg>

This is the part of the design I would defend in any architecture review: **there is no protocol state machine because the file is the state.** The PSP crashes? Reconnect and read the header. The Mac restarts? It truncates the mailbox, the device notices its read offset is past EOF and rewinds. You want to debug the stream? Point a 30-line script at the file and check that `latestSeq` grows at 12 per second — we did exactly that, from a laptop, to prove a "broken" resume was actually working (the bug was elsewhere; more below).

## 256 colors, twelve times a second

Now the graphics part, and a short detour for anyone who has never met a fixed-function GPU.

The PSP's GPU — the GE — has no shaders and no YUV path we can feed from a file, but it has excellent support for **palettized textures**: a texture where each texel is one byte, an index into a 256-entry color table (a CLUT) that the hardware dereferences while sampling. For video over a skinny pipe this is a gift. An RGB frame at 512×128 would be 196 KB; as indices it is 64 KB plus a 1 KB palette — and the *decode* on the device is nothing at all, because the GPU does the lookup in silicon.

The catch is that 256 colors is not many for a movie frame, and this is where the Mac earns its keep, per frame, at 12 fps:

- **Median-cut quantization** picks the 256 colors that partition *this frame's* actual pixel population — and the palette entries are the true means of each partition, not the centers of the boxes. That last clause matters: we first shipped box centers, and the dither (below) amplified the systematic bias into visible speckle on flat areas.
- **Serpentine Floyd–Steinberg dithering** distributes each pixel's rounding error onto its unvisited neighbors, alternating scan direction per row. This is why 256 colors can impersonate a sunset: your eye integrates the error pattern back into the gradient.
- **The palette rides inside the frame.** Scene cuts change everything; a global palette would smear. Every slot is self-contained — which will come back to haunt us in the GPU-race section, because *two frames of the same scene can carry wildly different palettes*: median cut is deterministic, but the order boxes split in — and therefore which index means which color — reshuffles with tiny input changes.

The plane itself is **512×128 texels stretched to the 480×272 screen** — the GE wants power-of-two dimensions, and this is the sweet spot: horizontally it is nearly 1:1 (each texel 0.94 screen pixels wide, where sharpness actually lives), vertically it is a 2.13× stretch that bilinear filtering hides in motion. The source is YouTube's 720p progressive stream when available, Lanczos-downscaled — so every texel is earned.

Anamorphic texels have one sharp edge, and we cut ourselves on it. If you letterbox a 16:9 video into the *texture's* 4:1 box — the obvious ffmpeg one-liner — you get this:

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-youtube-pillarbox-bug.png" alt="A video playing in a narrow pillarboxed strip in the center of the PSP screen, with wide black bars left and right" />

<p class="text-sm text-slate-500 -mt-4">The bug, preserved: aspect-ratio math done in texture space instead of screen space. The frame is "correctly" letterboxed into 512×128 — and the anamorphic stretch then squeezes it into a 213-pixel strip.</p>

The letterbox has to be computed in *screen* space — where will these pixels land after the stretch? — and mapped back into texels. Fifteen lines of arithmetic, one honest screenshot of the failure, and a lesson that generalizes: **when your texture and your screen disagree about pixel shape, every "obvious" size computation is wrong in exactly one coordinate system.**

## The 26-kilobyte tick

Streaming on the device is one function, `videoTick()`, called once per 60 Hz frame on the main thread — the same thread that runs your JSX. It is allowed at most **26 KB of file I/O per tick**, and the entire real-time behavior of the app falls out of how that budget is spent:

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="The per-tick I/O budget: every 16.6 millisecond tick spends up to 26 kilobytes on the USB cable. First a 96-byte header poll, then up to two 8,208-byte audio chunks if the RAM ring has room, then the remainder goes to the video slot copy, which takes three ticks to move one 66,592-byte frame. Below, a timeline of five ticks shows a video frame assembled across ticks one to three while audio tops up, and the budget arithmetic: video needs 780 KB/s, audio 88 KB/s, the ceiling is 26 KB times 60 equals 1.56 MB/s, leaving 1.8x headroom. Caption: audio first, because a dropped frame is invisible and a dropped audio block is a click" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="28" fill="#f1f5f9" font-size="13" font-weight="700">one tick = 16.6 ms = ≤26 KB on the cable, spent in priority order</text>
  <rect x="16" y="44" width="92" height="56" rx="8" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="62" y="68" fill="#e2e8f0" font-size="11.5" text-anchor="middle">header</text>
  <text x="62" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">96 B poll</text>
  <rect x="116" y="44" width="200" height="56" rx="8" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="216" y="68" fill="#e2e8f0" font-size="11.5" text-anchor="middle">audio — up to 2 chunks</text>
  <text x="216" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">2 × 8,208 B, if the ring has room</text>
  <rect x="324" y="44" width="420" height="56" rx="8" fill="#0e1626" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="534" y="68" fill="#e2e8f0" font-size="11.5" text-anchor="middle">video — whatever is left</text>
  <text x="534" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">a 66,592 B slot arrives in ~3 installments</text>
  <text x="16" y="136" fill="#94a3b8" font-size="11.5">tick</text>
  <g>
    <rect x="60" y="118" width="130" height="26" rx="5" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="125" y="135" fill="#94a3b8" font-size="10.5" text-anchor="middle">1 · hdr + audio + ⅓ frame</text>
    <rect x="196" y="118" width="130" height="26" rx="5" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="261" y="135" fill="#94a3b8" font-size="10.5" text-anchor="middle">2 · hdr + ⅓ frame</text>
    <rect x="332" y="118" width="130" height="26" rx="5" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="397" y="135" fill="#94a3b8" font-size="10.5" text-anchor="middle">3 · last ⅓ → validate</text>
    <rect x="468" y="118" width="130" height="26" rx="5" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
    <text x="533" y="135" fill="#22d3ee" font-size="10.5" text-anchor="middle">4 · PRESENT (GE idle)</text>
    <rect x="604" y="118" width="130" height="26" rx="5" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="669" y="135" fill="#94a3b8" font-size="10.5" text-anchor="middle">5 · next frame begins…</text>
  </g>
  <rect x="16" y="170" width="728" height="108" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="196" fill="#f1f5f9" font-size="12" font-weight="700">the arithmetic that makes it work</text>
  <text x="36" y="222" fill="#94a3b8" font-size="11.5">video&#160;&#160;&#160;66,592 B × 12 fps ≈ 780 KB/s&#160;&#160;&#160;&#160;&#160;&#160;audio&#160;&#160;&#160;22,050 Hz × 4 B ≈ 88 KB/s&#160;&#160;&#160;&#160;&#160;&#160;total ≈ 0.87 MB/s</text>
  <text x="36" y="246" fill="#94a3b8" font-size="11.5">budget ceiling&#160;&#160;&#160;26 KB × 60 Hz = 1.56 MB/s&#160;&#160;→&#160;&#160;1.8× headroom over steady state, burst room for catch-up</text>
  <text x="36" y="266" fill="#64748b" font-size="10.5">every byte moves on the main thread — the audio thread never touches the USB pipe (one pipe, one owner)</text>
  <text x="380" y="306" fill="#475569" font-size="11" text-anchor="middle">audio first, because a dropped video frame is invisible and a dropped audio block is a click</text>
</svg>

Note what is absent: threads fighting over the cable, a streaming heuristic, adaptive anything. The reader chases `latestSeq`; if USB stalls, it presents the last good frame and catches up by *skipping to the tail*, not by replaying the past. The 60 Hz UI never hitches, because the pump cannot exceed its budget by construction. When we doubled the plane to 512-wide, the entire "will it keep up?" question reduced to the arithmetic in that diagram — and one measurement on hardware: play a video, sample the HUD clock twice over ten wall seconds, confirm it advanced ten seconds. It did.

## Audio is a thread with no allocator

Audio on the PSP is beautifully primitive: you reserve a hardware channel, and a thread hands the kernel 1,024-frame PCM blocks; each call blocks until the hardware drains. Our audio thread is ~40 lines of `no_std` Rust around a single-producer single-consumer ring in plain RAM — `videoTick` pushes source-rate PCM in from the file, the thread pulls blocks out. No allocator, no locks; two atomic cursors with acquire/release ordering.

It fought us anyway, three times, in escalating order of subtlety:

1. **The channel leak.** Releasing the hardware channel from the audio thread itself failed persistently — release reports "busy" while the final blocks drain, and (we believe, though the firmware isn't saying) it also cares *which thread* asks. The failure was silent, and the symptom was maddening: audio worked for exactly one video per boot. Every later `reserve` failed against the leaked channel. The fix is a rule worth engraving: **the thread that reserves the channel releases the channel**, with retries across the drain, and the worker thread only signals and self-deletes.
2. **The sizzle.** With the leak fixed, playback carried a constant fizz under the music. Two suspects were executed together: the PSP's SRC (sample-rate-converter) channel — the "hardware will resample your 22.05 kHz" path, a known quirk pit on real units — and a missing data-cache writeback on the output buffer. We moved to a **normal channel at the PSP's native 44.1 kHz**, doing the 2× upsample ourselves (linear interpolation, carrying the last frame across block boundaries), and flush the dcache before every submit, because the hardware DMAs the buffer and cached lines are *your* problem on this machine. There is no memory-coherent bus fairy in 2004.
3. **The clock.** There is no A/V sync algorithm. Audio joins one chunk behind the writer's tail, video chases the newest slot, and both rings are shallow enough (0.7 s and 5.9 s) that they cannot drift apart meaningfully before the next seek or pause resets them both. Sync by construction, not by correction.

That SIGSTOP pause trick from the ring diagram also had a beautiful failure worth confessing: *resume* originally sent SIGCONT — and the picture leapt forward by the length of the pause, because ffmpeg's `-re` real-time pacer keeps counting wall clock while the process is frozen, then sprints to catch up. Resume is now "seek to where you stopped." The OS was technically doing exactly what we asked.

## The race you can only lose on real silicon

Here is the best bug of the project. When we doubled the plane to 512×128, playback grew **flickering full-screen noise — except for a clean band at the top of the screen.** Colors, not tearing: random confetti, changing every frame, over an otherwise perfectly advancing video. In the emulator: nothing. In the deterministic sim: nothing. Only the hardware.

The clean band was the confession. PocketJS's render loop is pipelined the way every PSP engine's is:

<svg viewBox="0 0 760 388" width="100%" role="img" aria-label="Two-row timeline of the pipelined render loop. The CPU row runs frame N's JavaScript, including videoTick, then syncs and kicks the display list. The GE row executes frame N minus one's list at the same time, rasterizing the video plane top to bottom. A red hatched region marks videoTick updating the texture in place while the GE is still sampling it: everything the GE rasterizes after that point reads frame N's indices through frame N minus one's palette, rendering color noise below the raster line and leaving the already-drawn top band clean. The fix moves the texture commit to the gap between sceGuSync and the next list kick, marked as the only GE-idle window. Caption: same scene, similar colors, totally reshuffled palette order — any tear is full-color noise" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="28" fill="#f1f5f9" font-size="13" font-weight="700">the pipelined frame — CPU and GPU are never working on the same frame</text>
  <text x="16" y="66" fill="#94a3b8" font-size="11.5">CPU</text>
  <rect x="60" y="48" width="300" height="30" rx="6" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="210" y="67" fill="#e2e8f0" font-size="11" text-anchor="middle">frame N JS — videoTick · layout · draw list</text>
  <rect x="366" y="48" width="70" height="30" rx="6" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="401" y="67" fill="#22d3ee" font-size="10.5" text-anchor="middle">sync·swap</text>
  <rect x="442" y="48" width="302" height="30" rx="6" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="593" y="67" fill="#e2e8f0" font-size="11" text-anchor="middle">frame N+1 JS …</text>
  <text x="16" y="120" fill="#94a3b8" font-size="11.5">GE</text>
  <rect x="60" y="102" width="376" height="30" rx="6" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="248" y="121" fill="#c4b5fd" font-size="11" text-anchor="middle">executing frame N−1's list — rasterizing the plane top → bottom</text>
  <rect x="442" y="102" width="302" height="30" rx="6" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="593" y="121" fill="#c4b5fd" font-size="11" text-anchor="middle">executing frame N's list</text>
  <rect x="120" y="44" width="150" height="94" fill="none" stroke="#eab308" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="195" y="160" fill="#eab308" font-size="10.5" text-anchor="middle">videoTick overwrites the texture</text>
  <text x="195" y="175" fill="#eab308" font-size="10.5" text-anchor="middle">the GE is STILL SAMPLING IT</text>
  <path d="M401 78 L401 98" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="401" y="198" fill="#22d3ee" font-size="10.5" text-anchor="middle">▲ the only safe window: after sceGuSync, before the next list — vid::present() lives here now</text>
  <rect x="16" y="220" width="728" height="118" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="246" fill="#f1f5f9" font-size="12" font-weight="700">why noise and not a mild tear: the palette reshuffles every frame</text>
  <text x="36" y="272" fill="#94a3b8" font-size="11.5">frame N−1:&#160;&#160;index 37 → sky blue&#160;&#160;&#160;index 118 → skin tone&#160;&#160;&#160;index 201 → asphalt</text>
  <text x="36" y="294" fill="#94a3b8" font-size="11.5">frame N:&#160;&#160;&#160;&#160;index 37 → brake-light red&#160;&#160;&#160;index 118 → asphalt&#160;&#160;&#160;index 201 → sky blue</text>
  <text x="36" y="318" fill="#64748b" font-size="10.5">median cut is deterministic, but WHICH index means WHICH color depends on split order — near-identical frames, shuffled tables.</text>
  <text x="36" y="332" fill="#64748b" font-size="10.5">sample new indices through the old CLUT and every pixel below the raster line is a random draw. The top band was already drawn.</text>
  <text x="380" y="368" fill="#475569" font-size="11" text-anchor="middle">the emulator executes the list synchronously — this race is unrepresentable there. The clean band was the GPU's raster position, photographed.</text>
</svg>

The fix costs nothing: `videoTick` now only *stages and validates* a frame; the actual texture write happens in `vid::present()`, called by the render loop in the gap between `sceGuSync` (GE provably idle) and kicking the next list. One staged frame, at most one 60 Hz tick of extra latency on a 12 fps stream, and the race is not "unlikely" — it is structurally impossible.

I want to be honest about how it was found, because the method matters more than the fix. We could not see the flicker (this device is driven from a terminal, an ocean of abstraction away from its screen). The report was human: *"constant noise, but the top ~50 pixels are clean."* Fifty screen pixels is 24 texel rows. From there it is not debugging, it is geometry — what writes a texture from the top and had time to finish 24 rows? The previous frame's rasterizer. Users make excellent oscilloscopes if you take their words literally.

## The build that lied

One more war story, and the most embarrassing one, because the bug wasn't in the product — it was in our *belief system*.

Halfway through hardware bring-up, fixes stopped fixing. Audio repairs that were provably correct changed nothing on the device. The eventual `strings` one-liner is now burned into the project's memory: the PRX on the device **did not contain the new code**. Our `build.rs` embedded the app bundle via `include_str!` — but declared no `rerun-if-changed` for it, so a JS-only rebuild relinked a fresh executable around a *stale* embedded bundle. The build reported success. The deploy reported success. The device ran last week.

It got better: the stale embed had been *masking a compile error* in one of the "shipped" fixes. We had verified, on hardware, with screenshots, code that had never compiled.

Two lines of `cargo:rerun-if-changed` fixed the mechanism. The lesson fixed the methodology: **process evidence lies; artifact evidence doesn't.** Every hardware verdict since starts with `strings pocketjs-psp.prx | grep <a literal only the new code contains>`. Trust the binary, not the build log.

## What the framework paid back

Everything above is systems plumbing. Here is why doing it *inside PocketJS* was the point.

**Text entry became a framework capability, not app furniture.** This project needed a real keyboard, so the PSP's on-screen keyboard got promoted into `@pocketjs/framework/osk`: an LVGL-style variable-width key grid — three layers, 40 keys in the letters layer — with the editing session (buffer, caret) in a controller and *input adapters per platform*: d-pad spatial navigation on PSP, front-panel touch on Vita, the virtual cursor wherever it's enabled. While open it is modal — it pushes a focus scope and a button-handler block, so an app cannot freeze itself behind an invisible keyboard by forgetting a guard (we know, because an earlier app-local keyboard did exactly that). Adopting it in an app is one `createOsk()` and one `<Osk/>`:

```tsx
const osk = createOsk({ value: query, setValue: setQuery, onCommit: () => search() });
onButtonPress(BTN.TRIANGLE, () => osk.open());
// …
<Osk osk={osk} />   // docked, modal, themed; d-pad / touch / cursor all wired
```

<img class="rounded-xl border border-line" width="480" src="/assets/blog/pocket-youtube-osk.png" alt="The system keyboard open on the PSP with psp typed into the search field and the caret visible, focus on the p key" />

<p class="text-sm text-slate-500 -mt-4">The system OSK — the same component any PocketJS app now gets. The layout math that renders these variable-width keys is the same math the d-pad navigation and the touch hit-testing consume, so they can never disagree.</p>

**The sim typed on this keyboard before the keyboard existed on hardware.** PocketJS is [deterministic to the byte](/blog/ui-runtime-that-cant-flake/), so the app's test suite is nine scripted journeys: boot a world, feed it a canned host driver, press virtual buttons, assert on the component tree and the command stream. The keyboard journeys don't even hard-code button sequences — they run BFS over the *actual key layout* to derive the d-pad path to each letter, so a layout tweak re-derives every test. One journey types by touch, end to end, on a PSP app, in CI, in about four seconds.

**The device became scriptable the way a browser is.** The same DevTools channel that powers [time travel](/blog/time-travel-devtools/) gave this project its hands and eyes: replay tapes inject button masks, screenshots come back over the cable, the component tree answers queries — *while a human also holds the device*. Ten of the eleven bugs this project logged were found and verified through that loop, from a terminal. The one that wasn't — the flicker — was found by a human eye and *localized* through it. This whole journey was "filmed" that way, no hands involved:

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-youtube-journey.gif" alt="Pocket YouTube on a real PSP: the search keyboard opens, types psp, results arrive as full-width rows with thumbnails, durations and view counts, a row is selected, and a video plays full screen, pauses under a centered badge, and resumes" />

<p class="text-sm text-slate-500 -mt-4">One search-to-playback journey, every frame the device's own framebuffer: a replay tape presses the buttons, the DevTools channel takes the pictures, the same USB cable carries both — and the video stream.</p>

The scorecard for the whole feature: **8 new host ops** (the mailbox and the video plane), one `no_std` ring-parser module shared by test and target, **9 sim journeys, 12 host-pipeline tests, 11 keyboard-geometry tests, 77 Rust core tests** — and a bundle that is still, in the end, one Solid component tree that any web developer could read.

## The numbers

- **1 USB cable** — no WiFi, no sockets, no network stack on the device
- **1,058,144 bytes** — one preallocated ring file per stream, any video length
- **512×128 CLUT8** plane at **12 fps**, quantized per-frame from YouTube's 720p stream
- **~0.87 MB/s** steady state on the cable, under a **26 KB per-tick** budget with 1.8× headroom
- **44.1 kHz** stereo out of a 40-line audio thread, 2× software upsample, zero allocations
- **60 Hz** UI throughout — search, scroll, on-screen keyboard, HUD, never blocked by the stream
- **11 bugs** found on real hardware; **0** found by the emulator; the sim caught everything it structurally could
- **1** framework keyboard now shared by every PocketJS app on PSP and Vita

## What's next

The honest ceiling of this design is the pipe: raw palettized frames cost what they cost. But the PSP has a hardware H.264 decoder — the Media Engine — sitting one undocumented interface away. Move decode onto the device and the cable carries compressed video instead of pixels: an order of magnitude less bandwidth, which buys 480×272 at full frame rate. That is the next mountain, and the streaming architecture above was deliberately built so that only the *payload* of the ring changes when we climb it.

And because the host pipeline is just "ffmpeg into a ring file," there is a one-afternoon spin-off we keep grinning about: point it at screen capture instead of a YouTube URL, and the PSP becomes a wired second monitor. A 2004 handheld as a Mac status display, over the same cable it charges from.

The device never parses the world. It just plays whatever the world writes into one small, honest file.

---

*Pocket YouTube is open source at [pocket-nexus/pocket-youtube](https://github.com/pocket-nexus/pocket-youtube), host service included — a PSP, a USB cable, and `bun run serve` away. Follow [@pocket_js](https://x.com/pocket_js) for what the Media Engine says back.*
