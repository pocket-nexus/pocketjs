use super::*;
use alloc::vec;
use pocket_drivers::{DrawList, FontView, TexView};

fn pack_xy(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn pack_wh(width: u16, height: u16) -> u32 {
    width as u32 | ((height as u32) << 16)
}

fn view<'a>(
    pixels: &'a [u8],
    width: u32,
    height: u32,
    psm: u32,
    palette: Option<&'a [u8]>,
) -> TexView<'a> {
    TexView {
        pixels,
        w: width,
        h: height,
        psm,
        palette,
        linear: false,
    }
}

type TestRenderer = GlesRenderer<MockPipeline, MockContext>;
fn planner(handle: i32, texture_name: GLuint) -> TestRenderer {
    let mut renderer = TestRenderer::new(MockContext).unwrap();
    renderer.white = 1;
    renderer.images.push(ImageTexture {
        handle,
        name: texture_name,
        white_uv: None,
    });
    renderer
}

#[test]
fn vertex_layout_matches_both_gl_pipelines() {
    assert_eq!(size_of::<Vertex>(), 20);
    assert_eq!(core::mem::align_of::<Vertex>(), 4);
    assert_eq!(core::mem::offset_of!(Vertex, position), 0);
    assert_eq!(core::mem::offset_of!(Vertex, uv), 8);
    assert_eq!(core::mem::offset_of!(Vertex, color), 16);
}

#[test]
fn mixed_quads_and_triangles_preserve_painter_order_and_corner_colors() {
    let mut renderer = planner(0, 9);
    let _ = renderer.build(
        &[
            spec::draw_op::GRAD_RECT,
            pack_xy(-2, 3),
            pack_wh(4, 5),
            0x8040_3020,
            0x8080_7060,
            spec::GradDir::ToRight as u32,
            spec::draw_op::TRI,
            pack_xy(7, 8),
            pack_xy(-1, 2),
            pack_xy(3, -4),
            0x8000_0001,
            0x8000_0002,
            0x8000_0003,
        ],
        100,
        50,
    );
    assert_eq!(
        renderer
            .vertices
            .iter()
            .map(|v| (v.position, v.color))
            .collect::<Vec<_>>(),
        [
            ([-2.0, 3.0], 0x8040_3020),
            ([2.0, 3.0], 0x8080_7060),
            ([2.0, 8.0], 0x8080_7060),
            ([-2.0, 3.0], 0x8040_3020),
            ([2.0, 8.0], 0x8080_7060),
            ([-2.0, 8.0], 0x8040_3020),
            ([7.0, 8.0], 0x8000_0001),
            ([-1.0, 2.0], 0x8000_0002),
            ([3.0, -4.0], 0x8000_0003),
        ]
    );
    assert!(renderer.vertices[..6].iter().all(|v| v.uv == [0.5, 0.5]));
    assert!(renderer.vertices[6..].iter().all(|v| v.uv == [0.0, 0.0]));
    assert_eq!(renderer.commands.len(), 1);
    assert_eq!(
        (renderer.commands[0].first, renderer.commands[0].count),
        (0, 9)
    );
}

#[test]
fn psm_fixtures_expand_to_rgba_and_reject_short_input() {
    let psm5650 = [
        0x1f, 0x00, // red
        0xe0, 0x07, // green
        0x00, 0xf8, // blue
    ];
    assert_eq!(
        texture_rgba(view(&psm5650, 3, 1, spec::psm::PSM_5650, None)),
        Some(vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,]),
    );

    assert_eq!(
        texture_rgba(view(&[0x21, 0x43], 1, 1, spec::psm::PSM_4444, None)),
        Some(vec![17, 34, 51, 68]),
    );
    assert_eq!(
        texture_rgba(view(&[1, 2, 3, 4], 1, 1, spec::psm::PSM_8888, None)),
        Some(vec![1, 2, 3, 4]),
    );

    let mut palette = vec![0u8; 1024];
    palette[8..12].copy_from_slice(&[9, 8, 7, 6]);
    assert_eq!(
        texture_rgba(view(&[2], 1, 1, spec::psm::PSM_T8, Some(&palette),)),
        Some(vec![9, 8, 7, 6]),
    );
    assert_eq!(
        texture_rgba(view(&[1, 2, 3], 1, 1, spec::psm::PSM_8888, None)),
        None,
    );
}

