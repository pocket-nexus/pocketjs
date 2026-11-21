//! The program without the panels and inputs: scripted buttons and taps, and
//! two in-memory XRGB8888 panels with the device's geometry behind the same
//! KMS display type the device uses (pocket_linux_drm::Display).
//!
//! A script is a list of `<tick>:<event>` words. An event is a button name
//! (`UP`, `DOWN`, `LEFT`, `RIGHT`, `START`, `SELECT`, `CROSS`, `CIRCLE`,
//! `SQUARE`, `TRIANGLE`, `LTRIGGER`, `RTRIGGER`, `ZL`, `ZR`), a tap on the
//! lower panel at logical `x,y` (`tap@256,190`), both held for two ticks, or
//! `shot`, which writes both panels after that tick to `<dir>/<tick>-top.xrgb`
//! and `<dir>/<tick>-bottom.xrgb` (rows of little-endian XRGB8888, no
//! padding). The program exits after the last event.
use pocket_drivers::{Contact, DisplayRole, InputClasses, InputFrameBuilder, InputSource, Rect};
use pocket_linux_drm::{Display, Scanout};
use pocket_runtime::{RendererId, Runtime};
use pocket_spec::btn;
use std::{cell::Cell, cell::RefCell, error::Error, io, path::PathBuf, rc::Rc};

const HOLD_TICKS: u32 = 2;

enum Event {
    Press(u32),
    Tap(f32, f32),
    Shot,
}

/// A panel in memory: a flip copies the damaged rows into `screen` and
/// completes at once.
struct Panel {
    screen: Rc<RefCell<Vec<u8>>>,
    width: usize,
}

