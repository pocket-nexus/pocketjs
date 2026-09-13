# Modality and presentations

A capability id names one framework behavior a host implements. A modality
is the shape those behaviors take on one device: how many screens, which
screen takes contacts, whether a d-pad and sticks exist, where text comes
from, how large the primary screen is. A presentation is an application
entry module written for one modality. This document states the model, the
manifest surface, the build mechanism, and the two devices the model was
built against.

## Modality

`contracts/spec/modality.ts` derives a `Modality` from a `TargetProfile`.
**Nothing registers a modality; `deriveModality` is a pure function of the
display facts and capability ids the profile already carries.** The
registry stays an inventory of hosts and the modality stays a view over it.

| Field | Derived from | Values |
| --- | --- | --- |
| `screens[]` | `display` and `display.auxiliary` | one entry per screen: `role`, `logical`, `orientation`, `touch`, `resizable` |
| `touch` | `input.touch`, `input.touch.auxiliary` | `none`, `primary`, `auxiliary` |
| `pointer` | `input.pointer`, `input.cursor` | `none`, `cursor`, `pointer` |
| `buttons` | `input.buttons` | boolean |
| `analog` | `input.analog.left`, `input.analog.right` | 0, 1, 2 |
| `text` | `input.text` | `osk`, `keyboard` |
| `glyphs` | `platform` | `playstation` (○ × △ □), `letters` (A B X Y) |
| `form` | `form` | the target form |

A screen's `logical` size is the panel at the target's raster density
(`physicalViewport / rasterDensity`); a dynamic form reports its default
window size with `resizable: true`. **A device reports contacts on one
screen**: the Vita on its primary panel, the 3DS on its auxiliary panel.
`glyphs` follows the platform because the spec names buttons by their
PlayStation positions and the 3DS host maps A/B/X/Y onto those positions
(`hosts/3ds/src/input.c`).

### The PSP and the 3DS

| | PSP | New 3DS |
| --- | --- | --- |
| screens | one, 480×272 landscape, no touch | 400×240 landscape top; 320×240 landscape bottom with touch |
| touch | `none` | `auxiliary` |
| pointer | `cursor` (nub-steered) | `cursor` |
| buttons | yes | yes |
| analog | 1 | 2 |
| text | `osk` | `osk` |
| glyphs | `playstation` | `letters` |

The Vita derives to the PSP's shape with `touch: primary`; the PocketBook
to the PSP's shape with `touch: primary`, `pointer: none`, `analog: 0`.
`PORTABLE_MODALITY` is the PSP value, pinned by `tests/modality.test.ts`,
and is what a bundle built without a plan reads.

## Presentations

`pocket.json` gains `app.presentations`, an ordered list of entry modules
each addressed to a modality:

```json
"app": {
  "entry": "app/main.tsx",
  "viewport": { "logical": [480, 272], "presentation": "integer-fit" },
  "presentations": [
    {
      "id": "dual-screen",
      "entry": "app/main-dual.tsx",
      "output": "pocket-youtube",
      "modality": { "screens": 2, "touch": "auxiliary" },
      "viewport": { "fixed": { "logical": [400, 240], "presentation": "native" } },
      "surfaces": { "auxiliary": { "fixed": { "logical": [320, 240], "presentation": "native" } } },
      "capabilities": {
        "requires": ["display.auxiliary", "input.touch.auxiliary", "media.playback", "io.offload"],
        "enhances": ["input.analog.right"]
      }
    }
  ]
}
```

`modality` is a requirement over the derived description: `screens` is an
exact count, `analog` a minimum, `minScreen`/`maxScreen` inclusive bounds on
the primary screen's logical size, `touch` and `pointer` exact or `"any"`.
An absent field matches every device.

The resolver (`framework/src/manifest/resolve.ts`):

1. derives the target's modality;
2. walks `presentations` in order and takes the first whose requirement the
   modality meets; none matching selects the baseline `app.entry` under the
   id `default`;
3. resolves the viewport and surfaces the chosen presentation declares,
   or the app-level ones when it declares none;
4. admits the union of `engine.capabilities` and the presentation's
   `capabilities`. **A presentation `requires` may promote an app-level
   `enhances`; any other repeated id is a `capability.duplicate`
   diagnostic**;
5. writes `plan.presentation = { id, entry }`, `plan.modality`, and sets
   `plan.app.entry` to the chosen entry.

**A presentation that matches a device but fails admission there is an
error, reported at the presentation's JSON Pointer**, because the author
addressed that entry to that device. Selection is a match on modality;
admission is the capability check; the two stay separate.

## Build mechanism

The compiler walks the module graph from `plan.app.entry` (pass 1 in
`tools/build.ts`) and Bun bundles that graph (pass 2). **A presentation's
modules, class literals, glyphs and image assets enter a bundle only when
that presentation is the chosen entry.** Shared modules (store, protocol,
drivers) sit beside the presentations and are imported by each entry. This
is the split the manifest exists for: large differences are separate
entries, each distributed to the devices that match it; small differences
are branches inside one entry.

Inside an entry, two tools carry the small differences:

- `hasFeature("…")` from `@pocketjs/framework/platform`, folded to a boolean
  at compile time (`framework/compiler/jsx-plugin.ts`), so an unavailable
  enhancement's branch leaves the bundle;
- `modality`, `screen()`, `surfaceHasTouch()`, `supports()` and `glyph()`
  from `@pocketjs/framework/modality`, read at runtime from the
  `__POCKET_MODALITY__` define `tools/build.ts` writes from the plan.

## The system keyboard as the worked example

`framework/src/osk.tsx` renders one keyboard whose layout and input
adapters follow the surface it renders on (`framework/src/osk-session.ts`):

| Surface | Layout | Adapters |
| --- | --- | --- |
| no contacts, buttons (PSP) | `grid`: caret, hide and commit are keys | focus controller with spatial navigation; chords □ ⌫ · △ space · × close · R shift · L layer · START commit |
| contacts (Vita panel, 3DS bottom screen) | `staggered`: phone rows at 30 px | down-edge typing; backspace hold repeat; hold-space caret trackpad; shift twice within 0.35 s locks caps; chords when buttons exist |

**The keyboard remembers its layer and key across opens, per layout,
device-wide** (`recallPanel`/`rememberPanel`), so a PSP user who closed the
panel on `k` reopens it on `k`. On a surface with contacts and buttons the
focus ring stays hidden until the first d-pad press and hides again on the
next contact, so the phone layout reads as a touch keyboard until the d-pad
is used. The `theme` prop is a skin; `classic` is the bezelled light look
`framework/src/classic.ts` shares with app chrome, and the same theme
renders both layouts.

`tests/osk-script.ts` mirrors these rules for journeys: a scripter walks
the same `layoutRows`/`navigate` math, and `resume` continues from the
layer and key another scripter left the keyboard on.
