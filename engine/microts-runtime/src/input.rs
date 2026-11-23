use crate::Input;
use alloc::vec::Vec;

/// What a button handler delivers on one frame. Each carries the buttons that
/// changed or stay held this frame; the handler also receives `Input::buttons`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonEvent {
    None,
    /// Buttons that went down this frame, every button and not only the handler's.
    Press(u32),
    /// The handler's button is still down `hold_ms` after its accepted press, or
    /// one `repeat_ms` interval after the previous hold.
    Hold(u32),
    /// Buttons that went up this frame; the handler's button is among them.
    Release(u32),
}
impl ButtonEvent {
    /// The buttons the event carries; 0 for `None`.
    pub const fn buttons(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Press(buttons) | Self::Hold(buttons) | Self::Release(buttons) => buttons,
        }
    }
}

/// One `ActionHandler`'s button state. Every handler samples buttons,
/// including inactive and idle frames, so a latched handler observes an up
/// frame before it can fire its first press.
///
/// A press that the handler accepts (active, with an up-to-down edge) arms it:
/// the release of that button is delivered even if the handler has become
/// inactive since, and holds are scheduled on the model clock (`Input::now_ms`)
/// while the handler is active. Sampling one input twice delivers nothing the
/// second time, so a dispatch walk can resume after a handler.
#[derive(Clone, Copy, Debug)]
pub struct ButtonLatch {
    previous_buttons: u32,
    armed: u32,
    hold_at: f64,
    last_event_ms: f64,
}
impl ButtonLatch {
    pub const fn new(latched: bool) -> Self {
        Self {
            previous_buttons: if latched { u32::MAX } else { 0 },
            armed: 0,
            hold_at: f64::INFINITY,
            last_event_ms: f64::NEG_INFINITY,
        }
    }
    /// Whether `sample` can deliver an event for `button` (one `btn` bit) on this input.
    pub fn pending(&self, input: &Input, button: u32) -> bool {
        input.buttons & !self.previous_buttons & button != 0
            || self.armed & !input.buttons != 0
            || self.hold_due(input)
    }
    fn hold_due(&self, input: &Input) -> bool {
        self.armed != 0 && input.now_ms >= self.hold_at && input.now_ms > self.last_event_ms
    }
    /// Advance to `input` and return the event for `button`. `hold_ms` schedules
    /// the first hold at an accepted press and `repeat_ms` each following hold;
    /// `None` schedules none. A hold fires at most once per frame, on the first
    /// frame whose time reaches its deadline; a frame later than a whole
    /// interval does not queue the intervals it skipped.
    pub fn sample(
        &mut self,
        input: &Input,
        button: u32,
        active: bool,
        hold_ms: Option<f64>,
        repeat_ms: Option<f64>,
    ) -> ButtonEvent {
        let now = input.now_ms;
        let pressed = input.buttons & !self.previous_buttons;
        let released = self.previous_buttons & !input.buttons;
        self.previous_buttons = input.buttons;
        if self.armed & !input.buttons != 0 {
            self.armed &= input.buttons;
            self.hold_at = f64::INFINITY;
            return ButtonEvent::Release(released);
        }
        if !active {
            return ButtonEvent::None;
        }
        if pressed & button != 0 {
            self.armed |= pressed & button;
            self.hold_at = hold_ms.map_or(f64::INFINITY, |delay| now + delay);
            self.last_event_ms = now;
            return ButtonEvent::Press(pressed);
        }
        if self.hold_due(input) {
            self.hold_at = repeat_ms.map_or(f64::INFINITY, |interval| {
                let next = self.hold_at + interval;
                if next > now {
                    next
                } else {
                    now + interval
                }
            });
            self.last_event_ms = now;
            return ButtonEvent::Hold(self.armed);
        }
        ButtonEvent::None
    }
}

pub enum Dispatch<E, S = ()> {
    Event(E),
    Slot(Input, usize),
    ScopedSlot(S),
}

/// Resume a document-order walk after each handler without retaining borrowed
/// props or row values across an event that can mutate an ancestor model.
#[derive(Clone, Copy, Debug, Default)]
pub struct DispatchCursor {
    scan: usize,
    next: usize,
}
impl DispatchCursor {
    pub const fn new() -> Self {
        Self { scan: 0, next: 0 }
    }
    pub fn restart(&mut self) {
        self.scan = 0;
    }
    pub fn completed_offset(&self) -> usize {
        self.next.saturating_sub(self.scan)
    }
    pub fn visit(&mut self) -> bool {
        let ordinal = self.scan;
        self.scan = self.scan.saturating_add(1);
        if ordinal < self.next {
            return false;
        }
        self.next = self.scan;
        true
    }
    pub fn skip(&mut self, count: usize) {
        self.scan = self.scan.saturating_add(count);
        self.next = self.next.max(self.scan);
    }
    pub fn skip_completed(&mut self, count: usize) -> bool {
        let end = self.scan.saturating_add(count);
        if end > self.next {
            return false;
        }
        self.scan = end;
        true
    }
}

