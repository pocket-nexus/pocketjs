//! Touch contacts between KeyOS input events and guest turns.
//!
//! gui-server delivers Press, Drag and Release events for platform touch ids;
//! the guest reads the set of held contacts once per turn. A contact that is
//! pressed and released between two turns stays in exactly one sample, so a
//! short tap reaches the guest. Each press receives a fresh 8-bit id that no
//! held contact or previous sample uses, as in hosts/shared/contact_latch.h.

/// Contacts one guest turn carries (framework/src/touch.ts).
pub const MAX_CONTACTS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Down,
    Move,
    Up,
}

#[derive(Clone, Copy, Debug)]
struct Contact {
    platform_id: usize,
    id: u8,
    x: i32,
    y: i32,
    ending: bool,
    sampled: bool,
}

#[derive(Default)]
pub struct Contacts {
    held: Vec<Contact>,
    previous: Vec<u8>,
    next_id: u8,
}

impl Contacts {
    /// Record one platform event at surface coordinates. Presses outside
    /// `width`×`height` are ignored; moves and releases outside it clamp.
    pub fn event(&mut self, phase: Phase, platform_id: usize, x: i32, y: i32, width: i32, height: i32) {
        let live = self.held.iter_mut().find(|c| !c.ending && c.platform_id == platform_id);
        match phase {
            Phase::Down => {
                if live.is_some() || x < 0 || y < 0 || x >= width || y >= height {
                    return;
                }
                if self.held.len() == MAX_CONTACTS {
                    // Reclaim a sampled release; never evict a held finger or
                    // an unsampled tap.
                    let Some(index) = self.held.iter().position(|c| c.ending && c.sampled) else {
                        return;
                    };
                    self.held.remove(index);
                }
                let id = self.fresh_id();
                self.held.push(Contact { platform_id, id, x, y, ending: false, sampled: false });
            }
            Phase::Move | Phase::Up => {
                if let Some(contact) = live {
                    contact.x = x.clamp(0, width - 1);
                    contact.y = y.clamp(0, height - 1);
                    contact.ending = phase == Phase::Up;
                }
            }
        }
    }

    /// Release every contact (the app was hidden or lost focus).
    pub fn cancel(&mut self) {
        self.held.clear();
    }

    /// Pack the contacts for one guest turn into `out` in the wide wire form
    /// (bit 31, id:8, y:10, x:10) and retire releases this turn has carried.
    pub fn sample(&mut self, out: &mut Vec<u32>) {
        self.held.retain(|c| !(c.ending && c.sampled));
        out.clear();
        for contact in &mut self.held {
            contact.sampled = true;
            out.push(
                0x8000_0000
                    | (u32::from(contact.id) << 20)
                    | ((contact.y as u32 & 0x3ff) << 10)
                    | (contact.x as u32 & 0x3ff),
            );
        }
        self.previous.clear();
        self.previous.extend(self.held.iter().map(|c| c.id));
    }

    fn fresh_id(&mut self) -> u8 {
        loop {
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1);
            let used = self.held.iter().any(|c| c.id == id) || self.previous.contains(&id);
            if !used {
                return id;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(contacts: &mut Contacts) -> Vec<u32> {
        let mut out = Vec::new();
        contacts.sample(&mut out);
        out
    }

    #[test]
    fn a_tap_between_turns_reaches_one_sample() {
        let mut contacts = Contacts::default();
        contacts.event(Phase::Down, 3, 10, 700, 480, 760);
        contacts.event(Phase::Up, 3, 12, 702, 480, 760);
        assert_eq!(sample(&mut contacts), vec![0x8000_0000 | (702 << 10) | 12]);
        assert!(sample(&mut contacts).is_empty());
    }

    #[test]
    fn a_new_press_does_not_reuse_the_previous_id() {
        let mut contacts = Contacts::default();
        contacts.event(Phase::Down, 0, 1, 1, 480, 760);
        let first = sample(&mut contacts)[0] >> 20 & 0xff;
        contacts.event(Phase::Up, 0, 1, 1, 480, 760);
        contacts.event(Phase::Down, 0, 2, 2, 480, 760);
        let ids: Vec<u32> = sample(&mut contacts).iter().map(|t| t >> 20 & 0xff).collect();
        assert_eq!(ids.len(), 1);
        assert_ne!(ids[0], first);
    }

    #[test]
    fn presses_outside_the_surface_are_ignored() {
        let mut contacts = Contacts::default();
        contacts.event(Phase::Down, 0, 5, 760, 480, 760);
        assert!(sample(&mut contacts).is_empty());
    }
}