impl Scanout for Panel {
    fn present(&mut self, _: usize, pixels: &[u8], damage: &[Rect]) -> io::Result<()> {
        let mut screen = self.screen.borrow_mut();
        let pitch = self.width * 4;
        for r in damage {
            for y in r.y as usize..(r.y + r.height) as usize {
                let at = y * pitch + r.x as usize * 4;
                let len = r.width as usize * 4;
                screen[at..at + len].copy_from_slice(&pixels[at..at + len]);
            }
        }
        Ok(())
    }
    fn wait(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn stop(&mut self) {}
}

struct Script {
    tick: Rc<Cell<u32>>,
    presses: Vec<(u32, u32)>,
    taps: Vec<(u32, f32, f32)>,
}

impl InputSource for Script {
    fn classes(&self) -> InputClasses {
        InputClasses::from_bits(InputClasses::BUTTONS.bits() | InputClasses::CONTACT.bits())
    }
    fn poll(&mut self, frame: &mut InputFrameBuilder) {
        let tick = self.tick.get();
        let held = |at: u32| (at..at + HOLD_TICKS).contains(&tick);
        for (at, mask) in &self.presses {
            if held(*at) {
                frame.buttons |= mask;
            }
        }
        for (at, x, y) in &self.taps {
            if held(*at) {
                frame.contacts.push(Contact {
                    surface: 1,
                    id: 0,
                    x: *x,
                    y: *y,
                    cancelled: false,
                });
            }
        }
    }
}

pub struct Shot {
    tick: Rc<Cell<u32>>,
    shots: Vec<u32>,
    last: u32,
    directory: PathBuf,
    screens: [Rc<RefCell<Vec<u8>>>; 2],
}

fn button(name: &str) -> Option<u32> {
    Some(match name {
        "UP" => btn::UP,
        "DOWN" => btn::DOWN,
        "LEFT" => btn::LEFT,
        "RIGHT" => btn::RIGHT,
        "START" => btn::START,
        "SELECT" => btn::SELECT,
        "CROSS" => btn::CROSS,
        "CIRCLE" => btn::CIRCLE,
        "SQUARE" => btn::SQUARE,
        "TRIANGLE" => btn::TRIANGLE,
        "LTRIGGER" => btn::LTRIGGER,
        "RTRIGGER" => btn::RTRIGGER,
        "ZL" => btn::ZL,
        "ZR" => btn::ZR,
        _ => return None,
    })
}

fn parse(script: &str, extent: [u32; 2]) -> Result<Vec<(u32, Event)>, String> {
    script
        .split_whitespace()
        .map(|word| {
            let (tick, name) = word
                .split_once(':')
                .ok_or_else(|| format!("{word}: not <tick>:<event>"))?;
            let tick: u32 = tick.parse().map_err(|_| format!("{word}: bad tick"))?;
            let event = if name == "shot" {
                Event::Shot
            } else if let Some(point) = name.strip_prefix("tap@") {
                let (x, y) = point
                    .split_once(',')
                    .and_then(|(x, y)| Some((x.parse::<f32>().ok()?, y.parse::<f32>().ok()?)))
                    .ok_or_else(|| format!("{word}: tap@x,y needs two numbers"))?;
                if !(0.0..extent[0] as f32).contains(&x) || !(0.0..extent[1] as f32).contains(&y) {
                    return Err(format!(
                        "{word}: outside the lower panel's {}x{}",
                        extent[0], extent[1]
                    ));
                }
                Event::Tap(x, y)
            } else {
                Event::Press(button(name).ok_or_else(|| format!("{word}: unknown button"))?)
            };
            Ok((tick, event))
        })
        .collect()
}

pub fn attach(
    runtime: &mut Runtime,
    renderer: RendererId,
    sizes: [[u32; 2]; 2],
    lower_extent: [u32; 2],
    directory: PathBuf,
    script: &str,
) -> Result<Shot, Box<dyn Error>> {
    let events = parse(script, lower_extent)?;
    if events.is_empty() {
        return Err("--shot needs a --script with at least one event".into());
    }
    std::fs::create_dir_all(&directory)?;
    let mut screens = Vec::new();
    for (size, role) in sizes
        .into_iter()
        .zip([DisplayRole::Primary, DisplayRole::Auxiliary])
    {
        let screen = Rc::new(RefCell::new(vec![
            0u8;
            size[0] as usize * size[1] as usize * 4
        ]));
        let panel = Panel {
            screen: screen.clone(),
            width: size[0] as usize,
        };
        runtime
            .add_display(Display::new(panel, size)?.with_role(role), renderer)
            .map_err(|e| format!("{e:?}"))?;
        screens.push(screen);
    }
    let tick = Rc::new(Cell::new(0));
    let (mut presses, mut taps, mut shots, mut last) = (Vec::new(), Vec::new(), Vec::new(), 0);
    for (at, event) in events {
        last = last.max(at);
        match event {
            Event::Press(mask) => presses.push((at, mask)),
            Event::Tap(x, y) => taps.push((at, x, y)),
            Event::Shot => shots.push(at),
        }
    }
    runtime
        .add_input_source(Box::new(Script {
            tick: tick.clone(),
            presses,
            taps,
        }))
        .map_err(|e| format!("{e:?}"))?;
    let [a, b]: [_; 2] = screens.try_into().unwrap();
    Ok(Shot {
        tick,
        shots,
        last,
        directory,
        screens: [a, b],
    })
}

impl Shot {
    /// False once the script's last event has run.
    pub fn before_tick(&mut self) -> bool {
        self.tick.get() <= self.last
    }

    pub fn after_tick(&mut self) -> io::Result<()> {
        let tick = self.tick.get();
        if self.shots.contains(&tick) {
            for (name, screen) in ["top", "bottom"].iter().zip(&self.screens) {
                std::fs::write(
                    self.directory.join(format!("{tick}-{name}.xrgb")),
                    &*screen.borrow(),
                )?;
            }
        }
        self.tick.set(tick + 1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_names_ticks_buttons_taps_and_shots() {
        let events = parse("3:DOWN 9:ZL 10:tap@256,190 12:shot", [512, 384]).unwrap();
        assert!(matches!(events[0], (3, Event::Press(mask)) if mask == btn::DOWN));
        assert!(matches!(events[1], (9, Event::Press(mask)) if mask == btn::ZL));
        assert!(matches!(events[2], (10, Event::Tap(x, y)) if x == 256.0 && y == 190.0));
        assert!(matches!(events[3], (12, Event::Shot)));
        assert!(parse("4:JUMP", [512, 384]).is_err());
        assert!(parse("4:tap@600,10", [512, 384]).is_err());
        assert!(parse("DOWN", [512, 384]).is_err());
    }
}
