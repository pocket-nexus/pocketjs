use super::*;
use alloc::vec;
use core::cell::{Cell, RefCell};
use pocket_drivers::{DrawList, FontView, TexView};
#[derive(Default)]
struct State {
    events: Vec<&'static str>,
    textures: Vec<(u32, Vec<u8>)>,
    vertices: Vec<Vertex>,
    commands: Vec<Command>,
    next: u32,
    fail_submit: bool,
    fail_flush: bool,
    fail_update: bool,
}
#[derive(Clone, Default)]
struct Mock(Rc<RefCell<State>>);
unsafe impl Device for Mock {
    type Frame = u32;
    fn upload(
        &mut self,
        pixels: &[u8],
        _: u32,
        _: u32,
        _: TextureFormat,
        _: bool,
    ) -> Result<u32, RenderError> {
        let mut s = self.0.borrow_mut();
        s.events.push("upload");
        s.next += 1;
        let id = s.next;
        s.textures.push((id, pixels.to_vec()));
        Ok(id)
    }
    fn update(
        &mut self,
        id: u32,
        pixels: &[u8],
        _: u32,
        _: u32,
        _: TextureFormat,
        _: bool,
    ) -> Result<(), RenderError> {
        let mut s = self.0.borrow_mut();
        s.events.push("update");
        s.textures.iter_mut().find(|(key, _)| *key == id).unwrap().1 = pixels.to_vec();
        if s.fail_update {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn release_texture(&mut self, id: u32) {
        let mut s = self.0.borrow_mut();
        s.events.push("release");
        s.textures.retain(|(key, _)| *key != id);
    }
    fn submit(
        &mut self,
        vertices: &[Vertex],
        commands: &[Command],
        clear: Option<u32>,
    ) -> Result<u32, RenderError> {
        let mut s = self.0.borrow_mut();
        s.events.push(if clear.is_some() {
            "submit-clear"
        } else {
            "submit-over"
        });
        if s.fail_submit {
            return Err(RenderError::Failed);
        }
        s.vertices = vertices.to_vec();
        s.commands = commands.to_vec();
        Ok(1)
    }
    fn wait(&mut self) -> Result<(), RenderError> {
        self.0.borrow_mut().events.push("wait");
        Ok(())
    }
    fn retire(&mut self, _: u32) {
        self.0.borrow_mut().events.push("retire");
    }
    fn begin_external(&mut self, _: u32) -> Result<(), RenderError> {
        self.0.borrow_mut().events.push("begin");
        Ok(())
    }
    fn flush(&mut self) -> Result<(), RenderError> {
        let mut s = self.0.borrow_mut();
        s.events.push("flush");
        if s.fail_flush {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn wait_display(&mut self) -> Result<(), RenderError> {
        self.0.borrow_mut().events.push("display-wait");
        Ok(())
    }
}
struct Resources {
    pixels: Vec<u8>,
    font: Vec<u8>,
    revision: u64,
    queries: Cell<u32>,
}
impl Resources {
    fn new() -> Self {
        Self {
            pixels: vec![255; 16],
            font: vec![127; 16],
            revision: 1,
            queries: Cell::new(0),
        }
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (100., 50.)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        self.queries.set(self.queries.get() + 1);
        (handle == 7).then_some(TexView {
            pixels: &self.pixels,
            w: 2,
            h: 2,
            psm: spec::psm::PSM_8888,
            palette: None,
            linear: false,
        })
    }
    fn texture_revision(&self, _: i32) -> Option<u64> {
        Some(self.revision)
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        (slot == 0).then_some(FontView {
            bitmap: &self.font,
            cell_w: 2,
            cell_h: 2,
            raster_density: 2,
            glyph_count: 1,
        })
    }
    fn font_revision(&self, _: u8) -> Option<u64> {
        Some(self.revision)
    }
}
fn xy(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}
fn wh(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}
fn list(words: Vec<u32>) -> DrawList {
    let mut list = DrawList::new();
    list.words = words;
    list
}
fn image() -> DrawList {
    list(vec![
        spec::draw_op::TEX_QUAD,
        7,
        xy(1, 2),
        wh(20, 10),
        0,
        0,
        1f32.to_bits(),
        1f32.to_bits(),
        u32::MAX,
    ])
}
fn fresh() -> (GxmRenderer<Mock>, Mock) {
    let device = Mock::default();
    (
        GxmRenderer::new(device.clone(), Config::new(200, 100, 2)).unwrap(),
        device,
    )
}
fn submit(
    renderer: &mut GxmRenderer<Mock>,
    list: &DrawList,
    res: &Resources,
) -> Result<Submission, RenderError> {
    let target = renderer.target();
    renderer.render(&mut FrameInput::new(
        list,
        res,
        &[],
        Target::DeviceOwned(target),
    ))
}
#[test]
fn copied_resources_and_pending_revisions_retire_in_reverse_order() {
    let (mut r, d) = fresh();
    let mut res = Resources::new();
    let a = submit(&mut r, &image(), &res).unwrap();
    res.pixels.fill(17);
    res.revision += 1;
    let b = submit(&mut r, &image(), &res).unwrap();
    assert_eq!(res.queries.get(), 2);
    assert_eq!(
        d.0.borrow()
            .textures
            .iter()
            .map(|(_, p)| p[0])
            .collect::<Vec<_>>(),
        [255, 17]
    );
    drop(res);
    r.retire(b);
    assert_eq!(d.0.borrow().textures.len(), 2);
    r.retire(a);
    assert_eq!(d.0.borrow().textures.len(), 1);
    assert_eq!(
        &d.0.borrow().events[4..],
        ["wait", "retire", "retire", "release"]
    );
}
#[test]
fn idle_video_updates_reuse_native_allocation() {
    let (mut r, d) = fresh();
    let mut res = Resources::new();
    let a = submit(&mut r, &image(), &res).unwrap();
    r.retire(a);
    res.pixels.fill(18);
    res.revision += 1;
    r.invalidate_texture(7);
    let b = submit(&mut r, &image(), &res).unwrap();
    assert_eq!(d.0.borrow().textures.len(), 1);
    assert_eq!(d.0.borrow().textures[0], (1, vec![18; 16]));
    assert_eq!(
        d.0.borrow()
            .events
            .iter()
            .filter(|e| **e == "upload")
            .count(),
        1
    );
    r.retire(b);
}
#[test]
fn failed_partial_update_cannot_return_old_revision() {
    let (mut r, d) = fresh();
    let mut res = Resources::new();
    let a = submit(&mut r, &image(), &res).unwrap();
    r.retire(a);
    res.revision += 1;
    d.0.borrow_mut().fail_update = true;
    assert_eq!(submit(&mut r, &image(), &res), Err(RenderError::Failed));
    assert!(!r.texture_resident(7));
    d.0.borrow_mut().fail_update = false;
    let b = submit(&mut r, &image(), &res).unwrap();
    assert!(r.texture_resident(7));
    r.retire(b);
}
#[test]
fn shared_scene_waits_before_swap_and_retirement_even_when_flush_fails() {
    let (mut r, d) = fresh();
    let res = Resources::new();
    r.begin_frame(0).unwrap();
    submit(&mut r, &image(), &res).unwrap();
    d.0.borrow_mut().events.push("native-over");
    submit(&mut r, &image(), &res).unwrap();
    d.0.borrow_mut().fail_flush = true;
    assert_eq!(r.present(), Err(RenderError::Failed));
    assert_eq!(
        d.0.borrow().events,
        [
            "wait",
            "begin",
            "upload",
            "submit-over",
            "native-over",
            "submit-over",
            "wait",
            "flush",
            "retire",
            "retire"
        ]
    );
}
#[test]
fn failed_submission_drains_prior_work_and_discards_display() {
    let (mut r, d) = fresh();
    let res = Resources::new();
    r.begin_frame(0).unwrap();
    let a = submit(&mut r, &image(), &res).unwrap();
    d.0.borrow_mut().fail_submit = true;
    assert_eq!(submit(&mut r, &image(), &res), Err(RenderError::Failed));
    assert_eq!(r.wait(&a), Ok(()));
    assert_eq!(r.present(), Err(RenderError::Failed));
    assert!(!d.0.borrow().events.contains(&"flush"));
    assert!(d.0.borrow().events.contains(&"retire"));
}
#[test]
fn cache_capacity_protects_pinned_versions_then_allows_idle_update() {
    let d = Mock::default();
    let mut cfg = Config::new(200, 100, 2);
    cfg.image_entries = 1;
    cfg.image_bytes = 256 * 1024;
    let mut r = GxmRenderer::new(d.clone(), cfg).unwrap();
    let mut res = Resources::new();
    let a = submit(&mut r, &image(), &res).unwrap();
    res.revision += 1;
    assert_eq!(submit(&mut r, &image(), &res), Err(RenderError::Failed));
    assert_eq!(d.0.borrow().textures.len(), 1);
    r.retire(a);
    let b = submit(&mut r, &image(), &res).unwrap();
    assert_eq!(d.0.borrow().textures.len(), 1);
    r.retire(b);
}
#[test]
fn gradient_strip_diagonal_scale_and_scissor_restore_match_vita() {
    let (mut r, d) = fresh();
    let res = Resources::new();
    let words = list(vec![
        spec::draw_op::SCISSOR,
        xy(1, 2),
        wh(8, 9),
        spec::draw_op::GRAD_RECT,
        xy(1, 2),
        wh(4, 5),
        0xff00_0001,
        0xff00_0002,
        spec::GradDir::ToRight as u32,
        spec::draw_op::SCISSOR_POP,
        spec::draw_op::RECT,
        0,
        wh(1, 1),
        u32::MAX,
    ]);
    let a = submit(&mut r, &words, &res).unwrap();
    let s = d.0.borrow();
    assert_eq!(
        s.vertices[..6]
            .iter()
            .map(|v| (v.position, v.color))
            .collect::<Vec<_>>(),
        [
            ([2., 4.], 0xff00_0001),
            ([10., 4.], 0xff00_0002),
            ([2., 14.], 0xff00_0001),
            ([2., 14.], 0xff00_0001),
            ([10., 4.], 0xff00_0002),
            ([10., 14.], 0xff00_0002)
        ]
    );
    assert_eq!(
        s.commands[0].clip,
        Clip {
            x: 2,
            y: 4,
            w: 16,
            h: 18
        }
    );
    assert_eq!(
        s.commands[1].clip,
        Clip {
            x: 0,
            y: 0,
            w: 200,
            h: 100
        }
    );
    drop(s);
    r.retire(a);
}
#[test]
fn density_two_font_keeps_logical_quad_and_guarded_coverage() {
    let (mut r, d) = fresh();
    let res = Resources::new();
    let glyph = list(vec![
        spec::draw_op::GLYPH_RUN,
        2 << 16,
        u32::MAX,
        xy(3, 4),
        0,
        0,
        99,
    ]);
    let a = submit(&mut r, &glyph, &res).unwrap();
    let s = d.0.borrow();
    assert_eq!(s.vertices.len(), 6);
    assert_eq!(s.vertices[0].position, [6., 8.]);
    assert_eq!(s.vertices[5].position, [10., 12.]);
    assert!(s.textures[0].1.contains(&127));
    assert!(s.textures[0].1.contains(&0));
    drop(s);
    r.retire(a);
}
#[test]
fn malformed_external_views_are_errors_not_panics() {
    let (mut r, _) = fresh();
    let mut res = Resources::new();
    res.pixels.clear();
    assert_eq!(
        submit(&mut r, &image(), &res),
        Err(RenderError::InvalidFrame)
    );
    res.font.clear();
    let glyph = list(vec![spec::draw_op::GLYPH_RUN, 1 << 16, u32::MAX, 0, 0]);
    assert_eq!(submit(&mut r, &glyph, &res), Err(RenderError::InvalidFrame));
    assert_eq!(
        submit(&mut r, &list(vec![spec::draw_op::TEX_TRI]), &res),
        Err(RenderError::InvalidFrame)
    );
}
#[test]
fn instance_targets_and_tokens_cannot_cross_renderers() {
    let (mut a, _) = fresh();
    let (mut b, _) = fresh();
    let res = Resources::new();
    let words = image();
    let token = submit(&mut a, &words, &res).unwrap();
    assert_eq!(b.wait(&token), Err(RenderError::InvalidFrame));
    assert_eq!(
        b.render(&mut FrameInput::new(
            &words,
            &res,
            &[],
            Target::DeviceOwned(a.target())
        )),
        Err(RenderError::InvalidFrame)
    );
    b.retire(token);
    assert_eq!(a.pending.len(), 1);
    a.retire(token);
    assert_eq!(a.wait(&token), Err(RenderError::InvalidFrame));
    assert!(!a.descriptor().zero_copy());
}
#[test]
fn native_allocation_accounting_includes_pitch_and_cdram_granularity() {
    assert_eq!(texture_bytes(1, 1, 4), Some(256 * 1024));
    assert_eq!(texture_bytes(1025, 256, 4), Some(1280 * 1024));
    assert_eq!(core::mem::size_of::<Vertex>(), 20);
}
#[test]
fn large_batches_split_at_native_index_capacity_without_reordering_triangles() {
    let ranges = triangle_ranges(65535 * 2 + 6).collect::<Vec<_>>();
    assert_eq!(ranges, [0..65535, 65535..131070, 131070..131076]);
    assert!(ranges.iter().all(|r| r.len() <= 65535 && r.len() % 3 == 0));
    assert!(triangle_ranges(0).next().is_none());
}
#[test]
fn mirrored_quads_keep_legacy_skip_but_textured_triangles_keep_tint_and_uv() {
    let (mut r, d) = fresh();
    let res = Resources::new();
    let mut words = image();
    words.words[4] = 1f32.to_bits();
    words.words[6] = 0;
    words.words.extend_from_slice(&[
        spec::draw_op::TEX_TRI,
        7,
        xy(1, 2),
        0,
        0,
        xy(3, 4),
        1f32.to_bits(),
        0,
        xy(5, 6),
        0,
        1f32.to_bits(),
        0x8040_2010,
    ]);
    let token = submit(&mut r, &words, &res).unwrap();
    let s = d.0.borrow();
    assert_eq!(s.vertices.len(), 3);
    assert!(s.vertices.iter().all(|v| v.color == 0x8040_2010));
    assert_eq!(s.vertices[1].uv, [1., 0.]);
    assert_eq!(s.vertices[2].position, [10., 12.]);
    drop(s);
    r.retire(token);
}

#[test]
fn coordinator_display_split_retires_only_after_display_wait() {
    let (mut renderer, device) = fresh();
    renderer.begin_frame(0).unwrap();
    let token = submit(&mut renderer, &image(), &Resources::new()).unwrap();
    device.0.borrow_mut().events.push("overlay");
    renderer.wait(&token).unwrap();
    renderer.flush_display().unwrap();
    assert!(!device.0.borrow().events.contains(&"retire"));
    renderer.wait_display().unwrap();
    renderer.retire(token);
    let state = device.0.borrow();
    let at = |name| {
        state
            .events
            .iter()
            .rposition(|&event| event == name)
            .unwrap()
    };
    assert!(at("overlay") < at("wait"));
    assert!(at("wait") < at("flush"));
    assert!(at("flush") < at("display-wait"));
    assert!(at("display-wait") < at("retire"));
}

#[test]
fn coordinator_error_before_submission_closes_external_scene_without_swap() {
    let (mut renderer, device) = fresh();
    renderer.begin_frame(0).unwrap();
    renderer.discard_frame().unwrap();
    assert!(!device.0.borrow().events.contains(&"flush"));
    renderer.begin_frame(0).unwrap();
    renderer.discard_frame().unwrap();
    renderer.reset_guest().unwrap();
}

#[test]
fn registered_display_queues_the_swap_and_completion_never_drains_the_display_queue() {
    use pocket_drivers::{DisplayOutput, DisplayRole};
    let (renderer, device) = fresh();
    let shared = Rc::new(RefCell::new(renderer));
    let mut registered = registered::SharedRenderer(shared.clone());
    let mut display = registered::GxmDisplay::new(shared.clone(), DisplayRole::Primary);
    assert!(display.descriptor().queued_flush);
    let res = Resources::new();
    let words = image();
    let region = Rect::new(0, 0, 200, 100);
    let mut previous = None;
    for _ in 0..2 {
        // The program opens the scene; this waits for the previous scene's
        // GPU work before vita2d reuses its vertex pool.
        shared.borrow_mut().begin_frame(0).unwrap();
        // Coordinator completion of the previous frame, before acquire.
        if let Some((submission, token)) = previous.take() {
            registered.wait(&submission).unwrap();
            display.wait(token).unwrap();
            registered.retire(submission);
        }
        let target = display.acquire(region).unwrap();
        let submission = registered
            .render(&mut FrameInput::new(&words, &res, &[region], target))
            .unwrap();
        device.0.borrow_mut().events.push("overlay");
        // Queued flush right after submission: the scene closes and the swap
        // is queued without a GPU wait.
        let token = display.flush(&[region]).unwrap();
        assert!(display.acquire(region).is_err());
        previous = Some((submission, token));
    }
    let (submission, token) = previous.take().unwrap();
    registered.wait(&submission).unwrap();
    display.wait(token).unwrap();
    registered.retire(submission);
    assert_eq!(
        device.0.borrow().events,
        [
            "wait",
            "begin",
            "upload",
            "submit-over",
            "overlay",
            "flush",
            "wait",
            "begin",
            "retire",
            "submit-over",
            "overlay",
            "flush",
            "wait",
            "retire",
        ]
    );
}