pub trait EventSink<E, S = ()> {
    fn push(&mut self, event: E);
    fn slot(&mut self, input: &Input, id: usize, cursor: &mut DispatchCursor) -> bool;
    /// Scoped argument payloads exist only during this dispatch step.
    fn slot_event(&mut self, _event: S, _cursor: &mut DispatchCursor) -> bool {
        false
    }
}
impl<E, S> EventSink<E, S> for Vec<E> {
    fn push(&mut self, event: E) {
        Vec::push(self, event);
    }
    fn slot(&mut self, _: &Input, _: usize, _: &mut DispatchCursor) -> bool {
        false
    }
}
pub struct DispatchFn<F>(F);
pub fn dispatch_fn<E, S, F: FnMut(Dispatch<E, S>, Option<&mut DispatchCursor>) -> bool>(
    callback: F,
) -> DispatchFn<F> {
    DispatchFn(callback)
}
impl<E, S, F: FnMut(Dispatch<E, S>, Option<&mut DispatchCursor>) -> bool> EventSink<E, S> for DispatchFn<F> {
    fn push(&mut self, event: E) {
        (self.0)(Dispatch::Event(event), None);
    }
    fn slot(&mut self, input: &Input, id: usize, cursor: &mut DispatchCursor) -> bool {
        (self.0)(Dispatch::Slot(*input, id), Some(cursor))
    }
    fn slot_event(&mut self, event: S, cursor: &mut DispatchCursor) -> bool {
        (self.0)(Dispatch::ScopedSlot(event), Some(cursor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::btn::{CIRCLE, CROSS, SQUARE};
    use ButtonEvent::{Hold, Press, Release};

    const NONE: ButtonEvent = ButtonEvent::None;
    const HOLD: Option<f64> = Some(500.0);
    const REPEAT: Option<f64> = Some(100.0);

    fn at(buttons: u32, now_ms: f64) -> Input {
        Input {
            buttons,
            now_ms,
            ..Input::default()
        }
    }
    /// Sample CROSS with a 500 ms hold and a 100 ms repeat.
    fn step(latch: &mut ButtonLatch, buttons: u32, now_ms: f64, active: bool) -> ButtonEvent {
        latch.sample(&at(buttons, now_ms), CROSS, active, HOLD, REPEAT)
    }

    #[test]
    fn a_press_pairs_with_its_release_and_resampling_delivers_nothing() {
        let mut latch = ButtonLatch::new(false);
        let down = at(CROSS | CIRCLE, 0.0);
        assert!(latch.pending(&down, CROSS));
        let none = None;
        assert_eq!(
            latch.sample(&down, CROSS, true, none, none),
            Press(CROSS | CIRCLE)
        );
        assert_eq!(latch.sample(&down, CROSS, true, none, none), NONE);
        assert!(!latch.pending(&at(CROSS, 20.0), CROSS));
        assert_eq!(
            latch.sample(&at(CROSS, 20.0), CROSS, true, none, none),
            NONE
        );
        let up = at(0, 40.0);
        assert!(latch.pending(&up, CROSS));
        assert_eq!(latch.sample(&up, CROSS, false, none, none), Release(CROSS));
        assert!(!latch.pending(&up, CROSS));
        assert_eq!(latch.sample(&up, CROSS, true, none, none), NONE);
        assert_eq!(Release(CROSS).buttons(), CROSS);
    }

    #[test]
    fn an_ignored_press_has_no_release_and_latched_waits_for_an_up_frame() {
        let mut inactive = ButtonLatch::new(false);
        assert_eq!(step(&mut inactive, CROSS, 0.0, false), NONE);
        assert_eq!(step(&mut inactive, CROSS, 600.0, true), NONE);
        assert!(!inactive.pending(&at(0, 700.0), CROSS));
        let mut latched = ButtonLatch::new(true);
        assert!(!latched.pending(&at(CROSS, 0.0), CROSS));
        assert_eq!(step(&mut latched, CROSS, 0.0, true), NONE);
        assert_eq!(step(&mut latched, 0, 20.0, true), NONE);
        assert_eq!(step(&mut latched, CROSS, 40.0, true), Press(CROSS));
    }

    #[test]
    fn holds_fire_on_the_model_clock_once_per_frame_and_repeat_without_backlog() {
        let mut latch = ButtonLatch::new(false);
        assert_eq!(step(&mut latch, CROSS, 1000.0, true), Press(CROSS));
        assert!(!latch.pending(&at(CROSS, 1499.0), CROSS));
        let first = at(CROSS | SQUARE, 1500.0);
        assert!(latch.pending(&first, CROSS));
        assert_eq!(latch.sample(&first, CROSS, true, HOLD, REPEAT), Hold(CROSS));
        assert!(!latch.pending(&first, CROSS));
        assert_eq!(step(&mut latch, CROSS, 1600.0, true), Hold(CROSS));
        // A late frame fires once; the next repeat is one interval after it.
        assert_eq!(step(&mut latch, CROSS, 1950.0, true), Hold(CROSS));
        assert!(!latch.pending(&at(CROSS, 2049.0), CROSS));
        // Inactive frames skip holds; the release still reaches the handler.
        assert_eq!(step(&mut latch, CROSS, 2050.0, false), NONE);
        assert_eq!(step(&mut latch, 0, 2100.0, false), Release(CROSS));
        assert!(!latch.pending(&at(0, 3000.0), CROSS));
    }

    #[test]
    fn a_hold_never_fires_on_its_press_frame_and_without_repeat_fires_once() {
        let mut latch = ButtonLatch::new(false);
        let now = Some(0.0);
        assert_eq!(
            latch.sample(&at(CROSS, 0.0), CROSS, true, now, None),
            Press(CROSS)
        );
        assert!(!latch.pending(&at(CROSS, 0.0), CROSS));
        assert_eq!(
            latch.sample(&at(CROSS, 20.0), CROSS, true, now, None),
            Hold(CROSS)
        );
        assert!(!latch.pending(&at(CROSS, 5000.0), CROSS));
    }
}
