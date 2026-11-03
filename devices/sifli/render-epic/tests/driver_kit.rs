//! pocket-driver-kit lifecycle audit of the deferred EPIC renderer. The
//! executor records calls: `end` between render and the return of `wait` is
//! the completion probe and
//! `release_texture` the release probe. It does not emulate EPIC hardware.
use std::{cell::RefCell, rc::Rc};

use pocket_driver_kit::test_device::{scene, Resources, HEIGHT, WIDTH};
use pocket_driver_kit::{Event, Lifecycle};
use pocket_drivers::{DeviceTarget, FrameInput, PixelFormat, Rect as Region, Renderer, Target};
use pocket_render_sifli_epic::{
    Capabilities, Cmd, EpicRenderer, ExecError, Executor, MaskId, RendererConfig, TextureSource,
    Thresholds, TileId,
};

#[derive(Default)]
struct Calls {
    ends: usize,
    registered: usize,
    released: usize,
}
struct Recording {
    calls: Rc<RefCell<Calls>>,
    tile: Vec<u16>,
    mask: Vec<u8>,
}
impl Executor for Recording {
    fn caps(&self) -> Capabilities {
        Capabilities {
            fill_opaque: true,
            fill_alpha: false,
            a8_blend: false,
            gradient: false,
            blit: true,
            blit_mirror_y: true,
            blit_quad: false,
            blit_rotate: false,
            blit_modulate: false,
            portable_textures: true,
            coordinate_limit: 505,
            mask_bytes: 64,
            tile_pixels: 64,
            thresholds: Thresholds {
                min_fill: 1,
                min_gradient: 1,
                min_blend: 1,
                min_blit: 1,
            },
        }
    }
    fn begin(&mut self, _: u64, _: u32, _: u32) -> Result<(), ExecError> {
        Ok(())
    }
    fn submit(&mut self, _: &[Cmd]) -> Result<(), ExecError> {
        Ok(())
    }
    fn fence(&mut self) -> Result<(), ExecError> {
        Ok(())
    }
    fn end(&mut self) -> Result<(), ExecError> {
        self.calls.borrow_mut().ends += 1;
        Ok(())
    }
    fn mask_mut(&mut self, _: MaskId) -> &mut [u8] {
        &mut self.mask
    }
    fn tile_mut(&mut self, _: TileId) -> &mut [u16] {
        &mut self.tile
    }
    unsafe fn register_texture(&mut self, _: &TextureSource<'_>) -> Result<u32, ExecError> {
        let mut calls = self.calls.borrow_mut();
        calls.registered += 1;
        Ok(calls.registered as u32)
    }
    fn release_texture(&mut self, _: u32) {
        self.calls.borrow_mut().released += 1;
    }
}

#[test]
fn render_wait_retire_and_destroy_pass_the_lifecycle_audit() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let executor = Recording {
        calls: calls.clone(),
        tile: vec![0; 64],
        mask: vec![0; 64],
    };
    let config = RendererConfig {
        scale: 1,
        max_textures: 4,
    };
    let mut renderer = EpicRenderer::new(config, None, executor).unwrap();
    let list = scene();
    let region = Region::new(0, 0, WIDTH, HEIGHT);
    let buffer = 1;
    let mut audit = Lifecycle::new(8);
    for frame in 1..=2u64 {
        let resources = Resources::new(frame, frame as u8);
        audit.observe(Event::Acquire(buffer)).unwrap();
        let target = DeviceTarget::new(buffer, region, PixelFormat::Rgb565);
        // The executor may complete the work at render or at wait.
        let ends = calls.borrow().ends;
        let submission = renderer
            .render(&mut FrameInput::new(
                &list,
                &resources,
                &[region],
                Target::DeviceOwned(target),
            ))
            .unwrap();
        audit
            .observe(Event::Render {
                submission: frame,
                buffer,
            })
            .unwrap();
        audit
            .observe(Event::UseResource {
                submission: frame,
                resource: frame,
            })
            .unwrap();
        renderer.wait(&submission).unwrap();
        if calls.borrow().ends > ends {
            audit.observe(Event::RenderStopped(frame)).unwrap();
        }
        audit
            .observe(Event::RenderWaited {
                submission: frame,
                failed: false,
            })
            .unwrap();
        renderer.retire(submission);
        audit.observe(Event::Retire(frame)).unwrap();
        audit.observe(Event::FrameEnd { failed: false }).unwrap();
    }
    drop(renderer);
    let calls = calls.borrow();
    assert!(calls.registered >= 1);
    assert_eq!(calls.released, calls.registered);
    for version in 1..=2 {
        audit.observe(Event::ReleaseResource(version)).unwrap();
    }
    audit.observe(Event::Destroy).unwrap();
    audit.finish().unwrap();
}