#[test]
fn tex_tri_decoder_preserves_vertices_batches_and_nested_scissors() {
    let handle = 0;
    let texture = 9;
    let color = 0x8040_3020;
    let tri = [
        spec::draw_op::TEX_TRI,
        handle as u32,
        pack_xy(-3, 4),
        0.125f32.to_bits(),
        0.25f32.to_bits(),
        pack_xy(20, 5),
        0.75f32.to_bits(),
        0.25f32.to_bits(),
        pack_xy(7, 30),
        0.5f32.to_bits(),
        0.875f32.to_bits(),
        color,
    ];
    let mut words = vec![spec::draw_op::SCISSOR, pack_xy(10, 20), pack_wh(100, 80)];
    words.extend_from_slice(&tri);
    words.extend_from_slice(&[spec::draw_op::SCISSOR, pack_xy(20, 30), pack_wh(50, 40)]);
    words.extend_from_slice(&tri);
    words.extend_from_slice(&[spec::draw_op::SCISSOR_POP, spec::draw_op::SCISSOR_POP]);

    let mut renderer = planner(handle, texture);
    let _ = renderer.build(&words, 200, 120);

    assert_eq!(renderer.vertices.len(), 6);
    assert_eq!(
        renderer.vertices[0],
        Vertex {
            position: [-3.0, 4.0],
            uv: [0.125, 0.25],
            color,
        },
    );
    assert_eq!(
        renderer.commands,
        vec![
            Command {
                texture,
                first: 0,
                count: 3,
                clip: Clip {
                    x: 10,
                    y: 20,
                    w: 100,
                    h: 80,
                },
            },
            Command {
                texture,
                first: 3,
                count: 3,
                clip: Clip {
                    x: 20,
                    y: 30,
                    w: 50,
                    h: 40,
                },
            },
        ],
    );
}

#[test]
fn indexed_coverage_optimization_rejects_colored_or_short_palettes() {
    let mut palette = vec![255; 1024];
    palette[3] = 0;
    palette[7] = 73;
    assert_eq!(
        coverage_luminance_alpha(view(&[0, 1], 2, 1, spec::psm::PSM_T8, Some(&palette))),
        Some(vec![255, 0, 255, 73])
    );
    assert!(
        coverage_luminance_alpha(view(&[0], 2, 1, spec::psm::PSM_T8, Some(&palette))).is_none()
    );
    palette[0] = 0;
    assert!(
        coverage_luminance_alpha(view(&[0, 1], 2, 1, spec::psm::PSM_T8, Some(&palette))).is_none()
    );
}

#[test]
fn image_fill_patch_requires_guarded_opaque_white_pixels() {
    let mut pixels = vec![0; 8 * 8 * 4];
    for y in 2..6 {
        for x in 3..7 {
            pixels[(y * 8 + x) * 4..(y * 8 + x + 1) * 4].fill(255);
        }
    }
    assert_eq!(
        image_white_patch(&pixels, 8, 8),
        Some([5.0 / 8.0, 4.0 / 8.0])
    );
    pixels[(3 * 8 + 4) * 4 + 3] = 254;
    assert_eq!(image_white_patch(&pixels, 8, 8), None);
    assert_eq!(image_white_patch(&[255; 3 * 4 * 4], 3, 4), None);
}

#[test]
fn image_and_fill_share_a_batch_without_changing_geometry_or_color() {
    let mut renderer = planner(0, 9);
    let words = [
        spec::draw_op::TEX_QUAD,
        0,
        pack_xy(0, 0),
        pack_wh(8, 8),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xffffffff,
        spec::draw_op::RECT,
        pack_xy(8, 0),
        pack_wh(8, 8),
        0x80765432,
    ];
    let _ = renderer.build(&words, 100, 50);
    assert_eq!(renderer.commands.len(), 2);
    let before: Vec<_> = renderer
        .vertices
        .iter()
        .map(|v| (v.position, v.color))
        .collect();
    renderer.images[0].white_uv = Some([0.5, 0.5]);
    let _ = renderer.build(&words, 100, 50);
    assert_eq!(renderer.commands.len(), 1);
    assert_eq!(renderer.commands[0].texture, 9);
    assert_eq!(
        renderer
            .vertices
            .iter()
            .map(|v| (v.position, v.color))
            .collect::<Vec<_>>(),
        before
    );
    assert!(renderer.vertices[6..].iter().all(|v| v.uv == [0.5, 0.5]));
}

