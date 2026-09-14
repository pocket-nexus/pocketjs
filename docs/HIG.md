# Pocket HIG: buttons, navigation, and the system layer

Pocket applications run on devices with a d-pad, four face buttons, two
shoulders, START and SELECT, and on some of them a touch panel or a second
screen. This document fixes what each control means across applications,
what the system layer owns, and how an application declares its actions so
every presentation renders the same intent. The PSP is the reference device;
the 3DS and Vita add contacts and a second screen on top of the same model.

## 1. Three tiers of control

| Tier | Owner | Controls | Intercepted before the guest |
| --- | --- | --- | --- |
| System | the host and the launcher | SELECT (hold), SELECT+START, L+R+SELECT | yes |
| Application | the presentation | ○ × △ □, d-pad, sticks, L, R, START | no |
| Composition | a framework component with input focus | the same buttons while it owns focus (a keyboard, a modal sheet) | blocked for the application by the component |

**A guest never sees a system chord.** The host samples the pad, matches the
reserved chords, and delivers the remaining mask through `globalThis.frame`.
This is the one place the model departs from "everything a guest can observe
is a surface op": a chord the guest cannot observe needs no op, and every
host implements the same table (`contracts/spec/spec.ts` gains it as data).

## 2. The application buttons

Android had three keys: Back, Home, Recents. The Pocket equivalents are two
application buttons and one system button:

| Intent | PSP / Vita | 3DS | Rule |
| --- | --- | --- | --- |
| Confirm, primary | ○ | A | Activates the focused control. Plays, opens, submits. |
| Back | × | B | Goes up one level of the presentation's own stack. At the root it does nothing; leaving the application is the system button's job. |
| Action | △ | X | The presentation's one contextual verb: search, compose, type. Opens the keyboard wherever a field exists. |
| Option | □ | Y | Secondary verb on the focused item: save, share, details. Hold for a destructive variant (delete) behind a `ClassicSheet`. |
| Sections | L / R | L / R | Move between top-level sections or skip in media. |
| Media | START | START | Play/pause on a media screen, submit on a form. |
| Home / switcher | hold SELECT | hold SELECT | System. Never an application verb. |

Two invariants keep this legible on a 272 px screen:

- **The footer strip states the live mapping.** A `Footer` (the classic
  `ActionBar`) renders the legend from the presentation's declared actions,
  spelled with `glyph()` so the PSP prints `○ play · △ search` and the 3DS
  prints `A play · X search`. Hidden verbs do not exist: a verb without a
  legend entry is not bound.
- **Focus is the selection.** The d-pad moves one focus; ○ acts on it; the
  focused row carries the `ClassicSelection` wash on every device. A touch
  panel taps the same rows and never introduces a second selection model.

## 3. Declaring actions once

A presentation declares intents, not buttons. The framework maps intents to
the device's buttons and renders the legend or the touch controls the
modality calls for:

```ts
import { useActions } from "@pocketjs/framework/actions";

useActions({
  confirm: { label: "play", run: () => store.play(focused()) },
  action:  { label: "search", run: () => osk.open() },
  option:  { label: "save", run: () => downloads.start(focused()), hold: { label: "delete", run: remove } },
  back:    { run: () => store.stopPlayback() },
});
```

`useActions` binds the intents to `onButtonPress` for the presentation's
lifetime, feeds the footer legend, and on a surface with contacts renders
the same intents as `ClassicButton`s in the bottom bar (the 3DS controls
panel already does this by hand). A component that takes focus (the OSK, a
`ClassicSheet`) pushes the existing button-handler block, so the
application's intents stay bound and stay muted while it is up.

This is the mechanism the modality work already uses for the keyboard,
applied one level up: intents are the vocabulary, the modality decides
whether they render as a legend, as buttons, or as both.

## 4. The system layer

