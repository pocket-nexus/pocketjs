//! The retained raster target is owned by the display driver. Inkview copies
//! changed pixels before terminal wait; its panel refresh policy retains only
//! screen coordinates, never a borrow of the runtime's render target.
use crate::{framebuffer::FramebufferPipeline, offset_rects, refresh::Refresh, Geometry};
use pocket_drivers::*;
use std::{cell::RefCell, rc::Rc};

pub struct Panel {
    pub screen: inkview::screen::Screen<'static>,
    pub refresh: Refresh,
    pub geometry: Geometry,
    pub full: bool,
    pub flushes: u64,
}
impl Panel {
    pub fn idle(&mut self) {
        self.refresh.present(&mut self.screen, &[]);
    }
}
pub struct Display {
    panel: Rc<RefCell<Panel>>,
    pixels: FramebufferPipeline,
    size: [u32; 2],
    acquired: Option<Rect>,
    pending: Option<u64>,
    sequence: u64,
    generation: u64,
}
impl Display {
    pub fn new(panel: Rc<RefCell<Panel>>) -> Self {
        let geometry = &panel.borrow().geometry;
        let size = [geometry.render_w as u32, geometry.render_h as u32];
        let pixels =
            FramebufferPipeline::new(geometry.render_w, geometry.render_h, geometry.density);
        Self {
            panel: panel.clone(),
            pixels,
            size,
            acquired: None,
            pending: None,
            sequence: 0,
            generation: 0,
        }
    }
}
impl DisplayOutput for Display {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            self.size[0],
            self.size[1],
            PixelFormat::Rgba8888,
            self.size[0] as usize * 4,
            TargetOwnership::CpuVisible,
        );
        descriptor.partial_refresh = true;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        if self.panel.borrow().full {
            self.generation = self.generation.checked_add(1).ok_or(DisplayError::Failed)?;
        }
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: self.generation,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        let surface = self.pixels.surface(region)?;
        self.acquired = Some(region);
        Ok(Target::CpuVisible(surface))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<u64, DisplayError> {
        let valid = self.acquired.is_some_and(|a| {
            regions.iter().all(|r| {
                r.width > 0
                    && r.height > 0
                    && r.x >= a.x
                    && r.y >= a.y
                    && r.x.checked_add(r.width).is_some_and(|x| x <= a.x + a.width)
                    && r.y
                        .checked_add(r.height)
                        .is_some_and(|y| y <= a.y + a.height)
            })
        });
        if self.pending.is_some() || regions.is_empty() || !valid {
            return Err(DisplayError::InvalidTarget);
        }
        let sequence = self.sequence.checked_add(1).ok_or(DisplayError::Failed)?;
        let dirty = self.pixels.physical_diff(regions);
        let mut panel = self.panel.borrow_mut();
        let Panel {
            screen,
            refresh,
            geometry,
            full,
            flushes,
        } = &mut *panel;
        if *full {
            self.pixels.blit_all(screen, geometry);
            refresh.full(screen);
            self.pixels.advance_full();
            *full = false;
        } else if !dirty.is_empty() {
            self.pixels.blit_dirty(screen, &dirty, geometry);
            refresh.present(screen, &offset_rects(&dirty, geometry));
            self.pixels.advance(&dirty);
        } else {
            refresh.present(screen, &[]);
        }
        *flushes += 1;
        self.acquired = None;
        self.sequence = sequence;
        self.pending = Some(sequence);
        Ok(sequence)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        if self.pending != Some(token) {
            return Err(DisplayError::InvalidTarget);
        }
        self.pending = None;
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::Timer
    }
}
