//! A Pocket3D game's demo: a fixed script of pad presses that the game plays
//! from its title's Demo row, so the same run shows on every device and every
//! time, ready to be filmed.
//!
//! The game's flow crate holds a [`Demo`] while one plays. Each frame it hands
//! the demo the real pad and reads back the buttons to play that frame with,
//! a step of its own to carry out ([`Tick::Call`]), or the end. The buttons go
//! where the real pad's would: to the simulation and to the interface's guest.
//! The first button pressed on the real pad ends the demo.
//!
//! A script is text, one step a line:
//!
//! ```text
//! # Twin Isles from day 15, the computer on both sides.
//! call scene isles
//! wait 15s
//! press right x3          # down 4 frames, up 14, three times
//! press circle 40         # down 4 frames, up 40
//! hold left+square 1.5s
//! until board 60s         # the game's mark "board"; the demo ends after 60 s without it
//! ```
//!
//! Times are frames at 60 a second, or seconds with an `s`. Buttons are the
//! PocketJS masks ([`btn`]), joined with `+`.

#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::fmt;

/// PocketJS button masks (`BTN` in `contracts/spec/spec.ts`).
pub mod btn {
    pub const SELECT: u32 = 0x0001;
    pub const START: u32 = 0x0008;
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
    pub const L: u32 = 0x0100;
    pub const R: u32 = 0x0200;
    pub const ZL: u32 = 0x0400;
    pub const ZR: u32 = 0x0800;
    pub const TRIANGLE: u32 = 0x1000;
    pub const CIRCLE: u32 = 0x2000;
    pub const CROSS: u32 = 0x4000;
    pub const SQUARE: u32 = 0x8000;
}

/// Frames a press holds its buttons down.
pub const PRESS_FRAMES: u32 = 4;
/// Frames after a press when the line names none.
pub const PRESS_GAP: u32 = 14;
/// Frames `until` waits when the line names no limit: 60 seconds.
pub const UNTIL_LIMIT: u32 = 3600;

/// One step of a script.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// These buttons down for this many frames.
    Hold { buttons: u32, frames: u32 },
    /// Nothing pressed for this many frames.
    Wait(u32),
    /// Nothing pressed until the game says the mark holds; the demo ends after `limit` frames without it.
    Until { mark: String, limit: u32 },
    /// A step the game carries out itself (setting up a scene), with the words after `call`.
    Call(String),
}

/// A script's step and the line it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub step: Step,
    pub line: u32,
}

/// A line the script cannot be read past.
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    pub line: u32,
    pub what: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "demo script line {}: {}", self.line, self.what)
    }
}

fn button(name: &str) -> Option<u32> {
    Some(match name {
        "select" => btn::SELECT,
        "start" => btn::START,
        "up" => btn::UP,
        "right" => btn::RIGHT,
        "down" => btn::DOWN,
        "left" => btn::LEFT,
        "l" => btn::L,
        "r" => btn::R,
        "zl" => btn::ZL,
        "zr" => btn::ZR,
        "triangle" => btn::TRIANGLE,
        "circle" => btn::CIRCLE,
        "cross" => btn::CROSS,
        "square" => btn::SQUARE,
        _ => return None,
    })
}

fn buttons(word: &str) -> Result<u32, String> {
    let mut mask = 0;
    for name in word.split('+') {
        mask |= button(name).ok_or_else(|| alloc::format!("no button is called \"{name}\""))?;
    }
    Ok(mask)
}

/// `40` is 40 frames; `1.5s` is 90.
fn time(word: &str) -> Result<u32, String> {
    let bad = || alloc::format!("\"{word}\" is not a time (frames, or seconds with an s)");
    match word.strip_suffix('s') {
        Some(seconds) => {
            let s: f32 = seconds.parse().map_err(|_| bad())?;
            if s.is_nan() || s < 0.0 {
                return Err(bad());
            }
            Ok((s * 60.0 + 0.5) as u32)
        }
        None => word.parse().map_err(|_| bad()),
    }
}

