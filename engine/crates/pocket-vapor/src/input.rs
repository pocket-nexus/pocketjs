use crate::Input;
use alloc::vec::Vec;

/// Every handler samples buttons, including inactive and idle frames, so a
/// latched handler observes an up frame before it can fire its first press.
#[derive(Clone, Copy, Debug)]
pub struct ButtonLatch {
    previous_buttons: u32,
}
impl ButtonLatch {
    pub const fn new(latched: bool) -> Self {
        Self {
            previous_buttons: if latched { u32::MAX } else { 0 },
        }
    }
    pub fn pending(&self, input: &Input, mask: u32) -> bool {
        input.buttons & !self.previous_buttons & mask != 0
    }
    pub fn sample(&mut self, input: &Input, mask: u32, active: bool) -> bool {
        let fire = self.pending(input, mask);
        self.previous_buttons = input.buttons;
        active && fire
    }
}

pub enum Dispatch<E> {
    Event(E),
    Slot(Input, usize),
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

pub trait EventSink<E> {
    fn push(&mut self, event: E);
    fn slot(&mut self, input: &Input, id: usize, cursor: &mut DispatchCursor) -> bool;
}
impl<E> EventSink<E> for Vec<E> {
    fn push(&mut self, event: E) {
        Vec::push(self, event);
    }
    fn slot(&mut self, _: &Input, _: usize, _: &mut DispatchCursor) -> bool {
        false
    }
}
pub struct DispatchFn<F>(F);
pub fn dispatch_fn<E, F: FnMut(Dispatch<E>, Option<&mut DispatchCursor>) -> bool>(
    callback: F,
) -> DispatchFn<F> {
    DispatchFn(callback)
}
impl<E, F: FnMut(Dispatch<E>, Option<&mut DispatchCursor>) -> bool> EventSink<E> for DispatchFn<F> {
    fn push(&mut self, event: E) {
        (self.0)(Dispatch::Event(event), None);
    }
    fn slot(&mut self, input: &Input, id: usize, cursor: &mut DispatchCursor) -> bool {
        (self.0)(Dispatch::Slot(*input, id), Some(cursor))
    }
}