#[test]
fn no_op_scissors_merge_without_crossing_a_different_clip() {
    let mut renderer = planner(0, 9);
    let rect = |color| [spec::draw_op::RECT, pack_xy(2, 3), pack_wh(4, 5), color];
    let colors = [0x80112233, 0x80445566, 0x80778899, 0x80aabbcc, 0x80ddeeff];
    let mut words = rect(colors[0]).to_vec();
    words.extend_from_slice(&[spec::draw_op::SCISSOR, pack_xy(0, 0), pack_wh(100, 50)]);
    words.extend_from_slice(&rect(colors[1]));
    words.push(spec::draw_op::SCISSOR_POP);
    words.extend_from_slice(&rect(colors[2]));
    words.extend_from_slice(&[spec::draw_op::SCISSOR, pack_xy(0, 0), pack_wh(50, 50)]);
    words.extend_from_slice(&rect(colors[3]));
    words.push(spec::draw_op::SCISSOR_POP);
    words.extend_from_slice(&rect(colors[4]));
    let _ = renderer.build(&words, 100, 50);
    assert_eq!(renderer.vertices.len(), 30);
    for (vertices, color) in renderer.vertices.chunks(6).zip(colors) {
        assert!(vertices.iter().all(|v| v.color == color));
    }
    assert_eq!(
        renderer
            .commands
            .iter()
            .map(|c| (c.first, c.count, c.clip.w))
            .collect::<Vec<_>>(),
        vec![(0, 18, 100), (18, 6, 50), (24, 6, 100)]
    );
}

#[test]
fn native_scissor_preserves_offset_clipping_and_y_inversion() {
    assert_eq!(
        TestRenderer::physical_clip(
            Clip {
                x: -3,
                y: -4,
                w: 20,
                h: 30
            },
            360,
            640,
            10,
            20,
            360,
            640,
            700,
        ),
        Clip {
            x: 10,
            y: 654,
            w: 17,
            h: 26
        }
    );
    assert_eq!(
        TestRenderer::physical_clip(
            Clip {
                x: 630,
                y: 350,
                w: 20,
                h: 30
            },
            640,
            360,
            0,
            0,
            640,
            360,
            360,
        ),
        Clip {
            x: 630,
            y: 0,
            w: 10,
            h: 10
        }
    );
}

#[test]
fn truncated_draw_op_stops_without_partial_geometry() {
    let mut renderer = planner(0, 9);
    let _ = renderer.build(&[spec::draw_op::TEX_TRI, 0, pack_xy(1, 2)], 100, 50);
    assert!(renderer.vertices.is_empty());
    assert!(renderer.commands.is_empty());
}

#[test]
fn logical_scissor_maps_to_bottom_left_physical_coordinates() {
    assert_eq!(
        TestRenderer::physical_clip(
            Clip {
                x: 25,
                y: 10,
                w: 50,
                h: 20,
            },
            100,
            50,
            10,
            20,
            200,
            100,
            200,
        ),
        Clip {
            x: 60,
            y: 120,
            w: 100,
            h: 40,
        },
    );
}

