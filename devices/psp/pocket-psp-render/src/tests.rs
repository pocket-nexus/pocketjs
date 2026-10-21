use super::*;
extern crate std;
use alloc::{vec, vec::Vec};
use pocket_drivers::{DamageRect, DrawList, FontView, RenderResources, TexView};
#[derive(Default)]
struct State {
    begins: usize,
    draws: Vec<(Primitive, Vec<u8>)>,
    pointers: Vec<(*const u8, usize)>,
    textures: Vec<TextureBinding>,
    texture_reads: Vec<(*const u8, Vec<u8>)>,
    publications: Vec<(*const u8, usize)>,
    clips: Vec<DamageRect>,
    waits: usize,
    presents: usize,
    stop: usize,
    fail: bool,
    panic_draw: bool,
    panic_wait: bool,
}
struct Mock(Rc<RefCell<State>>);
unsafe impl Device for Mock {
    fn begin(&mut self) -> Result<(), RenderError> {
        self.0.borrow_mut().begins += 1;
        Ok(())
    }
    fn begin_pass(&mut self, _: bool) {}
    fn clip(&mut self, clip: DamageRect) {
        self.0.borrow_mut().clips.push(clip);
    }
    unsafe fn publish(&mut self, pointer: *const u8, bytes: usize) {
        self.0.borrow_mut().publications.push((pointer, bytes));
    }
    unsafe fn bind(&mut self, t: Option<TextureBinding>) {
        if let Some(t) = t {
            let mut state = self.0.borrow_mut();
            state.textures.push(t);
            state.texture_reads.push((
                t.pixels,
                core::slice::from_raw_parts(t.pixels, t.bytes).to_vec(),
            ));
        }
    }
    unsafe fn draw(&mut self, p: Primitive, v: Vertices<'_>) {
        let (pointer, bytes) = match v {
            Vertices::Colored(v) => (v.as_ptr().cast::<u8>(), core::mem::size_of_val(v)),
            Vertices::Textured(v) => (v.as_ptr().cast::<u8>(), core::mem::size_of_val(v)),
        };
        let mut s = self.0.borrow_mut();
        s.draws
            .push((p, core::slice::from_raw_parts(pointer, bytes).to_vec()));
        s.pointers.push((pointer, bytes));
        assert!(!core::mem::take(&mut s.panic_draw), "native draw panic");
    }
    fn end_pass(&mut self) {}
    fn finish(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    fn wait(&mut self) -> Result<(), RenderError> {
        let mut s = self.0.borrow_mut();
        s.waits += 1;
        assert!(!core::mem::take(&mut s.panic_wait), "native wait panic");
        for (i, (p, n)) in s.pointers.iter().enumerate() {
            assert_eq!(unsafe { core::slice::from_raw_parts(*p, *n) }, s.draws[i].1);
        }
        for (pointer, bytes) in &s.texture_reads {
            assert_eq!(
                unsafe { core::slice::from_raw_parts(*pointer, bytes.len()) },
                bytes
            );
        }
        s.texture_reads.clear();
        s.pointers.clear();
        s.draws.clear();
        if s.fail {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn present(&mut self) -> Result<(), DisplayError> {
        self.0.borrow_mut().presents += 1;
        Ok(())
    }
    fn stop(&mut self) {
        let _ = self.wait();
        self.0.borrow_mut().stop += 1;
    }
}
struct Resources {
    pixels: Vec<u8>,
    font: Vec<u8>,
    revision: u64,
}
impl Default for Resources {
    fn default() -> Self {
        Self {
            pixels: vec![1; 256],
            font: vec![255; 8],
            revision: 1,
        }
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (480.0, 272.0)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        (handle == 7).then_some(TexView {
            pixels: &self.pixels,
            w: 8,
            h: 8,
            psm: 3,
            palette: None,
            linear: false,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        (slot == 0).then_some(FontView {
            bitmap: &self.font,
            cell_w: 2,
            cell_h: 2,
            raster_density: 1,
            glyph_count: 2,
        })
    }
}
fn create() -> (GeRenderer<Mock>, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State::default()));
    (
        GeRenderer::new(Mock(state.clone()), Config::psp()).unwrap(),
        state,
    )
}
fn list(words: Vec<u32>) -> DrawList {
    DrawList {
        words,
        ..DrawList::default()
    }
}
fn xy(x: i16, y: i16) -> u32 {
    u32::from(x as u16) | (u32::from(y as u16) << 16)
}
fn texture() -> Vec<u32> {
    vec![
        pocket_spec::draw_op::TEX_QUAD,
        7,
        xy(3, 4),
        xy(8, 8),
        0,
        0,
        1f32.to_bits(),
        1f32.to_bits(),
        u32::MAX,
    ]
}
#[test]
fn normal_render_owns_texture_and_geometry_until_terminal_retirement() {
    let (mut r, state) = create();
    let mut resources = Resources::default();
    let words = list(texture());
    let target = r.target();
    let mut frame = FrameInput::new(&words, &resources, &[], Target::DeviceOwned(target));
    let id = r.render(&mut frame).unwrap();
    let binding = state.borrow().textures[0];
    assert_ne!(binding.pixels, resources.pixels.as_ptr());
    resources.pixels.fill(9);
    assert_eq!(
        unsafe { core::slice::from_raw_parts(binding.pixels, 256) },
        [1; 256]
    );
    assert!(r.resident_bytes() > 0);
    r.wait(&id).unwrap();
    r.retire(id);
    let used = r.resident_bytes();
    assert!(used > 0);
    let target = r.target();
    let mut frame = FrameInput::new(&words, &resources, &[], Target::DeviceOwned(target));
    let next = r.render(&mut frame).unwrap();
    r.retire(next);
    assert_eq!(r.resident_bytes(), used);
    assert_eq!(state.borrow().waits, 2);
}
#[test]
fn validates_foreign_targets_and_complete_stream_before_native_begin() {
    let (mut r, state) = create();
    let (other, _) = create();
    let resources = Resources::default();
    let words = list(vec![
        pocket_spec::draw_op::RECT,
        0,
        xy(1, 1),
        u32::MAX,
        pocket_spec::draw_op::TEX_QUAD,
    ]);
    let own = r.target();
    for target in [other.target(), own] {
        let mut frame = FrameInput::new(&words, &resources, &[], Target::DeviceOwned(target));
        assert_eq!(r.render(&mut frame), Err(RenderError::InvalidFrame));
    }
    assert_eq!(state.borrow().begins, 0);
}
#[test]
fn unsupported_operations_are_rejected_even_when_clipped_out() {
    let (mut r, state) = create();
    let resources = Resources::default();
    let mut surface = texture();
    surface[0] = pocket_spec::draw_op::SURFACE_QUAD;
    let text = vec![pocket_spec::draw_op::TEXT_RUN, 0, 0, 0, 0, 0, 0, 0];
    for operation in [surface, text] {
        let mut words = vec![pocket_spec::draw_op::SCISSOR, xy(500, 300), xy(1, 1)];
        words.extend(operation);
        words.push(pocket_spec::draw_op::SCISSOR_POP);
        let words = list(words);
        let mut frame = FrameInput::new(&words, &resources, &[], Target::DeviceOwned(r.target()));
        assert_eq!(r.render(&mut frame), Err(RenderError::Unsupported));
    }
    assert_eq!(state.borrow().begins, 0);
}
#[test]
fn batches_sprites_and_preserves_gradient_strip_and_triangle_order() {
    let (mut r, state) = create();
    let res = Resources::default();
    let words = list(vec![
        1,
        0,
        xy(2, 2),
        1,
        1,
        xy(2, 0),
        xy(2, 2),
        2,
        pocket_spec::draw_op::GRAD_RECT,
        0,
        xy(3, 3),
        10,
        20,
        0,
        pocket_spec::draw_op::TRI,
        0,
        xy(1, 0),
        xy(0, 1),
        10,
        20,
        30,
    ]);
    let target = r.target();
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
    let id = r.render(&mut frame).unwrap();
    let s = state.borrow();
    assert_eq!(s.draws.len(), 3);
    assert_eq!(s.draws[0].0, Primitive::Sprites);
    assert_eq!(s.draws[0].1.len(), 4 * 12);
    assert_eq!(s.draws[1].0, Primitive::TriangleStrip);
    assert_eq!(s.draws[2].0, Primitive::Triangles);
    drop(s);
    r.retire(id);
}
#[test]
fn empty_clip_skips_geometry_and_invalid_native_scissors() {
    let (mut r, state) = create();
    let res = Resources::default();
    let words = list(vec![
        pocket_spec::draw_op::SCISSOR,
        xy(500, 300),
        xy(20, 20),
        pocket_spec::draw_op::RECT,
        0,
        xy(10, 10),
        u32::MAX,
        pocket_spec::draw_op::SCISSOR_POP,
        pocket_spec::draw_op::RECT,
        0,
        xy(10, 10),
        u32::MAX,
    ]);
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(r.target()));
    let id = r.render(&mut frame).unwrap();
    assert_eq!(state.borrow().draws.len(), 1);
    assert!(state.borrow().clips.iter().all(|clip| !clip.is_empty()));
    r.retire(id);
}
#[test]
fn terminal_failure_and_early_retire_release_only_after_wait() {
    let (mut r, state) = create();
    let res = Resources::default();
    let words = list(texture());
    let target = r.target();
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
    let id = r.render(&mut frame).unwrap();
    state.borrow_mut().fail = true;
    assert_eq!(r.wait(&id), Err(RenderError::Failed));
    r.retire(id);
    assert_eq!(state.borrow().waits, 1);
    state.borrow_mut().fail = false;
    let target = r.target();
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
    let id = r.render(&mut frame).unwrap();
    r.retire(id);
    assert_eq!(state.borrow().waits, 2);
}
#[test]
fn display_and_renderer_drop_stop_even_when_host_retains_clone() {
    let (r, state) = create();
    let mut shared = SharedRenderer::new(r);
    let host = shared.clone();
    let mut display = GeDisplay::new(shared.clone());
    let res = Resources::default();
    let words = list(texture());
    let region = Rect::new(0, 0, 480, 272);
    let target = display.acquire(region).unwrap();
    let damage = [region];
    let mut frame = FrameInput::new(&words, &res, &damage, target);
    let id = shared.render(&mut frame).unwrap();
    shared.wait(&id).unwrap();
    let token = display.flush(&[region]).unwrap();
    display.wait(token).unwrap();
    shared.retire(id);
    assert_eq!(state.borrow().presents, 1);
    let target = display.acquire(region).unwrap();
    let mut frame = FrameInput::new(&words, &res, &[], target);
    shared.render(&mut frame).unwrap();
    drop(shared);
    assert!(state.borrow().stop > 0);
    assert!(host.0.borrow().pending.is_none());
}
#[test]
fn shared_drop_stops_work_after_native_encode_or_wait_panic() {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    for during_draw in [true, false] {
        let (r, state) = create();
        let mut shared = SharedRenderer::new(r);
        let host = shared.clone();
        let res = Resources::default();
        let words = list(texture());
        let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(shared.target()));
        state.borrow_mut().panic_draw = during_draw;
        state.borrow_mut().panic_wait = !during_draw;
        assert!(catch_unwind(AssertUnwindSafe(|| {
            let id = shared.render(&mut frame).unwrap();
            shared.wait(&id).unwrap();
        }))
        .is_err());
        drop(shared);
        assert_eq!(state.borrow().stop, 1);
        assert!(state.borrow().pointers.is_empty());
        assert!(host.0.borrow().pending.is_none());
    }
}
#[repr(align(16))]
struct Aligned([u8; 256]);
struct AlignedResources {
    pixels: Aligned,
    revision: u64,
}
impl RenderResources for AlignedResources {
    fn viewport(&self) -> (f32, f32) {
        (480.0, 272.0)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        Some(TexView {
            pixels: &self.pixels.0,
            w: 8,
            h: 8,
            psm: 3,
            palette: None,
            linear: false,
        })
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}
#[test]
fn explicit_zero_copy_preserves_pointer_and_publishes_only_changed_versions() {
    let (mut r, state) = create();
    let mut res = AlignedResources {
        pixels: Aligned([3; 256]),
        revision: 1,
    };
    let words = list(texture());
    for i in 0..3 {
        if i == 2 {
            res.pixels.0.fill(4);
            res.revision += 1;
        }
        let target = r.target();
        let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
        let id = unsafe { r.render_zero_copy(&mut frame) }.unwrap();
        assert_eq!(
            state.borrow().textures.last().unwrap().pixels,
            res.pixels.0.as_ptr()
        );
        assert_eq!(
            state.borrow().publications.len(),
            if i == 2 { 2 } else { 1 }
        );
        r.wait(&id).unwrap();
        r.retire(id);
    }
}
#[test]
fn zero_copy_relocates_unaligned_planes_into_retained_ge_storage() {
    #[repr(align(16))]
    struct OffsetPixels([u8; 272]);
    impl RenderResources for OffsetPixels {
        fn viewport(&self) -> (f32, f32) {
            (480., 272.)
        }
        fn raster_revision(&self) -> u64 {
            1
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            Some(TexView {
                pixels: &self.0[8..264],
                w: 8,
                h: 8,
                psm: pocket_spec::psm::PSM_8888,
                palette: None,
                linear: false,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let (mut r, state) = create();
    let res = OffsetPixels([42; 272]);
    let words = list(texture());
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(r.target()));
    let id = unsafe { r.render_zero_copy(&mut frame) }.unwrap();
    let binding = state.borrow().textures[0];
    assert_ne!(binding.pixels, res.0[8..].as_ptr());
    assert_eq!(binding.pixels as usize % 16, 0);
    assert_eq!(
        unsafe { core::slice::from_raw_parts(binding.pixels, binding.bytes) },
        [42; 256]
    );
    r.retire(id);
}
#[test]
fn narrow_texture_rows_use_retained_hardware_pitch_including_zero_copy() {
    #[repr(align(16))]
    struct Narrow {
        pixels: [u8; 256],
        palette: [u8; 1024],
        width: u32,
        psm: u32,
        pixel_bytes: u32,
    }
    impl RenderResources for Narrow {
        fn viewport(&self) -> (f32, f32) {
            (480., 272.)
        }
        fn raster_revision(&self) -> u64 {
            1
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            Some(TexView {
                pixels: &self.pixels[..(self.width * 2 * self.pixel_bytes) as usize],
                w: self.width,
                h: 2,
                psm: self.psm,
                palette: (self.psm == pocket_spec::psm::PSM_T8).then_some(&self.palette),
                linear: true,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    for (psm, pixel_bytes) in [
        (pocket_spec::psm::PSM_8888, 4),
        (pocket_spec::psm::PSM_4444, 2),
        (pocket_spec::psm::PSM_5650, 2),
        (pocket_spec::psm::PSM_T8, 1),
    ] {
        for width in [1, 2, 16 / pixel_bytes] {
            for zero_copy in [false, true] {
                let (mut renderer, state) = create();
                let mut resources = Narrow {
                    pixels: [0xee; 256],
                    palette: [0; 1024],
                    width,
                    psm,
                    pixel_bytes,
                };
                let row = (width * pixel_bytes) as usize;
                resources.pixels[..row].fill(0x31);
                resources.pixels[row..row * 2].fill(0x72);
                let mut draw_words = texture();
                draw_words.extend([pocket_spec::draw_op::RECT, 0, xy(1, 1), u32::MAX]);
                draw_words.extend(texture());
                let words = list(draw_words);
                let mut frame = FrameInput::new(
                    &words,
                    &resources,
                    &[],
                    Target::DeviceOwned(renderer.target()),
                );
                let submission = if zero_copy {
                    unsafe { renderer.render_zero_copy(&mut frame) }.unwrap()
                } else {
                    renderer.render(&mut frame).unwrap()
                };
                let binding = state.borrow().textures[0];
                assert_eq!(state.borrow().textures.len(), 2);
                assert_eq!(state.borrow().textures[1].pixels, binding.pixels);
                assert_eq!((binding.width, binding.height), (width, 2));
                assert_eq!(binding.buffer_width * pixel_bytes, 16);
                assert_eq!(binding.bytes, 32);
                assert_eq!(binding.pixels as usize % 16, 0);
                assert_eq!(
                    binding.pixels == resources.pixels.as_ptr(),
                    zero_copy && row == 16
                );
                let pixels = unsafe { core::slice::from_raw_parts(binding.pixels, binding.bytes) };
                assert_eq!(&pixels[..row], &resources.pixels[..row]);
                assert_eq!(&pixels[16..16 + row], &resources.pixels[row..row * 2]);
                if row < 16 {
                    // Negative control: the previous tightly packed allocation
                    // cannot cover the second row at GE's mandatory pitch.
                    assert!(16 + row > row * 2);
                    assert!(pixels[row..16].iter().all(|v| *v == 0));
                    assert!(pixels[16 + row..].iter().all(|v| *v == 0));
                }
                if !zero_copy {
                    resources.pixels.fill(0xff);
                }
                // Mock::wait dereferences every retained binding, catching
                // premature scratch reuse before terminal completion.
                renderer.wait(&submission).unwrap();
                renderer.retire(submission);
            }
        }
    }
}
#[test]
fn font_revisions_preserve_pinned_pages_and_cpu_fallback_handles_pressure() {
    let state = Rc::new(RefCell::new(State::default()));
    let mut device = Mock(state.clone());
    let mut encoder = Encoder::new();
    let mut resources = Resources::default();
    let glyph = vec![pocket_spec::draw_op::GLYPH_RUN, 1 << 16, u32::MAX, 0, 0];
    unsafe {
        encoder
            .encode_open(&mut device, &resources, &glyph, false, false)
            .unwrap();
    }
    let first = state.borrow().textures[0];
    resources.font.fill(0);
    resources.revision += 1;
    unsafe {
        encoder
            .encode_open(&mut device, &resources, &glyph, false, false)
            .unwrap();
    }
    let second = state.borrow().textures[1];
    assert_ne!(first.pixels, second.pixels);
    assert_eq!(unsafe { *(first.pixels as *const u16) }, 0xffff);
    assert_eq!(unsafe { *(second.pixels as *const u16) }, 0);
    device.wait().unwrap();
    unsafe {
        encoder.retire();
        encoder.reset_fonts();
    }
    struct BigFont(Vec<u8>);
    impl RenderResources for BigFont {
        fn viewport(&self) -> (f32, f32) {
            (480., 272.)
        }
        fn raster_revision(&self) -> u64 {
            1
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            None
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            Some(FontView {
                bitmap: &self.0,
                cell_w: 64,
                cell_h: 128,
                raster_density: 1,
                glyph_count: 17,
            })
        }
    }
    let resources = BigFont(vec![255; 64 * 128 * 17]);
    let mut words = vec![pocket_spec::draw_op::GLYPH_RUN, 17 << 16, u32::MAX];
    for gid in 0..17 {
        words.extend([0, gid]);
    }
    let before = state.borrow().textures.len();
    unsafe {
        encoder
            .encode_open(&mut device, &resources, &words, false, false)
            .unwrap();
    }
    assert_eq!(state.borrow().textures.len() - before, 16);
    assert_eq!(state.borrow().draws.len(), 17);
    assert_eq!(state.borrow().draws.last().unwrap().1.len(), 128 * 2 * 12);
    device.wait().unwrap();
    unsafe {
        encoder.retire();
    }
}
#[test]
fn invalid_texture_and_coordinate_errors_stop_partial_native_work_before_return() {
    let (mut r, state) = create();
    let res = Resources::default();
    let words = list(vec![
        pocket_spec::draw_op::RECT,
        0,
        xy(2, 2),
        u32::MAX,
        pocket_spec::draw_op::RECT,
        xy(32000, 0),
        xy(1000, 1),
        u32::MAX,
    ]);
    let target = r.target();
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
    assert_eq!(r.render(&mut frame), Err(RenderError::InvalidFrame));
    assert_eq!(state.borrow().stop, 1);
    assert!(r.pending.is_none());
    let mut res = Resources::default();
    res.pixels.truncate(1);
    let words = list(texture());
    let target = r.target();
    let mut frame = FrameInput::new(&words, &res, &[], Target::DeviceOwned(target));
    assert_eq!(r.render(&mut frame), Err(RenderError::InvalidFrame));
    assert_eq!(state.borrow().stop, 2);
}
