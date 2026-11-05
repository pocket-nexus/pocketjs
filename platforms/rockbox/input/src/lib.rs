#![no_std]

/// Rockbox `button-target.h` bits for the nano 2G. The plugin passes
/// `button_status()` plus the wheel events it drained this frame.
pub mod button {
    pub const SELECT: u32 = 0x01;
    pub const MENU: u32 = 0x02;
    pub const LEFT: u32 = 0x04;
    pub const RIGHT: u32 = 0x08;
    pub const SCROLL_FWD: u32 = 0x10;
    pub const SCROLL_BACK: u32 = 0x20;
    pub const PLAY: u32 = 0x40;
}

/// The iPod nano mapping shared with the Pocket Stage profile and the MicroTS
/// playground: center CIRCLE, wheel UP/DOWN, previous/next LEFT/RIGHT,
/// Play/Pause START. MENU leaves the plugin and never reaches the app.
pub fn buttons(rockbox: u32) -> u32 {
    use pocket_spec::btn;
    let mut out = 0;
    if rockbox & button::SELECT != 0 {
        out |= btn::CIRCLE;
    }
    if rockbox & button::PLAY != 0 {
        out |= btn::START;
    }
    if rockbox & button::LEFT != 0 {
        out |= btn::LEFT;
    }
    if rockbox & button::RIGHT != 0 {
        out |= btn::RIGHT;
    }
    if rockbox & button::SCROLL_BACK != 0 {
        out |= btn::UP;
    }
    if rockbox & button::SCROLL_FWD != 0 {
        out |= btn::DOWN;
    }
    out
}
