//! Runtime adapters for this compiled BG/OBJ program. The offline layer plan
//! produces native tiles; each prepared frame is bound to the exact DrawList
//! and resource revision that selected those tiles. Other lists are rejected.
use alloc::{rc::Rc, vec::Vec};
use core::cell::RefCell;
use pocket_drivers::*;
use pocketjs_gba::video::{OamBuffer, Presenter};

pub struct PreparedFrame {
    pub presenter: Option<Presenter>,
    pub oam: OamBuffer,
    pub uploads: Vec<(usize, &'static [u16])>,
    pub words: Vec<u32>,
    pub revision: u64,
    pub prepared: bool,
    next: u64,
    pending: Option<u64>,
    waited: bool,
    pub deadline: u32,
}
impl PreparedFrame {
    pub fn new() -> Rc<RefCell<Self>> {
        Rc::new(RefCell::new(Self {
            presenter: None,
            oam: OamBuffer::new(),
            uploads: Vec::new(),
            words: Vec::new(),
            revision: 0,
            prepared: false,
            next: 0,
            pending: None,
            waited: false,
            deadline: 0,
        }))
    }
}
pub struct CompiledRenderer(pub Rc<RefCell<PreparedFrame>>);
pub struct Lcd(pub Rc<RefCell<PreparedFrame>>);
impl Renderer for CompiledRenderer {
    type Submission = u64;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            TargetOwnership::DeviceOwned,
            Synchronization::Immediate,
            1,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<u64, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::InvalidFrame);
        };
        let mut state = self.0.try_borrow_mut().map_err(|_| RenderError::Failed)?;
        if target.handle != 1
            || target.region != Rect::new(0, 0, 240, 160)
            || target.format != PixelFormat::Rgb565
            || !state.prepared
            || state.pending.is_some()
            || frame.list.words != state.words
            || frame.resources.raster_revision() != state.revision
        {
            return Err(RenderError::InvalidFrame);
        }
        state.next = state.next.checked_add(1).ok_or(RenderError::Failed)?;
        state.pending = Some(state.next);
        state.prepared = false;
        state.waited = false;
        Ok(state.next)
    }
    fn wait(&mut self, token: &u64) -> Result<(), RenderError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| RenderError::Failed)?;
        if state.pending != Some(*token) {
            return Err(RenderError::InvalidFrame);
        }
        state.waited = true;
        Ok(())
    }
    fn retire(&mut self, token: u64) {
        let mut state = self.0.borrow_mut();
        if state.pending == Some(token) {
            state.pending = None;
        }
    }
}
impl DisplayOutput for Lcd {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            240,
            160,
            PixelFormat::Rgb565,
            480,
            TargetOwnership::DeviceOwned,
        );
        descriptor.vsync = VsyncSource::Display;
        descriptor
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if region != Rect::new(0, 0, 240, 160) || self.0.borrow().presenter.is_none() {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Target::DeviceOwned(DeviceTarget::new(
            1,
            region,
            PixelFormat::Rgb565,
        )))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| DisplayError::Failed)?;
        if !state.waited || state.pending.is_none() {
            return Err(DisplayError::InvalidTarget);
        }
        // Product initialization owns video registers and DMA3 for this program.
        // Each upload stalls the CPU until DMA completes; no frame data remains
        // referenced when flush returns.
        unsafe {
            if crate::diagnostic(4).wrapping_sub(state.deadline) as i32 >= 0 {
                crate::diag(7, crate::diagnostic(7).wrapping_add(1));
                state.deadline = crate::diagnostic(4).wrapping_add(1);
            }
            while (crate::diagnostic(4).wrapping_sub(state.deadline) as i32) < 0 {
                core::hint::spin_loop();
            }
            let begin = crate::cycles();
            let PreparedFrame {
                presenter,
                uploads,
                oam,
                ..
            } = &mut *state;
            let presenter = presenter.as_mut().ok_or(DisplayError::InvalidTarget)?;
            let mut transferred = 0;
            for (offset, tiles) in uploads.drain(..) {
                transferred += presenter
                    .upload_obj_tiles(offset, tiles)
                    .map_err(|_| DisplayError::Failed)?;
            }
            transferred += presenter.present(oam);
            presenter.enable();
            crate::diag(19, crate::cycles().wrapping_sub(begin));
            crate::diag(26, transferred as u32);
            crate::diag(27, crate::diagnostic(27).max(transferred as u32));
        }
        state.deadline = state.deadline.wrapping_add(2);
        state.waited = false;
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::Display
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Resources;
    impl RenderResources for Resources {
        fn viewport(&self) -> (f32, f32) {
            (240.0, 160.0)
        }
        fn raster_revision(&self) -> u64 {
            7
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            None
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    #[test]
    fn baked_renderer_rejects_unprepared_foreign_stale_or_changed_frames() {
        let shared = PreparedFrame::new();
        let mut renderer = CompiledRenderer(shared.clone());
        let mut lcd = Lcd(shared.clone());
        let list = DrawList::new();
        let mut frame = FrameInput::new(
            &list,
            &Resources,
            &[],
            Target::DeviceOwned(DeviceTarget::new(
                1,
                Rect::new(0, 0, 240, 160),
                PixelFormat::Rgb565,
            )),
        );
        assert_eq!(renderer.render(&mut frame), Err(RenderError::InvalidFrame));
        assert_eq!(lcd.flush(&[]), Err(DisplayError::InvalidTarget));
        shared.borrow_mut().prepared = true;
        assert_eq!(renderer.render(&mut frame), Err(RenderError::InvalidFrame));
        shared.borrow_mut().revision = 7;
        shared.borrow_mut().words.push(99);
        assert_eq!(renderer.render(&mut frame), Err(RenderError::InvalidFrame));
        shared.borrow_mut().words.clear();
        frame.target = Target::DeviceOwned(DeviceTarget::new(
            2,
            Rect::new(0, 0, 240, 160),
            PixelFormat::Rgb565,
        ));
        assert_eq!(renderer.render(&mut frame), Err(RenderError::InvalidFrame));
        frame.target = Target::DeviceOwned(DeviceTarget::new(
            1,
            Rect::new(0, 0, 240, 160),
            PixelFormat::Rgb565,
        ));
        let token = renderer.render(&mut frame).unwrap();
        assert_eq!(renderer.render(&mut frame), Err(RenderError::InvalidFrame));
        assert_eq!(renderer.wait(&(token + 1)), Err(RenderError::InvalidFrame));
        renderer.wait(&token).unwrap();
        renderer.retire(token + 1);
        assert!(shared.borrow().pending.is_some());
        renderer.retire(token);
        assert_eq!(renderer.wait(&token), Err(RenderError::InvalidFrame));
    }
}
