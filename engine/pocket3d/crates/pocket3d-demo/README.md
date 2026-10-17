# pocket3d-demo

A Pocket3D game's demo: a row on the title, **Demo**, that plays a fixed script
of pad presses. The script starts from a fixed scene and a fixed random seed,
so the run is the same on every device and every time, and a console can be
filmed playing it with nobody holding it.

The crate is `no_std` with no dependencies. The game's flow crate holds a
`Demo` while one plays; each frame the device's host asks the flow for the
buttons to play with, and passes them where the pad's would go: to the
simulation and to the interface's guest. The guest's lists are worked by the
same presses a player makes.

```rust
// In the flow crate, the frame's input:
pub fn input(&mut self, pad: u32) -> u32 {
    let Some(mut demo) = self.demo.take() else { return pad };
    match demo.tick(pad, |mark| self.mark(mark)) {
        Tick::Pad(buttons) => { self.demo = Some(demo); buttons }
        Tick::Call(words) => { self.demo = Some(demo); self.call(&words); 0 }
        Tick::End(_) => { self.back_to_title(); 0 }
    }
}

// In each host, before the simulation and the guest read the pad:
let buttons = game.input(pad);
```

## The script

One step a line; `#` starts a comment.

| Line | Step |
| --- | --- |
| `wait 40` / `wait 1.5s` | Nothing pressed for 40 frames / 90 frames |
| `press circle` | ○ down for 4 frames, then 14 frames with nothing pressed |
| `press right x3 30` | Three presses of → , each followed by 30 frames |
| `hold left+square 2s` | ← and □ down for 120 frames |
| `until board` | Nothing pressed until the game's mark `board` holds; the demo ends after 60 s without it |
| `until turn 90s` | The same with a limit of 90 s |
| `call scene isles` | A step the game carries out itself, here setting up a scene |

Times are frames at 60 a second, or seconds with `s`. Buttons are the PocketJS
masks (`select start up right down left l r zl zr triangle circle cross
square`), joined with `+`.

**Wait for a mark after every action that plays out.** A press made while an
animation runs is dropped, and a script timed in frames alone drifts off the
board within a few actions. The marks are the game's own words: a mode's name,
"the player's turn with nothing playing out", "the computer's turn".

## How a demo ends

| `End` | When |
| --- | --- |
| `Finished` | The script ran past its last line |
| `Stopped` | A button went down on the real pad. Buttons already down when the demo began (the ○ that chose the row) count only after they are let go |
| `Lost { line, mark }` | An `until` waited its whole limit: the game is not where the script expected it |

On each of them the game goes back to its title. The flow then ignores the
buttons that stopped the demo until they are let go, so the same press does
not also pick a row of the title.

## What the game owes

- The Demo row is the title's last row.
- The scene and the random seed are set by the script's first `call`, never
  taken from the session the player was in. A scene can start from a stored
  board as well as from a map's first day.
- A demo writes no save, and the player's choices (sides, settings) are put
  back when it ends.
- The interface is drawn and the sound plays, as in play.
- A test plays the whole script on the desktop with the game's AI and a
  stand-in for the interface's lists, asserts it ends `Finished`, and plays it
  twice to assert the two runs send the same state lines.
