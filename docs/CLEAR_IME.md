# Clear IME and USB companions

Clear supports **application text composition** on the iPod touch 4 and Moto G Play 2024. This is a PocketJS editor API, not an iOS system keyboard extension or Android `InputMethodService`.

## Ownership

| Example | Device owns | Companion owns |
| --- | --- | --- |
| Pocket Doc | Page selection, scrolling, resource handles | Library files, document processing, text coverage |
| Pocket Map | Viewport, gestures, resource lifetime | Map requests, tile processing, resource responses |
| Pocket Term | Terminal view, input, bounded coverage uploads | A supervisor and authenticated daemon own PTYs; transport workers can reconnect |
| Clear IME | Keyboard, composition transcript, editor revision, committed text, textures | Rime process, dictionaries, conversion, CJK rasterization |

The inspected source revisions are [Pocket Doc `host/serve.ts`](https://github.com/pocket-stack/pocket-doc/blob/b3a0d72a377226ef01ed95c3162eb83c91024805/host/serve.ts), [Pocket Map `host/serve.ts`](https://github.com/pocket-stack/pocket-map/blob/457a33568a96bc44c24c4f7a7cc55cd2d2cba592/host/serve.ts), and [Pocket Term `host/serve.ts`](https://github.com/pocket-stack/pocket-term/blob/34f27c816ac1903ed3d53b08f8f81f5ec2ec43b4/host/serve.ts), alongside PocketJS `tools/companion-session.ts`, `tools/offload-provider.ts`, and `framework/src/offload.ts`.

**The render thread never opens the companion socket or reads a dictionary.** `hosts/shared/offload_posix.c` owns a pthread, loopback listener, key-file reads, socket authentication and transfers. The guest submits and drains fixed-capacity queues. Each record has a connection generation; a later connection cannot consume a previous connection's response. The 3DS and POSIX hosts share the queue and coverage decoder.

The v1 offload contract bounds records to **4,096 bytes**, pending requests to **8**, accepted submissions to **2 per frame**, deliveries to **1 per frame**, and coverage uploads to **1 per frame**. These are bounded handoffs; network or provider latency can delay candidates. No network latency guarantee follows from the frame budgets.

`tools/ime/serve.ts` owns one native Rime process and an authenticated loopback HTTP endpoint. A per-connection Worker exposes allowlisted methods:

- `ime.compose`: evaluate a transcript of at most 128 key actions; return preedit, UTF-16 caret position, raw ASCII input and its caret, cumulative commit, page state and at most five candidates.
- `ime.candidates`: read a window of at most 15 candidates without changing the composition transcript. The guest retains at most 512 candidates and fences windows by revision.
- `text.font` and `text.glyph`: identify the font rendition and return reusable scalar glyph metrics and coverage. The framework owns the cache and uploads. `text.tile` remains available for older guests.

**Rime evaluates each transcript in a fresh session with user learning disabled.** Replaying the same input therefore avoids repeated dictionary mutations. The guest fences replies by composition revision, retains its transcript during disconnection and applies the new suffix of the cumulative commit once. **Confirmation seals an input segment.** Later typing enters a new segment; a single compose request serves the queue head. Replies can finish a sealed prefix while its suffix changes. Every confirmed segment retains its own 400 ms deadline, and the queue shares a 128-action budget. Reconnection replays the head before advancing to the next segment. Committed-text deletion and caret actions at a sealed boundary wait in the same queue and reach the editor through the `edit` callback; they cannot overtake conversion. **Raw input remains editable on the device.** A validated reply refreshes raw input after conversion or a partial commit; generated preedit spacing never becomes source text. Closing or cancelling the editor rejects pending commits. This replay policy belongs to IME; it does not change the transport's no-replay policy for sent mutations such as terminal input.

The native API comes from [librime](https://github.com/rime/librime/blob/master/src/rime_api.h). `tools/ime/setup.ts` pins the Luna Pinyin, Prelude and Essay dictionary revisions. Schema compilation, dictionary storage, OpenCC and system CJK font access stay on the Mac. System fonts and dictionary artifacts are not packaged into the applications.

An editor creates one client and advances it from its frame callback. For a Solid application, API ownership is:

```ts
import { createIme, IME } from "@pocketjs/framework/ime";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { onCleanup } from "solid-js";

const ime = createIme({ changed: renderComposition, commit: insertAtCaret });
onFrame(() => ime.step());
onCleanup(() => ime.dispose());
// Keyboard handlers call ime.key(code), ime.key(IME.backspace),
// ime.select(pageRelativeIndex), ime.accept(), ime.commitRaw(), or ime.reset().
```

`renderComposition` receives pending/connected/error state alongside the snapshot. `insertAtCaret` receives committed text. The application supplies both callbacks and owns its text model. `accept()` selects candidates when available, with a 400 ms virtual-time deadline for confirmation. Disconnection, provider error or deadline expiry commits raw input through the same callback. `commitRaw()` ends the transaction and cancels its requests before delivering text. A mode change uses this operation; cancellation uses `reset()`. Local commits cannot replay after reconnection.

## Setup on this Mac

Install Bun, the repository dependencies, Homebrew `librime`, and the platform tools described below. Then run:

```sh
bun install --frozen-lockfile
brew install librime
bun ime:setup
bun tools/ime/verify.ts
```

`ime:setup` writes generated data to ignored `.pocket/ime/`. Apple Silicon Homebrew defaults to `/opt/homebrew`; `POCKETJS_RIME_PREFIX` selects another prefix. The companion uses `/System/Library/Fonts/STHeiti Medium.ttc`; direct `tools/ime/serve.ts --font=<path>` selects another installed CJK font.

## iPod touch 4

Follow [IPODTOUCH4.md](IPODTOUCH4.md) for the pinned iOS 6 toolchain, SSH and User-app installation prerequisites. This path requires the prepared device's existing jailbreak and AppSync. Select its exact USB identifier:

```sh
export POCKETJS_IPODTOUCH4_UDID=<idevice_id output>
bun ipodtouch4 doctor
bun ipodtouch4 deploy
bun ipodtouch4 launch
bun clear:companion ipodtouch4 --id="$POCKETJS_IPODTOUCH4_UDID"
```

The companion command verifies `iPod4,1`, opens USB forwards for SSH and port 8741, finds the installed Clear User-app container, provisions `Documents/offload.key`, verifies its readback and starts the provider. It uses the SSH host identity established by the iPod preparation workflow. Clear retains its native **320×480 logical / 640×960 physical** viewport.

In a second terminal:

```sh
bun ipodtouch4 status
bun ipodtouch4 capture
```

## Moto G Play 2024

The tested device is `fogona`, Android 14, with a **720×1600 physical** display. The host uses arm64, GLES2, QuickJS-C, the shared Rust renderer, native multi-touch and a **360×800 logical** viewport. **Platform pointer IDs and guest contact IDs have separate lifetimes.** The native latch holds at most eight contacts, assigns a guest ID at each down edge, and reserves IDs still present in the previous snapshot. An up followed by a reused pointer ID creates a new contact. Ordinary taps between frames latch one down sample; cancellation removes an unsampled contact without a synthetic press. Pause cancellation clears all contacts. Clear's keyboard follows the viewport width; gestures continue through the shared input contracts.

Install Android command-line tools, Java 17 and Rust. Enable USB debugging and authorize this Mac on the device. The default SDK is `/opt/homebrew/share/android-commandlinetools`; `POCKETJS_ANDROID_SDK_ROOT` selects another location. `JAVA_HOME` selects Java 17. The setup command installs platform 34, build tools 35.0.0, NDK 27.1.12297006, the pinned QuickJS revision and the Rust target. Install the pinned Rust toolchain before setup:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal
adb devices -l
bun moto-g-play setup
bun moto-g-play doctor
bun moto-g-play build
bun moto-g-play deploy --id=<adb serial>
bun moto-g-play launch --id=<adb serial>
bun clear:companion moto-g-play --id=<adb serial>
```

The device commands reject a different model. Deployment installs `dev.pocket_stack.clear` and verifies the installed APK SHA-256 against the local build. The development APK permits `run-as`, which writes the key to the app's private files directory. This package targets Android 14 and keeps the signing key in the local toolchain cache for replacement installs.

```sh
bun moto-g-play status --id=<adb serial>
bun moto-g-play capture --id=<adb serial>
```

For service lifetime across terminal exits and Mac logins, install one user LaunchAgent per target:

```sh
bun clear:companion ipodtouch4 --id=<iPod UDID> --service
bun clear:companion moto-g-play --id=<adb serial> --service
```

**The supervisor reconciles USB state every two seconds.** It recreates a lost ADB forward, restarts a stopped iPod tunnel or provider process, and checks the selected app's pairing key after reconnection and at 30-second intervals. A missing device or installation leaves the supervisor waiting. A process-owned loopback lease on port 18742 or 28742 rejects duplicate supervisors. Each command has a six-second deadline, and reconciliations do not overlap. The socket transport reconnects after the USB route returns. A local port owned by another device is rejected.

LaunchAgents are named `dev.pocket-stack.clear-companion.<target>` and reference the current checkout and Bun executable. Logs stay in ignored `.pocket/ime/services/`. Keep that checkout available while the services run. To stop and uninstall one, replace `<target>` below with `ipodtouch4` or `moto-g-play`:

```sh
launchctl bootout gui/$(id -u)/dev.pocket-stack.clear-companion.<target>
rm ~/Library/LaunchAgents/dev.pocket-stack.clear-companion.<target>.plist
```

The two companions can run at the same time: Mac ports 18741 and 28741 forward to each device's loopback port 8741. Each device has its own 256-bit key in a mode-0600 ignored file. Pairing receipts contain a fingerprint, never the key. Stopping a companion leaves local scrolling and editing available. Restoring it resumes a composition that has not been committed or cancelled. Offline confirmation inserts raw pinyin; dictionary conversion requires the Mac to return.

## Editing

Tap a list, then a row. In PY mode, type pinyin and tap a candidate. Space or Return selects the first candidate; Return after composition closes the editor. The downward arrow expands a scrollable candidate panel over the keyboard; the upward arrow collapses it. Dragging scrolls with inertia, while tapping selects a candidate. Long candidates continue across lines. Tap the left or right half of the preedit to move its caret. The plain cross cancels composition. **The cross and disclosure have 44-point touch targets and appear only during PY composition.** The globe changes between PY and EN; numbers, symbols, shift and committed-text deletion remain available.

**The permanent candidate bar is 44 points high.** It holds three candidates and the two composition controls. Space displays `拼音` or `EN`. During composition, a 12-point preedit label sits at the left above the candidate bar, separated by four points. Its 20-point box follows the measured text width, with a viewport-width cap. The editor adjusts its lift when this label appears or disappears. The expanded panel continues after the three inline candidates; if an inline phrase needs more width, the panel includes it with wrapping. Key rows have six points of vertical spacing and retain their 40-point cap height.

**Space has a 200 ms virtual-time hold threshold.** The cap stays pressed from touch-down through trackpad activation, then returns to its resting colors on release or cancellation. A short tap uses the same held state until release. The trackpad indicator is a recessed slot with a bevelled grip. Horizontal movement advances one Unicode code point per 10 logical pixels; a 2-pixel hysteresis band prevents direction changes from finger jitter. The grip uses fixed shading during dragging. During composition the same gesture moves the Rime preedit caret. Releasing Space exits without inserting a space; a short tap inserts a space or selects the first candidate. A second key pressed before a short Space releases preserves input order.

**Composition caret steps clamp to the raw input bounds.** The companion implements Left and Right through Rime's `get_caret_pos` and `set_caret_pos`, moving one UTF-8 character boundary per action. Schema navigation keys can move by syllable or wrap at a segment boundary; the trackpad does not call that navigator. The returned caret remains a UTF-16 offset in the formatted preedit, whose added syllable spaces are presentation text. Revision checks prevent delayed replies from replacing a newer position.

**The expanded candidate panel culls the covered keyboard subtree.** Its opacity becomes zero while its editor and key state remain mounted. Inactive key layers also have zero opacity. The shared renderer skips these subtrees before emitting draw commands; collapsing the panel restores the active layer.

**Scrolling retains the mounted slots of candidates that remain visible.** Departing cells supply slots for entering rows. Content and the scrollbar use draw transforms; scrolling within a row does not change layout offsets. Shared text resources invalidate readers of the changed glyph and rebuild demand plans when the working set changes. See [the text resource mechanism](TEXT_RESOURCES.md).

**Backspace deletes on press, then repeats after 430 ms.** Repeats are 85 ms apart and accelerate to 50 ms after two seconds. Release, cancellation, leaving the held key or closing the editor stops repeat. Deadlines use the PocketJS virtual clock; processing a delayed frame emits at most two repeats. The key popup remains opaque for at least 240 ms from press and 140 ms from release, then fades over 120 ms. A held character keeps its popup until release.

Keyboard icons are authored filled SVG contours in `apps/clear/`. The globe uses a circular outline, curved meridians and latitude lines, with the iOS 6 [iPod touch user guide, page 127](https://cdsassets.apple.com/live/6GJYWVAV/user/ma1657_ipod_touch_ios6_user_guide.pdf) as a shape reference. They are baked at native density with supersampled coverage. **`images.json` enables bilinear sampling for all five active icons**, preserving edge coverage when a 32-point asset is displayed at 24–26 points. The shared renderer uses density-scaled masks for small rounded gradients; the center uses clipped gradient quads with the same stops. Mask and center commands form separate batches, with no per-row texture switches.

**Pending conversion uses a low-contrast skeleton.** It starts after 80 ms of virtual time, fades in over 180 ms, then breathes between opacity 0.42 and 0.58 over a 1.8-second cycle. The last confirmed preedit stays visible without an appended ellipsis. Pending candidates cannot be selected against newer input. Glyph misses use placeholders in the missing cells; they do not hide resident text.

**CJK glyphs use an alphabetic baseline derived from font and ink ascent.** The label reserves eight logical pixels beyond the font size for ascent, descent and leading; a 16-point candidate has a 24-point line box. A glyph arrives in one bounded coverage envelope. Deleting or moving resident characters reuses their metrics and textures, including while offline. See [text resources and the general shaping architecture](TEXT_RESOURCES.md). Updating this path requires rebuilding the device app and restarting the Mac companion.

**Offline typing shows raw input without a pending-candidate animation.** Space or Return commits it; switching to EN also commits it, and leaving the row finishes editing. Deletion and caret movement use the local raw buffer. Connected but unanswered confirmation follows the same path after 400 ms of virtual time. A composition is bounded to 128 actions; the cancel control clears it if the limit is reached. Clear retains its existing 40-code-point title limit and in-memory demo list model. It does not add list persistence or dictionary learning.

## Validation

`bun run test` includes shared queue/authentication/generation tests, IME revision/reconnect tests, text cache and pixel continuity tests, candidate scroll/selection tests and the Moto viewport plan test. `bun tools/ime/verify.ts` requires the built native Rime data and checks Chinese phrases, candidate selection, deterministic replay, paging, read windows, absolute selection, backspace, caret movement, raw commit and space selection.

**Native validation covered composition, candidate scrolling and selection, caret bounds, offline deletion and reconnect on both devices.** Deployment included byte readback on iPod and APK hash readback on Moto. The implementation's test results, measured performance and selected screenshots are recorded in [PR #396](https://github.com/pocket-stack/pocketjs/pull/396).

To repeat device acceptance after building, installing and starting the companion:

1. Open a list row, type `ni`, expand the candidate panel, scroll, then tap a candidate. Drag release must leave composition active; the later tap commits the selected candidate and restores the keyboard.
2. Type `haha`, hold Space and drag past each end of the preedit. The caret must stay at the input boundary. Releasing the hold must not insert a space or commit a candidate.
3. Hold Backspace, then release. Deletion must repeat while held and stop on release. Check the pressed Space cap, mode label and character popup through their transitions.
4. Commit `你好`, disconnect the companion and delete `好`. The remaining Latin and Han text must retain its pixels. Enter another composition while disconnected, commit it with Space, then leave the row with Return. Repeat with an unfinished composition, restore the companion and select a candidate. Local and converted commits must each appear once. Remove the Moto forward or stop the iPod tunnel to verify supervisor repair; restart a provider child to verify process recovery.
5. Switch between empty PY and EN. Both modes must hide the composition cross and disclosure; Space must show the active mode.

**Static panels and sustained scrolling require separate timing runs.** On iPod, start from a fresh launch, compose `ni`, expand the panel, wait four seconds, then drag 140 logical points over eight seconds in each direction. Sample device status before taking captures. Use distinct 60-frame heartbeat windows with `touch_down=1`; compute delivered FPS as `window_frames × 1,000,000 / window_us`. `frame_us` measures the guest/core frame before presentation, and `submit_us` measures GL submission. Keep first-pass and reverse-pass results separate. Window means do not establish frame-time percentiles or physical-finger response times.

Capture commands write to ignored `dist/` output. Keep per-run screenshots, logs and device receipts under `.pocket-build/validation/clear/<run>/`; attach selected images and a validation summary to the PR. Versioned image fixtures belong with the tests that consume them. iPod capture reads the app's rendered frame; Android capture reads the device display. GraphicsServices and ADB input exercise native input routes; physical-finger testing remains a separate check.