/// Reads a script.
pub fn parse(text: &str) -> Result<Vec<Line>, Error> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = (i + 1) as u32;
        let words: Vec<&str> = raw.split('#').next().unwrap_or("").split_whitespace().collect();
        let Some((&verb, args)) = words.split_first() else { continue };
        let fail = |what: String| Error { line, what };
        let mut push = |step: Step| out.push(Line { step, line });
        match verb {
            "wait" => match args {
                [t] => push(Step::Wait(time(t).map_err(fail)?)),
                _ => return Err(fail("wait takes one time".into())),
            },
            "hold" => match args {
                [b, t] => push(Step::Hold { buttons: buttons(b).map_err(fail)?, frames: time(t).map_err(fail)? }),
                _ => return Err(fail("hold takes buttons and a time".into())),
            },
            "press" => {
                let Some((b, rest)) = args.split_first() else { return Err(fail("press takes buttons".into())) };
                let mask = buttons(b).map_err(fail)?;
                let mut times = 1;
                let mut gap = PRESS_GAP;
                for w in rest {
                    match w.strip_prefix('x').and_then(|n| n.parse::<u32>().ok()) {
                        Some(n) => times = n,
                        None => gap = time(w).map_err(fail)?,
                    }
                }
                for _ in 0..times {
                    push(Step::Hold { buttons: mask, frames: PRESS_FRAMES });
                    push(Step::Wait(gap));
                }
            }
            "until" => match args {
                [m] => push(Step::Until { mark: m.to_string(), limit: UNTIL_LIMIT }),
                [m, t] => push(Step::Until { mark: m.to_string(), limit: time(t).map_err(fail)? }),
                _ => return Err(fail("until takes a mark and at most a time".into())),
            },
            "call" if !args.is_empty() => push(Step::Call(args.join(" "))),
            "call" => return Err(fail("call takes the game's words".into())),
            _ => return Err(fail(alloc::format!("\"{verb}\" is not a step (wait, press, hold, until, call)"))),
        }
    }
    Ok(out)
}

/// How a demo ended.
#[derive(Clone, Debug, PartialEq)]
pub enum End {
    /// The script ran to its last line.
    Finished,
    /// A button was pressed on the real pad.
    Stopped,
    /// An `until` waited its whole limit: the game is not where the script expected it.
    Lost { line: u32, mark: String },
}

/// What a frame of the demo is.
#[derive(Clone, Debug, PartialEq)]
pub enum Tick {
    /// Play the frame with these buttons.
    Pad(u32),
    /// Carry out a step of the game's own; the next frame asks again.
    Call(String),
    /// The demo is over: back to the title.
    End(End),
}

/// A demo being played.
pub struct Demo {
    lines: Vec<Line>,
    at: usize,
    /// Frames into the current step.
    into: u32,
    /// The real pad has been let go since the demo began (the press that chose it does not end it).
    armed: bool,
    real: u32,
    frames: u32,
}

impl Demo {
    /// A demo of `lines`, begun while the real pad holds `pad`.
    pub fn new(lines: Vec<Line>, pad: u32) -> Demo {
        Demo { lines, at: 0, into: 0, armed: pad == 0, real: pad, frames: 0 }
    }

    /// Reads `text` and begins it.
    pub fn from_script(text: &str, pad: u32) -> Result<Demo, Error> {
        Ok(Demo::new(parse(text)?, pad))
    }

    /// One frame. `pad` is the real pad; `mark` says whether one of the game's marks holds now.
    pub fn tick(&mut self, pad: u32, mark: impl Fn(&str) -> bool) -> Tick {
        let pressed = pad & !self.real;
        self.real = pad;
        if !self.armed {
            self.armed = pad == 0;
        } else if pressed != 0 {
            return Tick::End(End::Stopped);
        }
        self.frames += 1;
        loop {
            let Some(line) = self.lines.get(self.at) else { return Tick::End(End::Finished) };
            match &line.step {
                Step::Hold { buttons: _, frames } | Step::Wait(frames) if self.into < *frames => {
                    let pad = match line.step {
                        Step::Hold { buttons, .. } => buttons,
                        _ => 0,
                    };
                    self.into += 1;
                    if self.into == *frames {
                        self.next();
                    }
                    return Tick::Pad(pad);
                }
                // A step of no frames.
                Step::Hold { .. } | Step::Wait(_) => self.next(),
                Step::Until { mark: m, limit } => {
                    if mark(m) {
                        self.next();
                    } else if self.into >= *limit {
                        return Tick::End(End::Lost { line: line.line, mark: m.clone() });
                    } else {
                        self.into += 1;
                        return Tick::Pad(0);
                    }
                }
                Step::Call(words) => {
                    let words = words.clone();
                    self.next();
                    return Tick::Call(words);
                }
            }
        }
    }

    fn next(&mut self) {
        self.at += 1;
        self.into = 0;
    }

