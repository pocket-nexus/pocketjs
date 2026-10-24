//! The program without the panel and keyboard: a scripted button source and
//! an in-memory framebuffer with the panel's geometry (RGB565, 640-byte rows).
//!
//! A script is a list of `<tick>:<event>` words. An event is a button name
//! (`UP`, `DOWN`, `LEFT`, `RIGHT`, `START`, `SELECT`, `CROSS`, `CIRCLE`,
//! `SQUARE`, `TRIANGLE`, `LTRIGGER`, `RTRIGGER`; `ENTER` and `ESC` name the
//! buttons those keys give), held for two ticks, or `shot`, which writes the
//! framebuffer after that tick to `<dir>/<tick>.rgb565`. The program exits
//! after the last event.
use pocket_drivers::{InputClasses, InputFrameBuilder, InputSource};
use pocket_linux_fbdev::{Channel, FrameStore, Framebuffer, Geometry};
use pocket_runtime::{RendererId, Runtime};
use pocket_spec::btn;
use std::{cell::Cell, error::Error, path::PathBuf, rc::Rc};

const HOLD_TICKS: u32 = 2;

enum Event {
    Press(u32),
    Shot,
}

/// The framebuffer's bytes, leaked for the program's life: the display
/// writes them inside a tick and the shot reads them between ticks.
struct Store(*mut u8, usize);

impl FrameStore for Store {
    fn bytes_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.0, self.1) }
    }
}

struct Buttons {
    tick: Rc<Cell<u32>>,
    presses: Vec<(u32, u32)>,
}

impl InputSource for Buttons {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS
    }
    fn poll(&mut self, frame: &mut InputFrameBuilder) {
        let tick = self.tick.get();
        for (at, mask) in &self.presses {
            if (*at..*at + HOLD_TICKS).contains(&tick) {
                frame.buttons |= mask;
            }
        }
    }
}

pub struct Shot {
    tick: Rc<Cell<u32>>,
    shots: Vec<u32>,
    last: u32,
    directory: PathBuf,
    pixels: *const u8,
    length: usize,
}

fn button(name: &str) -> Option<u32> {
    Some(match name {
        "UP" => btn::UP,
        "DOWN" => btn::DOWN,
        "LEFT" => btn::LEFT,
        "RIGHT" => btn::RIGHT,
        "START" | "ENTER" => btn::START,
        "SELECT" => btn::SELECT,
        "CROSS" | "ESC" => btn::CROSS,
        "CIRCLE" => btn::CIRCLE,
        "SQUARE" => btn::SQUARE,
        "TRIANGLE" => btn::TRIANGLE,
        "LTRIGGER" => btn::LTRIGGER,
        "RTRIGGER" => btn::RTRIGGER,
        _ => return None,
    })
}

fn parse(script: &str) -> Result<Vec<(u32, Event)>, String> {
    script
        .split_whitespace()
        .map(|word| {
            let (tick, name) = word
                .split_once(':')
                .ok_or_else(|| format!("{word}: not <tick>:<event>"))?;
            let tick: u32 = tick.parse().map_err(|_| format!("{word}: bad tick"))?;
            let event = match name {
                "shot" => Event::Shot,
                _ => Event::Press(button(name).ok_or_else(|| format!("{word}: unknown button"))?),
            };
            Ok((tick, event))
        })
        .collect()
}

pub fn attach(
    runtime: &mut Runtime,
    renderer: RendererId,
    size: [u32; 2],
    directory: PathBuf,
    script: &str,
) -> Result<Shot, Box<dyn Error>> {
    let events = parse(script)?;
    if events.is_empty() {
        return Err("--shot needs a --script with at least one event".into());
    }
    std::fs::create_dir_all(&directory)?;
    let stride = size[0] as usize * 2;
    let length = stride * size[1] as usize;
    let pixels = Box::leak(vec![0u8; length].into_boxed_slice()).as_mut_ptr();
    let mut display = Framebuffer::new(
        Store(pixels, length),
        Geometry {
            width: size[0],
            height: size[1],
            x_offset: 0,
            y_offset: 0,
            stride,
            mapping_bytes: length,
            bits_per_pixel: 16,
            red: Channel {
                offset: 11,
                bits: 5,
            },
            green: Channel { offset: 5, bits: 6 },
            blue: Channel { offset: 0, bits: 5 },
            alpha: Channel { offset: 0, bits: 0 },
        },
    )?;
    display.set_partial_refresh(true);
    runtime
        .add_display(display, renderer)
        .map_err(|e| format!("{e:?}"))?;
    let tick = Rc::new(Cell::new(0));
    let mut presses = Vec::new();
    let mut shots = Vec::new();
    let mut last = 0;
    for (at, event) in events {
        last = last.max(at);
        match event {
            Event::Press(mask) => presses.push((at, mask)),
            Event::Shot => shots.push(at),
        }
    }
    runtime
        .add_input_source(Box::new(Buttons {
            tick: tick.clone(),
            presses,
        }))
        .map_err(|e| format!("{e:?}"))?;
    Ok(Shot {
        tick,
        shots,
        last,
        directory,
        pixels,
        length,
    })
}

impl Shot {
    /// False once the script's last event has run.
    pub fn before_tick(&mut self) -> bool {
        self.tick.get() <= self.last
    }

    pub fn after_tick(&mut self) -> std::io::Result<()> {
        let tick = self.tick.get();
        if self.shots.contains(&tick) {
            let bytes = unsafe { std::slice::from_raw_parts(self.pixels, self.length) };
            std::fs::write(self.directory.join(format!("{tick}.rgb565")), bytes)?;
        }
        self.tick.set(tick + 1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_names_ticks_buttons_and_shots() {
        let events = parse("3:DOWN 9:ENTER 12:shot").unwrap();
        assert!(matches!(events[0], (3, Event::Press(mask)) if mask == btn::DOWN));
        assert!(matches!(events[1], (9, Event::Press(mask)) if mask == btn::START));
        assert!(matches!(events[2], (12, Event::Shot)));
        assert!(parse("4:JUMP").is_err());
        assert!(parse("DOWN").is_err());
    }
}