#[derive(Default)]
struct GlState {
    next: u32,
    events: Vec<&'static str>,
    uploads: Vec<Vec<u8>>,
    buffers: Vec<Vec<u8>>,
    error: u32,
    fail_upload: bool,
    fail_draw: bool,
    lost: bool,
}
std::thread_local! { static GL: std::cell::RefCell<GlState> = std::cell::RefCell::new(GlState::default()); }
fn event(value: &'static str) {
    GL.with(|gl| gl.borrow_mut().events.push(value));
}
struct MockPipeline;
unsafe impl Pipeline for MockPipeline {
    unsafe fn new() -> Option<Self> {
        Some(Self)
    }
    unsafe fn destroy(&mut self) {
        event("pipeline-delete");
    }
    unsafe fn begin_frame(&self, _: f32, _: f32) {
        event("begin");
    }
    unsafe fn set_blend(&self) {}
    unsafe fn bind_vertices(&self, _: i32) {}
    unsafe fn unbind_vertices(&self) {}
}
struct MockContext;
unsafe impl ContextAccess for MockContext {
    type NativeTarget = ();
    fn ensure_current(&mut self) -> Result<(), RenderError> {
        event("activate");
        if GL.with(|gl| gl.borrow().lost) {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn bind_target(&mut self, _: &()) -> Result<(), RenderError> {
        event("bind-target");
        Ok(())
    }
}
#[no_mangle]
unsafe extern "C" fn glGetError() -> u32 {
    GL.with(|gl| core::mem::take(&mut gl.borrow_mut().error))
}
#[no_mangle]
unsafe extern "C" fn glGetIntegerv(_: u32, out: *mut i32) {
    *out = 2048;
}
#[no_mangle]
unsafe extern "C" fn glGenTextures(n: i32, out: *mut u32) {
    for i in 0..n {
        *out.add(i as usize) = GL.with(|gl| {
            let mut gl = gl.borrow_mut();
            gl.next += 1;
            gl.next
        });
    }
}
#[no_mangle]
unsafe extern "C" fn glGenBuffers(n: i32, out: *mut u32) {
    glGenTextures(n, out);
}
#[no_mangle]
unsafe extern "C" fn glFinish() {
    event("finish");
}
#[no_mangle]
unsafe extern "C" fn glDeleteTextures(_: i32, _: *const u32) {
    event("texture-delete");
}
#[no_mangle]
unsafe extern "C" fn glDeleteBuffers(_: i32, _: *const u32) {
    event("buffer-delete");
}
#[no_mangle]
unsafe extern "C" fn glBindBuffer(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBindTexture(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBufferData(_: u32, size: isize, data: *const c_void, _: u32) {
    GL.with(|gl| {
        gl.borrow_mut()
            .buffers
            .push(core::slice::from_raw_parts(data.cast(), size as usize).to_vec())
    });
}
#[no_mangle]
unsafe extern "C" fn glClear(_: u32) {
    event("clear");
}
#[no_mangle]
unsafe extern "C" fn glClearColor(_: f32, _: f32, _: f32, _: f32) {}
#[no_mangle]
unsafe extern "C" fn glDisable(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glEnable(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glDrawArrays(_: u32, _: i32, _: i32) {
    event("draw");
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        if gl.fail_draw {
            gl.error = 0x0502;
        }
    });
}
#[no_mangle]
unsafe extern "C" fn glPixelStorei(_: u32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glScissor(_: i32, _: i32, _: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glViewport(_: i32, _: i32, _: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glTexParameteri(_: u32, _: u32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glTexImage2D(
    _: u32,
    _: i32,
    _: i32,
    w: i32,
    h: i32,
    _: i32,
    format: u32,
    _: u32,
    pixels: *const c_void,
) {
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        let channels = if format == GL_RGBA { 4 } else { 2 };
        gl.uploads.push(
            core::slice::from_raw_parts(pixels.cast(), w as usize * h as usize * channels).to_vec(),
        );
        if gl.fail_upload {
            gl.error = 0x0505;
        }
    });
}
fn fresh() -> TestRenderer {
    GL.with(|gl| *gl.borrow_mut() = GlState::default());
    TestRenderer::new(MockContext).unwrap()
}
fn config() -> TargetConfig<()> {
    TargetConfig {
        native: (),
        window_width: 100,
        window_height: 50,
        viewport: Viewport {
            x: 0,
            y: 0,
            width: 100,
            height: 50,
        },
        format: PixelFormat::Rgba8888,
        clear: ClearMode::OpaqueBlack,
        external_compositor: false,
    }
}
struct Resources {
    pixels: Vec<u8>,
    font: Vec<u8>,
    revision: u64,
    queried: core::cell::Cell<u32>,
}
impl Resources {
    fn new() -> Self {
        Self {
            pixels: vec![255; 16],
            font: vec![127; 50 * 64 * 64],
            revision: 1,
            queried: core::cell::Cell::new(0),
        }
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (100.0, 50.0)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        self.queried.set(self.queried.get() + 1);
        (handle == 7).then(|| view(&self.pixels, 2, 2, spec::psm::PSM_8888, None))
    }
    fn texture_revision(&self, _: i32) -> Option<u64> {
        Some(self.revision)
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        (slot == 0).then_some(FontView {
            bitmap: &self.font,
            cell_w: 64,
            cell_h: 64,
            raster_density: 1,
            glyph_count: 50,
        })
    }
    fn font_revision(&self, _: u8) -> Option<u64> {
        Some(self.revision)
    }
}
fn image_list() -> DrawList {
    let mut list = DrawList::new();
    list.words = vec![
        spec::draw_op::TEX_QUAD,
        7,
        0,
        pack_wh(20, 20),
        0,
        0,
        1f32.to_bits(),
        1f32.to_bits(),
        u32::MAX,
    ];
    list
}
fn submit(
    renderer: &mut TestRenderer,
    handle: u64,
    list: &DrawList,
    resources: &Resources,
) -> Result<Submission, RenderError> {
    let target = renderer.target(handle)?;
    renderer.render(&mut FrameInput::new(
        list,
        resources,
        &[],
        Target::DeviceOwned(target),
    ))
}

#[test]
fn resources_are_copied_and_versions_live_until_reverse_retirement() {
    let mut renderer = fresh();
    let handle = renderer.register_target(config()).unwrap();
    let list = image_list();
    let mut resources = Resources::new();
    let first = submit(&mut renderer, handle, &list, &resources).unwrap();
    assert_eq!(
        resources.queried.get(),
        1,
        "only a referenced handle is requested"
    );
    resources.pixels.fill(17);
    resources.revision += 1;
    let second = submit(&mut renderer, handle, &list, &resources).unwrap();
    GL.with(|gl| {
        let gl = gl.borrow();
        assert_eq!(gl.uploads[1], [255; 16]);
        assert_eq!(gl.uploads[2], [17; 16]);
        assert_eq!(gl.buffers.len(), 2);
        assert!(!gl.events.contains(&"texture-delete"));
        assert!(!gl.events.contains(&"finish"));
    });
    drop(resources);
    drop(list);
    renderer.wait(&second).unwrap();
    renderer.retire(second);
    GL.with(|gl| assert!(!gl.borrow().events.contains(&"texture-delete")));
    renderer.wait(&first).unwrap();
    renderer.retire(first);
    GL.with(|gl| {
        let gl = gl.borrow();
        let finish = gl.events.iter().position(|e| *e == "finish").unwrap();
        let delete = gl
            .events
            .iter()
            .position(|e| *e == "texture-delete")
            .unwrap();
        assert!(finish < delete);
        assert_eq!(gl.events.iter().filter(|e| **e == "finish").count(), 1);
    });
}
#[test]
fn early_retire_and_drop_finish_before_releasing_gpu_objects() {
    let mut renderer = fresh();
    let handle = renderer.register_target(config()).unwrap();
    let resources = Resources::new();
    let list = image_list();
    let first = submit(&mut renderer, handle, &list, &resources).unwrap();
    renderer.retire(first);
    renderer.retire(first);
    let _second = submit(&mut renderer, handle, &list, &resources).unwrap();
    drop(renderer);
    GL.with(|gl| {
        let gl = gl.borrow();
        let mut finished = false;
        for event in &gl.events {
            if *event == "draw" {
                finished = false;
            }
            if *event == "finish" {
                finished = true;
            }
            if matches!(
                *event,
                "buffer-delete" | "texture-delete" | "pipeline-delete"
            ) {
                assert!(finished, "delete before completion: {:?}", gl.events);
            }
        }
    });
}
#[test]
fn foreign_targets_submissions_and_zero_copy_are_rejected() {
    let mut first = fresh();
    let mut second = TestRenderer::new(MockContext).unwrap();
    let handle = first.register_target(config()).unwrap();
    let own = second.register_target(config()).unwrap();
    let resources = Resources::new();
    let list = image_list();
    let token = submit(&mut first, handle, &list, &resources).unwrap();
    assert_eq!(second.wait(&token), Err(RenderError::InvalidFrame));
    second.retire(token);
    let target = first.target(handle).unwrap();
    assert_eq!(
        second.render(&mut FrameInput::new(
            &list,
            &resources,
            &[],
            Target::DeviceOwned(target)
        )),
        Err(RenderError::InvalidFrame)
    );
    assert!(first.unregister_target(handle).is_err());
    first.retire(token);
    first.unregister_target(handle).unwrap();
    assert!(first.target(handle).is_err());
    let target = second.target(own).unwrap();
    assert!(!second.descriptor().zero_copy());
    assert_eq!(
        unsafe {
            second.render_zero_copy(&mut FrameInput::new(
                &list,
                &resources,
                &[],
                Target::DeviceOwned(target),
            ))
        },
        Err(RenderError::Unsupported)
    );
}
#[test]
fn validation_and_gpu_failures_drain_existing_work() {
    let mut renderer = fresh();
    let handle = renderer.register_target(config()).unwrap();
    let resources = Resources::new();
    let list = image_list();
    let token = submit(&mut renderer, handle, &list, &resources).unwrap();
    let mut bad = DrawList::new();
    bad.words = vec![spec::draw_op::TEX_TRI];
    assert_eq!(
        submit(&mut renderer, handle, &bad, &resources),
        Err(RenderError::InvalidFrame)
    );
    renderer.wait(&token).unwrap();
    renderer.retire(token);
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        gl.events.clear();
        gl.fail_draw = true;
    });
    assert_eq!(
        submit(&mut renderer, handle, &list, &resources),
        Err(RenderError::Failed)
    );
    GL.with(|gl| {
        let gl = gl.borrow();
        assert!(
            gl.events.iter().position(|e| *e == "finish").unwrap()
                < gl.events
                    .iter()
                    .position(|e| *e == "buffer-delete")
                    .unwrap()
        );
    });
}
#[test]
fn glyph_pages_preserve_run_order_and_revision_replacement() {
    let mut renderer = fresh();
    let handle = renderer.register_target(config()).unwrap();
    let mut resources = Resources::new();
    let mut list = DrawList::new();
    list.words = vec![
        spec::draw_op::GLYPH_RUN,
        3 << 16,
        u32::MAX,
        pack_xy(0, 0),
        0,
        pack_xy(64, 0),
        49,
        pack_xy(128, 0),
        0,
    ];
    let first = submit(&mut renderer, handle, &list, &resources).unwrap();
    assert_eq!(renderer.commands.len(), 3);
    assert_eq!(renderer.commands[0].texture, renderer.commands[2].texture);
    assert_ne!(renderer.commands[0].texture, renderer.commands[1].texture);
    assert_eq!(renderer.vertices[0].uv, renderer.vertices[12].uv);
    resources.font.fill(42);
    resources.revision += 1;
    let second = submit(&mut renderer, handle, &list, &resources).unwrap();
    assert_eq!(
        renderer.glyph_keys.len(),
        2,
        "only current page revisions are indexed"
    );
    renderer.wait(&second).unwrap();
    renderer.retire(second);
    renderer.retire(first);
    resources.font.clear();
    resources.revision += 1;
    assert_eq!(
        submit(&mut renderer, handle, &list, &resources),
        Err(RenderError::InvalidFrame)
    );
    list.words = vec![spec::draw_op::GLYPH_RUN, 1 << 16, u32::MAX, 0, 500];
    let skipped = submit(&mut renderer, handle, &list, &resources).unwrap();
    assert!(renderer.vertices.is_empty());
    renderer.retire(skipped);
}
#[test]
fn context_loss_is_terminal_and_never_calls_dead_gl() {
    let mut renderer = fresh();
    let handle = renderer.register_target(config()).unwrap();
    let resources = Resources::new();
    let list = image_list();
    let token = submit(&mut renderer, handle, &list, &resources).unwrap();
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        gl.lost = true;
        gl.events.clear();
    });
    assert_eq!(renderer.wait(&token), Err(RenderError::Failed));
    renderer.retire(token);
    drop(renderer);
    GL.with(|gl| assert_eq!(gl.borrow().events, ["activate"]));
}
#[test]
fn malformed_texture_storage_is_rejected_before_allocation() {
    assert!(texture_rgba(view(&[], u32::MAX, u32::MAX, spec::psm::PSM_8888, None)).is_none());
    assert!(white_patch(&[], u32::MAX, u32::MAX, 4).is_none());
    let mut renderer = fresh();
    let mut target = config();
    target.viewport.y = i32::MIN;
    assert!(renderer.register_target(target).is_err());
}

#[test]
fn cache_budget_preserves_pending_versions_and_evicts_retired_entries() {
    GL.with(|gl| *gl.borrow_mut() = GlState::default());
    let mut renderer = TestRenderer::with_limits(
        MockContext,
        CacheLimits {
            image_entries: 1,
            image_bytes: 16,
            glyph_pages: 0,
            glyph_bytes: 0,
        },
    )
    .unwrap();
    let target = renderer.register_target(config()).unwrap();
    let mut resources = Resources::new();
    let list = image_list();
    let first = submit(&mut renderer, target, &list, &resources).unwrap();
    resources.revision += 1;
    resources.pixels.fill(31);
    assert_eq!(
        submit(&mut renderer, target, &list, &resources),
        Err(RenderError::Failed)
    );
    assert_eq!(renderer.cache_usage().image_bytes, 16);
    GL.with(|gl| {
        assert_eq!(
            gl.borrow().uploads.len(),
            2,
            "capacity failure precedes upload"
        )
    });
    renderer.retire(first);
    let second = submit(&mut renderer, target, &list, &resources).unwrap();
    assert_eq!(renderer.cache_usage().image_entries, 1);
    renderer.retire(second);
}