    /// The script line playing now (0 past the end).
    pub fn line(&self) -> u32 {
        self.lines.get(self.at).map_or(0, |l| l.line)
    }

    /// Frames played so far.
    pub fn frames(&self) -> u32 {
        self.frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn run(demo: &mut Demo, frames: usize, marks: &[&str]) -> Vec<Tick> {
        (0..frames).map(|_| demo.tick(0, |m| marks.contains(&m))).collect()
    }

    #[test]
    fn reads_every_step() {
        let lines = parse("# a comment\n\ncall scene isles\nwait 1.5s\npress right+circle x2 6\nhold left 3\nuntil board 2s # trailing\n").unwrap();
        let steps: Vec<Step> = lines.iter().map(|l| l.step.clone()).collect();
        assert_eq!(
            steps,
            vec![
                Step::Call("scene isles".into()),
                Step::Wait(90),
                Step::Hold { buttons: btn::RIGHT | btn::CIRCLE, frames: 4 },
                Step::Wait(6),
                Step::Hold { buttons: btn::RIGHT | btn::CIRCLE, frames: 4 },
                Step::Wait(6),
                Step::Hold { buttons: btn::LEFT, frames: 3 },
                Step::Until { mark: "board".into(), limit: 120 },
            ]
        );
        assert_eq!(lines[0].line, 3);
        assert_eq!(lines[7].line, 7);
    }

    #[test]
    fn names_the_line_it_cannot_read() {
        assert_eq!(parse("wait 2\npress kick\n").unwrap_err(), Error { line: 2, what: "no button is called \"kick\"".into() });
        assert_eq!(parse("jump 3").unwrap_err().line, 1);
        assert_eq!(parse("wait soon").unwrap_err().line, 1);
        assert!(parse("call").is_err());
    }

    #[test]
    fn plays_presses_frame_by_frame() {
        let mut d = Demo::from_script("press circle 2\nwait 1", 0).unwrap();
        let c = btn::CIRCLE;
        assert_eq!(run(&mut d, 8, &[]), vec![Tick::Pad(c), Tick::Pad(c), Tick::Pad(c), Tick::Pad(c), Tick::Pad(0), Tick::Pad(0), Tick::Pad(0), Tick::End(End::Finished)]);
        assert_eq!(d.frames(), 8);
    }

    #[test]
    fn calls_the_game_then_goes_on() {
        let mut d = Demo::from_script("call scene 2\nhold up 1", 0).unwrap();
        assert_eq!(run(&mut d, 3, &[]), vec![Tick::Call("scene 2".into()), Tick::Pad(btn::UP), Tick::End(End::Finished)]);
    }

    #[test]
    fn waits_for_a_mark_and_gives_up_after_its_limit() {
        let mut d = Demo::from_script("until board 3\nhold up 1", 0).unwrap();
        assert_eq!(run(&mut d, 2, &[]), vec![Tick::Pad(0), Tick::Pad(0)]);
        // The mark holds: the next step plays in the same frame.
        assert_eq!(run(&mut d, 1, &["board"]), vec![Tick::Pad(btn::UP)]);

        let mut lost = Demo::from_script("wait 1\nuntil result 2", 0).unwrap();
        assert_eq!(run(&mut lost, 4, &[]), vec![Tick::Pad(0), Tick::Pad(0), Tick::Pad(0), Tick::End(End::Lost { line: 2, mark: "result".into() })]);
    }

    #[test]
    fn a_real_press_ends_it_but_not_the_one_that_chose_it() {
        let mut d = Demo::from_script("wait 100", btn::CIRCLE).unwrap();
        // ○ is still down from the title's row, then let go.
        assert_eq!(d.tick(btn::CIRCLE, |_| false), Tick::Pad(0));
        assert_eq!(d.tick(0, |_| false), Tick::Pad(0));
        assert_eq!(d.tick(0, |_| false), Tick::Pad(0));
        assert_eq!(d.tick(btn::START, |_| false), Tick::End(End::Stopped));

        // Held from the start and never let go: it never counts as a press.
        let mut held = Demo::from_script("wait 3", btn::CROSS).unwrap();
        assert_eq!(run_with(&mut held, btn::CROSS, 4), vec![Tick::Pad(0), Tick::Pad(0), Tick::Pad(0), Tick::End(End::Finished)]);
    }

    fn run_with(demo: &mut Demo, pad: u32, frames: usize) -> Vec<Tick> {
        (0..frames).map(|_| demo.tick(pad, |_| false)).collect()
    }
}
