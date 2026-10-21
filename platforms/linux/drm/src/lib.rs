//! KMS display output. CPU targets are staging allocations, never live scanout.
//! Each private dumb buffer retains its corresponding staging buffer's history.
use pocket_drivers::{
    BufferIdentity, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, PixelFormat, Rect,
    Surface, Target, TargetOwnership, VsyncSource,
};
use std::io;

/// Copies the source before returning. Implementations own all scanout storage;
/// a page flip must not retain the borrowed CPU slice. `stop` is idempotent.
pub trait Scanout {
    fn present(&mut self, slot: usize, pixels: &[u8], damage: &[Rect]) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<()>;
    fn stop(&mut self);
}

pub struct Display<B: Scanout> {
    backend: B,
    size: [u32; 2],
    buffers: [Vec<u8>; 2],
    back: usize,
    sequence: u64,
    pending: Option<u64>,
    acquired: bool,
    failed: bool,
}
fn valid(region: Rect, size: [u32; 2]) -> bool {
    region.width > 0
        && region.height > 0
        && region
            .x
            .checked_add(region.width)
            .is_some_and(|x| x <= size[0])
        && region
            .y
            .checked_add(region.height)
            .is_some_and(|y| y <= size[1])
}
impl<B: Scanout> Display<B> {
    /// Backend starts with slot zero displayed, leaving slot one available.
    pub fn new(mut backend: B, size: [u32; 2]) -> io::Result<Self> {
        let allocate = || {
            let length = (size[0] as usize)
                .checked_mul(size[1] as usize)
                .and_then(|n| n.checked_mul(4))
                .filter(|n| *n > 0 && *n <= isize::MAX as usize)
                .ok_or_else(|| io::Error::other("invalid display size"))?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(length).map_err(io::Error::other)?;
            bytes.resize(length, 0);
            Ok::<_, io::Error>(bytes)
        };
        let buffers = match (allocate(), allocate()) {
            (Ok(a), Ok(b)) => [a, b],
            (a, b) => {
                backend.stop();
                return Err(a.err().or(b.err()).unwrap());
            }
        };
        Ok(Self {
            backend,
            size,
            buffers,
            back: 1,
            sequence: 0,
            pending: None,
            acquired: false,
            failed: false,
        })
    }
    fn fail(&mut self) {
        self.backend.stop();
        self.failed = true;
        self.pending = None;
        self.acquired = false;
    }
}
impl<B: Scanout> DisplayOutput for Display<B> {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut d = DisplayDescriptor::new(
            DisplayRole::Primary,
            self.size[0],
            self.size[1],
            PixelFormat::Argb8888,
            self.size[0] as usize * 4,
            TargetOwnership::CpuVisible,
        );
        d.double_buffered = true;
        d.vsync = VsyncSource::Display;
        d
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        if self.failed || self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Some(BufferIdentity {
            buffer: self.back as u64 + 1,
            generation: 0,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.failed || self.pending.is_some() || !valid(region, self.size) {
            return Err(DisplayError::InvalidTarget);
        }
        self.acquired = true;
        let stride = self.size[0] as usize * 4;
        let offset = region.y as usize * stride + region.x as usize * 4;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.buffers[self.back][offset..],
            region,
            stride,
            PixelFormat::Argb8888,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<u64, DisplayError> {
        if self.failed
            || self.pending.is_some()
            || !self.acquired
            || regions.is_empty()
            || regions.iter().any(|r| !valid(*r, self.size))
        {
            return Err(DisplayError::InvalidTarget);
        }
        let sequence = self.sequence.checked_add(1).ok_or(DisplayError::Failed)?;
        if self
            .backend
            .present(self.back, &self.buffers[self.back], regions)
            .is_err()
        {
            self.fail();
            return Err(DisplayError::Failed);
        }
        self.sequence = sequence;
        self.pending = Some(sequence);
        self.acquired = false;
        Ok(sequence)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        if self.pending != Some(token) {
            return Err(DisplayError::InvalidTarget);
        }
        if self.backend.wait().is_err() {
            self.fail();
            return Err(DisplayError::Failed);
        }
        self.pending = None;
        self.back ^= 1;
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::Display
    }
}
impl<B: Scanout> Drop for Display<B> {
    fn drop(&mut self) {
        self.backend.stop();
    }
}
#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
pub use native::{open, NativeScanout};

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    #[derive(Default)]
    struct State {
        slots: Vec<(usize, Vec<u8>)>,
        pending: bool,
        stopped: bool,
        fail_submit: bool,
        fail_wait: bool,
    }
    struct Fake(Rc<RefCell<State>>);
    impl Scanout for Fake {
        fn present(&mut self, slot: usize, bytes: &[u8], _: &[Rect]) -> io::Result<()> {
            let mut s = self.0.borrow_mut();
            assert!(!s.pending);
            s.pending = true;
            s.slots.push((slot, bytes.to_vec()));
            if s.fail_submit {
                Err(io::Error::other("submit"))
            } else {
                Ok(())
            }
        }
        fn wait(&mut self) -> io::Result<()> {
            let mut s = self.0.borrow_mut();
            if s.fail_wait {
                Err(io::Error::other("wait"))
            } else {
                s.pending = false;
                Ok(())
            }
        }
        fn stop(&mut self) {
            let mut s = self.0.borrow_mut();
            s.pending = false;
            s.stopped = true;
        }
    }
    fn fill(d: &mut Display<Fake>, byte: u8) -> u64 {
        let r = Rect::new(0, 0, 2, 2);
        let Target::CpuVisible(mut s) = d.acquire(r).unwrap() else {
            panic!()
        };
        s.pixels_mut().fill(byte);
        d.flush(&[r]).unwrap()
    }
    #[test]
    fn history_follows_back_buffer_and_wait_protects_reuse() {
        let state = Rc::new(RefCell::new(State::default()));
        let mut d = Display::new(Fake(state.clone()), [2, 2]).unwrap();
        let a = d.frame_identity().unwrap();
        let token = fill(&mut d, 7);
        assert!(d.acquire(Rect::new(0, 0, 1, 1)).is_err());
        assert!(d.wait(token + 1).is_err());
        assert!(state.borrow().pending);
        d.wait(token).unwrap();
        assert!(d.wait(token).is_err());
        assert_ne!(a, d.frame_identity().unwrap());
        let token = fill(&mut d, 9);
        d.wait(token).unwrap();
        assert_eq!(a, d.frame_identity().unwrap());
        assert_eq!(state.borrow().slots, [(1, vec![7; 16]), (0, vec![9; 16])]);
        let Target::CpuVisible(s) = d.acquire(Rect::new(0, 0, 2, 2)).unwrap() else {
            panic!()
        };
        assert_eq!(s.pixels(), &[7; 16]);
    }
    #[test]
    fn failed_submit_and_failed_wait_stop_before_return() {
        for fail_wait in [false, true] {
            let state = Rc::new(RefCell::new(State {
                fail_submit: !fail_wait,
                fail_wait,
                ..State::default()
            }));
            let mut d = Display::new(Fake(state.clone()), [1, 1]).unwrap();
            d.acquire(Rect::new(0, 0, 1, 1)).unwrap();
            let token = d.flush(&[Rect::new(0, 0, 1, 1)]);
            if fail_wait {
                assert!(d.wait(token.unwrap()).is_err());
            } else {
                assert!(token.is_err());
            }
            assert!(!state.borrow().pending);
            assert!(state.borrow().stopped);
            assert!(d.acquire(Rect::new(0, 0, 1, 1)).is_err());
        }
    }
    #[test]
    fn dropped_token_and_unwinding_stop_with_external_owner_alive() {
        let state = Rc::new(RefCell::new(State::default()));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut d = Display::new(Fake(state.clone()), [2, 2]).unwrap();
            fill(&mut d, 1);
            panic!("guest");
        }));
        assert!(state.borrow().stopped);
        assert!(!state.borrow().pending);
    }
}
