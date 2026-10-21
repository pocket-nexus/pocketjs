pub const CHORD: u32 = 0x100 | 0x200 | 1; // L + R + SELECT, Vita controller bits.

#[derive(Default)]
pub struct Menu {
    pub visible: bool,
    previous: u32,
    swallow: bool,
}

#[derive(PartialEq, Debug)]
pub enum Action {
    None,
    Reload,
    Capture,
    Reset,
}

impl Menu {
    /// Consume the entire chord through release, before launcher SELECT handling.
    pub fn input(&mut self, buttons: u32) -> (u32, Action) {
        let edge = buttons & !self.previous;
        if buttons & CHORD == CHORD && self.previous & CHORD != CHORD {
            self.visible = !self.visible;
            self.swallow = true;
        }
        self.previous = buttons;
        if self.swallow {
            if buttons & CHORD == 0 {
                self.swallow = false;
            }
            return (0, Action::None);
        }
        if !self.visible {
            return (buttons, Action::None);
        }
        if edge & 0x2000 != 0 {
            self.visible = false;
        } // Circle
        let action = if edge & 0x4000 != 0 {
            Action::Reload
        } else if edge & 0x8000 != 0 {
            Action::Capture
        } else if edge & 0x1000 != 0 {
            Action::Reset
        } else {
            Action::None
        };
        (0, action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chord_never_leaks_select_to_the_launcher_and_rearms_after_release() {
        let mut menu = Menu::default();
        assert_eq!(menu.input(1), (1, Action::None));
        assert_eq!(menu.input(CHORD), (0, Action::None));
        assert!(menu.visible);
        assert_eq!(menu.input(CHORD), (0, Action::None));
        assert_eq!(menu.input(1), (0, Action::None));
        assert_eq!(menu.input(0), (0, Action::None));
        assert_eq!(menu.input(CHORD), (0, Action::None));
        assert!(!menu.visible);
        assert_eq!(menu.input(1), (0, Action::None));
        menu.input(0);
        assert_eq!(menu.input(1), (1, Action::None));
    }
    #[test]
    fn menu_actions_use_press_edges_and_consume_guest_input() {
        let mut menu = Menu::default();
        menu.input(CHORD);
        menu.input(0);
        assert_eq!(menu.input(0x4000), (0, Action::Reload));
        assert_eq!(menu.input(0x4000), (0, Action::None));
        menu.input(0);
        assert_eq!(menu.input(0x8000), (0, Action::Capture));
        menu.input(0);
        assert_eq!(menu.input(0x1000), (0, Action::Reset));
        menu.input(0);
        assert_eq!(menu.input(0x2000), (0, Action::None));
        assert!(!menu.visible);
    }
}
