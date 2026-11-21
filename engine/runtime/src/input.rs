//! The single encoder for the existing eight-argument guest frame.
use crate::RuntimeError;
use alloc::vec::Vec;
use pocket_drivers::{Contact, InputFrame};
use pocketjs_core::Ui;

#[derive(Clone, Copy)]
struct Capture {
    surface: u32,
    source_id: u32,
    wire_id: u8,
    hit: i32,
}
#[derive(Default)]
pub struct InputEncoder {
    captures: Vec<Capture>,
    next_id: u8,
}
pub struct EncodedInput {
    pub buttons: u32,
    pub analog: u32,
    pub right_analog: u32,
    pub touches: Vec<u32>,
    pub hits: Vec<i32>,
    pub surfaces: Vec<u8>,
}
impl InputEncoder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn encode(
        &mut self,
        ui: &mut Ui,
        frame: &InputFrame<'_>,
    ) -> Result<EncodedInput, RuntimeError> {
        if frame.axes.iter().any(|axis| !axis.value.is_finite()) {
            return Err(RuntimeError::InvalidInput);
        }
        let mut contacts: Vec<Contact> = frame
            .contacts
            .iter()
            .copied()
            .filter(|c| !c.cancelled)
            .collect();
        if let Some(pointer) = frame.pointer {
            if !pointer.x.is_finite()
                || !pointer.y.is_finite()
                || pointer.surface > 1
                || (pointer.surface == 1 && ui.auxiliary_viewport().is_none())
            {
                return Err(RuntimeError::InvalidInput);
            }
            if pointer.buttons & 1 != 0 {
                contacts.push(Contact {
                    surface: pointer.surface,
                    id: u32::MAX,
                    x: pointer.x,
                    y: pointer.y,
                    cancelled: false,
                });
            }
        }
        if contacts.len() > 8 {
            return Err(RuntimeError::InvalidInput);
        }
        for (i, c) in contacts.iter().enumerate() {
            if c.surface > 1
                || (c.surface == 1 && ui.auxiliary_viewport().is_none())
                || !c.x.is_finite()
                || !c.y.is_finite()
                || contacts[..i]
                    .iter()
                    .any(|other| other.surface == c.surface && other.id == c.id)
            {
                return Err(RuntimeError::InvalidInput);
            }
        }
        // No fallible input validation follows this point.
        if let Some(pointer) = frame.pointer {
            // The current UI cursor belongs to the primary display. Auxiliary
            // pointers still contribute surface-scoped contact events.
            if pointer.surface == 0 {
                ui.set_cursor_pos(pointer.x, pointer.y);
            }
        }
        let mut out = EncodedInput {
            buttons: frame.buttons,
            analog: 0x8080,
            right_analog: 0x8080,
            touches: Vec::with_capacity(16),
            hits: Vec::with_capacity(16),
            surfaces: Vec::with_capacity(16),
        };
        let mut cancelled = Vec::new();
        for capture in &self.captures {
            if frame
                .cancelled
                .iter()
                .any(|c| c.surface == capture.surface && c.id == capture.source_id)
                || frame.contacts.iter().any(|c| {
                    c.cancelled && c.surface == capture.surface && c.id == capture.source_id
                })
            {
                cancelled.push(*capture);
            }
        }
        contacts.retain(|c| {
            !cancelled
                .iter()
                .any(|old| old.surface == c.surface && old.source_id == c.id)
        });
        self.captures.retain(|old| {
            contacts
                .iter()
                .any(|c| old.surface == c.surface && old.source_id == c.id)
        });
        for c in &contacts {
            let capture = match self
                .captures
                .iter()
                .find(|old| old.surface == c.surface && old.source_id == c.id)
            {
                Some(old) => *old,
                None => {
                    // Pure 8-bit streams preserve their existing ids. Wider
                    // identities receive an unused wire id for their lifetime;
                    // a later native id collision receives another wire id.
                    // Reserve all native ids in this sample before assigning
                    // a new wider identity, regardless of contact order.
                    let mut wire_id = if c.id <= 255 {
                        c.id as u8
                    } else {
                        self.next_id
                    };
                    while self
                        .captures
                        .iter()
                        .chain(cancelled.iter())
                        .any(|old| old.surface == c.surface && old.wire_id == wire_id)
                        || contacts.iter().any(|other| {
                            other.surface == c.surface
                                && other.id <= 255
                                && other.id != c.id
                                && other.id as u8 == wire_id
                        })
                    {
                        wire_id = wire_id.wrapping_add(1);
                    }
                    self.next_id = wire_id.wrapping_add(1);
                    let hit = if c.surface == 0 {
                        ui.hit_test_bounds(c.x, c.y)
                    } else {
                        ui.hit_test_bounds_auxiliary(c.x, c.y)
                    };
                    let capture = Capture {
                        surface: c.surface,
                        source_id: c.id,
                        wire_id,
                        hit,
                    };
                    self.captures.push(capture);
                    capture
                }
            };
            let x = c.x.clamp(0.0, 1023.0) as u32;
            let y = c.y.clamp(0.0, 1023.0) as u32;
            let word = if x > 511 || y > 511 {
                0x8000_0000 | ((capture.wire_id as u32) << 20) | (y << 10) | x
            } else {
                ((capture.wire_id as u32) << 18) | (y << 9) | x
            };
            out.touches.push(word);
            out.hits.push(capture.hit);
            out.surfaces.push(c.surface as u8);
        }
        for capture in cancelled {
            out.touches
                .push(0x4000_0000 | ((capture.wire_id as u32) << 18));
            out.hits.push(0);
            out.surfaces.push(capture.surface as u8);
        }
        let mut axes = [128u32; 4];
        for axis in frame.axes {
            if let Some(value) = axes.get_mut(axis.id as usize) {
                *value = axis.value.clamp(0.0, 255.0) as u32;
            }
        }
        out.analog = (axes[0] << 8) | axes[1];
        out.right_analog = (axes[2] << 8) | axes[3];
        Ok(out)
    }
}
