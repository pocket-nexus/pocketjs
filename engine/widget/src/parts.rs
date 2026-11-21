//! The interaction vocabulary: named part shapes → PSP input.
//!
//! A part is a pickable region of the widget's model (a button cap, the
//! analog nub, the screen) with the BTN bits it holds down while pressed.
//! The map is deliberately dumb — a static table, no gameplay logic — so
//! that what a click does is auditable at a glance.

use glam::{Mat4, Vec3};
use winit::keyboard::KeyCode;

use crate::pick::ray_obb;

/// The spec BTN bits (contracts/spec/spec.ts) — the PSP pad register layout every
/// `frame(buttons, analog)` guest sees, identical across hardware and hosts.
pub mod btn {
    pub const SELECT: u32 = 0x0001;
    pub const START: u32 = 0x0008;
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
    pub const LTRIGGER: u32 = 0x0100;
    pub const RTRIGGER: u32 = 0x0200;
    pub const TRIANGLE: u32 = 0x1000;
    pub const CIRCLE: u32 = 0x2000;
    pub const CROSS: u32 = 0x4000;
    pub const SQUARE: u32 = 0x8000;
}

/// One pickable part: a local AABB placed by a world transform.
pub struct PartShape {
    /// Semantic name (`btn_cross`, `dpad_up`, `nub`, `screen`, `body`, …).
    pub name: String,
    /// BTN bits held while this part is pressed (0 for non-button parts).
    pub buttons: u32,
    pub transform: Mat4,
    pub aabb: (Vec3, Vec3),
}

/// All pickable parts of a widget. Picking returns the nearest hit along
/// the ray, so overlapping parts (a button proud of the body) resolve to
/// what the user visually clicked.
#[derive(Default)]
pub struct PartMap {
    parts: Vec<PartShape>,
}

impl PartMap {
    /// Register a part; returns its index (stable — parts are never removed).
    pub fn push(&mut self, part: PartShape) -> usize {
        self.parts.push(part);
        self.parts.len() - 1
    }

    /// Nearest part hit by the ray, as (index, t).
    pub fn pick(&self, origin: Vec3, dir: Vec3) -> Option<(usize, f32)> {
        let mut best: Option<(usize, f32)> = None;
        for (i, p) in self.parts.iter().enumerate() {
            if let Some(t) = ray_obb(origin, dir, &p.transform, p.aabb)
                && best.is_none_or(|(_, bt)| t < bt)
            {
                best = Some((i, t));
            }
        }
        best
    }

    pub fn get(&self, index: usize) -> Option<&PartShape> {
        self.parts.get(index)
    }

    pub fn iter(&self) -> impl Iterator<Item = &PartShape> {
        self.parts.iter()
    }

    pub fn len(&self) -> usize {
        self.parts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }
}

/// Pack analog axes into the spec `frame(buttons, analog)` word:
/// `((128 + x·127) << 8) | (128 + y·127)`, inputs in −1..1 (x right,
/// y down — the PSP nub convention). Extremes land on raw 255/1, never 0,
/// matching the input-tape convention hardware pads produce.
pub fn analog_pack(x: f32, y: f32) -> u32 {
    let axis = |v: f32| (128 + (v.clamp(-1.0, 1.0) * 127.0).round() as i32) as u32;
    (axis(x) << 8) | axis(y)
}

/// The shared keyboard map (uihost's): arrows = D-pad, Z/Enter = CROSS,
/// X/Backspace = CIRCLE, A = SQUARE, S = TRIANGLE, Q/W = L/R triggers,
/// Tab = SELECT, Space = START. Mouse-on-model is the magic; keys are the
/// daily driver — widgets mount both.
pub fn key_button(code: KeyCode) -> Option<u32> {
    Some(match code {
        KeyCode::ArrowUp => btn::UP,
        KeyCode::ArrowDown => btn::DOWN,
        KeyCode::ArrowLeft => btn::LEFT,
        KeyCode::ArrowRight => btn::RIGHT,
        KeyCode::KeyZ | KeyCode::Enter => btn::CROSS,
        KeyCode::KeyX | KeyCode::Backspace => btn::CIRCLE,
        KeyCode::KeyA => btn::SQUARE,
        KeyCode::KeyS => btn::TRIANGLE,
        KeyCode::KeyQ => btn::LTRIGGER,
        KeyCode::KeyW => btn::RTRIGGER,
        KeyCode::Tab => btn::SELECT,
        KeyCode::Space => btn::START,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analog_center_matches_spec() {
        assert_eq!(analog_pack(0.0, 0.0), pocketjs_core::spec::ANALOG_CENTER);
    }

    #[test]
    fn analog_extremes_are_255_and_1_never_0() {
        assert_eq!(analog_pack(1.0, 1.0), (255 << 8) | 255);
        assert_eq!(analog_pack(-1.0, -1.0), (1 << 8) | 1);
        // Out-of-range input clamps instead of wrapping through 0.
        assert_eq!(analog_pack(-2.0, 2.0), (1 << 8) | 255);
    }

    #[test]
    fn pick_prefers_nearest_part() {
        let mut map = PartMap::default();
        let unit = (Vec3::splat(-1.0), Vec3::splat(1.0));
        map.push(PartShape {
            name: "far".into(),
            buttons: btn::CIRCLE,
            transform: Mat4::from_translation(Vec3::new(0.0, 0.0, -10.0)),
            aabb: unit,
        });
        let near = map.push(PartShape {
            name: "near".into(),
            buttons: btn::CROSS,
            transform: Mat4::IDENTITY,
            aabb: unit,
        });
        let (idx, _) = map.pick(Vec3::new(0.0, 0.0, 5.0), Vec3::NEG_Z).unwrap();
        assert_eq!(idx, near);
        assert_eq!(map.get(idx).unwrap().buttons, btn::CROSS);
    }

    #[test]
    fn pick_misses_cleanly() {
        let mut map = PartMap::default();
        map.push(PartShape {
            name: "box".into(),
            buttons: 0,
            transform: Mat4::IDENTITY,
            aabb: (Vec3::splat(-1.0), Vec3::splat(1.0)),
        });
        assert!(map.pick(Vec3::new(5.0, 5.0, 5.0), Vec3::NEG_Z).is_none());
    }
}