Only one guest runs at a time on a console. The PSP has 24 MB and one
QuickJS arena; "background" is a design, not a process state. The launcher
(`docs/LAUNCHER.md`) already switches whole guests behind the veil with a
frozen shot of the outgoing application. The system layer completes that
into a switcher:

| Chord | System behaviour |
| --- | --- |
| hold SELECT 400 ms | Home: the veil plays, the launcher's deck opens on the current application's card. Tap a card to switch. |
| SELECT + START | System sheet over the frozen shot: brightness, volume, network status, companion status, Quit. |
| L + R + SELECT | Screenshot to `ms0:/POCKET/shots/` (development builds). |
| SELECT tap | Reserved. No application verb may bind it. |

**Switching is relaunch with restored state.** Two capabilities make it
read as a background switch:

1. `app.state`: a per-application key-value store the guest writes on
   `onSuspend` and reads on mount (`docs/PLATFORM.md` reserves it). The
   launcher calls the guest's suspend hook before teardown, so the search
   query, the scroll position and the playing video's position survive.
2. `frozenShot`: the outgoing frame stays on screen through the eval, and
   the incoming guest's first frame replaces it. A restore that lands on the
   same screen reads as an instant resume.

The launcher's deck orders cards by last use, so hold-SELECT then ○ returns
to the previous application: that is Recents. Home is the same deck scrolled
to its first card.

## 5. Screen anatomy

```
┌────────────────────────────────────────────────┐ 36  title bar: title · field · status
│ Pocket YouTube   [Search YouTube      ]  USB   │
├────────────────────────────────────────────────┤
│ ▌row                                         › │ 64  rows: flush, 1 px rule, selection wash
│  row                                         › │
│  row                                         › │
├────────────────────────────────────────────────┤ 24  footer: counter · legend
│            1/12 · ↕ browse · ○ play · △ search │
└────────────────────────────────────────────────┘
```

- **Title bar, 36 px**: title at the left with a 12 px margin, a search or
  filter field in the middle when the screen has one, status at the right.
  One strip; no second row under it.
- **Rows, 64 px on a 480-wide screen, 64 px on the 320-wide 3DS panel**:
  flush with the screen edges, separated by the row's own 1 px rule,
  selected with `ClassicSelection` (tint plus left bar). Cards keep their
  content inside the visible width the host is told about.
- **Footer, 24 px**: left the counter or status, right the legend. Errors
  turn the footer text red; nothing else moves.
- **Keyboard**: docks at the bottom over the footer; the list shrinks by
  `oskHeight()`. The keyboard owns every button while open.
- **Modal**: `ClassicSheet` from the bottom over a scrim; × closes it.

## 6. Modality variants

| Modality | Legend | Touch controls | Selection | Keyboard |
| --- | --- | --- | --- | --- |
| buttons, no touch (PSP) | footer | none | wash follows focus | grid, remembered key |
| buttons + touch, one screen (Vita) | footer | rows tap; sheets and bars get `ClassicButton`s | wash follows focus and the last tap | staggered, ring hidden until d-pad |
| buttons + touch bottom screen (3DS) | footer on the bottom screen | the intents render as tiles on the bottom screen | wash follows focus and the last tap | staggered on the bottom screen |

The presentation never branches on the target id. It declares intents,
reads `modality` for the smaller choices, and lets the framework spell the
legend with the device's glyphs.

## 7. What exists and what this document asks for

| Piece | State |
| --- | --- |
| `glyph()` per-device button names | shipped (`@pocketjs/framework/modality`) |
| `ClassicSelection`, `ClassicButton`, `ClassicSheet` | shipped (`@pocketjs/framework/classic`) |
| Launcher veil, frozen shot, whole-guest switch | shipped (`docs/LAUNCHER.md`) |
| `useActions` intents and the generated legend | proposed; the footer legend in pocket-youtube is the hand-written form |
| Host-reserved system chords | proposed; needs a chord table in `spec.ts` and one filter in each host's pad sampler |
| `app.state` suspend/restore | proposed; `docs/PLATFORM.md` names it as a later capability |
