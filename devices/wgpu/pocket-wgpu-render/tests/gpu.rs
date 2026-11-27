//! Real GPU readbacks. A missing adapter fails rather than skipping conformance.
use pocket_drivers::{
    DeviceTarget, DrawList, FontView, FrameInput, PixelFormat, Rect, RenderError, RenderResources,
    Renderer, Target, TexView,
};
use pocket_spec::{draw_op as op, psm};
use pocket_wgpu_render::{CacheLimits, TargetId, WgpuRenderer};

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
}
impl Gpu {
    fn new() -> Self {
        let instance = wgpu::Instance::new(&Default::default());
        let adapter = pollster::block_on(instance.request_adapter(&Default::default()))
            .expect("GPU required for wgpu driver tests");
        eprintln!("wgpu driver: {:?}", adapter.get_info());
        let (device, queue) =
            pollster::block_on(adapter.request_device(&Default::default())).unwrap();
        Self { device, queue }
    }
    fn renderer(&self) -> WgpuRenderer {
        WgpuRenderer::new(&self.device, &self.queue, wgpu::TextureFormat::Rgba8Unorm).unwrap()
    }
    fn output(&self) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("driver test output"),
            size: wgpu::Extent3d {
                width: 4,
                height: 4,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }
    fn register(&self, renderer: &mut WgpuRenderer, output: &wgpu::Texture) -> TargetId {
        renderer
            .register_target(
                &output.create_view(&Default::default()),
                (4, 4),
                1.0,
                wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            )
            .unwrap()
    }
    fn read(&self, texture: &wgpu::Texture) -> Vec<u8> {
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 4 * 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(4),
                },
            },
            texture.size(),
        );
        let index = self.queue.submit([encoder.finish()]);
        let (send, receive) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                send.send(result).unwrap()
            });
        self.device
            .poll(wgpu::PollType::WaitForSubmissionIndex(index))
            .unwrap();
        receive.recv().unwrap().unwrap();
        let mapped = buffer.slice(..).get_mapped_range();
        let pixels = (0..4)
            .flat_map(|row| mapped[row * 256..row * 256 + 16].to_vec())
            .collect();
        drop(mapped);
        buffer.unmap();
        pixels
    }
}
struct Resources {
    pixel: [u8; 4],
    revision: u64,
    font: Option<Vec<u8>>,
}
impl Resources {
    fn red() -> Self {
        Self {
            pixel: [255, 0, 0, 255],
            revision: 1,
            font: None,
        }
    }
    fn green(&mut self) {
        self.pixel = [0, 255, 0, 255];
        self.revision += 1;
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (4.0, 4.0)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        (handle == 7).then_some(TexView {
            pixels: &self.pixel,
            w: 1,
            h: 1,
            psm: psm::PSM_8888,
            palette: None,
            linear: false,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        if slot != 3 {
            return None;
        }
        self.font.as_ref().map(|bitmap| FontView {
            bitmap,
            cell_w: 2,
            cell_h: 2,
            raster_density: 1,
            glyph_count: 1,
        })
    }
}
fn image(width: u32) -> DrawList {
    let mut list = DrawList::new();
    list.words = vec![
        op::TEX_QUAD,
        7,
        0,
        width | (4 << 16),
        0,
        0,
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        u32::MAX,
    ];
    list
}
fn render(
    renderer: &mut WgpuRenderer,
    target: TargetId,
    list: &DrawList,
    resources: &Resources,
) -> Result<pocket_wgpu_render::Submission, RenderError> {
    let target = renderer.target(target)?;
    renderer.render(&mut FrameInput::new(
        list,
        resources,
        &[],
        Target::DeviceOwned(target),
    ))
}

#[test]
fn separate_encoders_copy_vertices_and_resource_versions_before_submission() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let a = gpu.output();
    let b = gpu.output();
    let mut resources = Resources::red();
    let mut first = gpu.device.create_command_encoder(&Default::default());
    renderer
        .encode(
            &resources,
            &image(2).words,
            &mut first,
            &a.create_view(&Default::default()),
            (4, 4),
            1.0,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        )
        .unwrap()
        .retain_in_encoder();
    resources.green();
    let mut second = gpu.device.create_command_encoder(&Default::default());
    renderer
        .encode(
            &resources,
            &image(4).words,
            &mut second,
            &b.create_view(&Default::default()),
            (4, 4),
            1.0,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        )
        .unwrap()
        .retain_in_encoder();
    resources.pixel.fill(0);
    drop(resources);
    // Both the lease and renderer may disappear. CommandBuffer owns the GPU
    // references, so no stale cache entry or rewritten vertex buffer is used.
    drop(renderer);
    gpu.queue.submit([first.finish(), second.finish()]);
    let mut expected = Vec::new();
    for _ in 0..4 {
        expected.extend([255, 0, 0, 255].repeat(2));
        expected.extend([0, 0, 0, 255].repeat(2));
    }
    assert_eq!(gpu.read(&a), expected);
    assert_eq!(gpu.read(&b), [0, 255, 0, 255].repeat(16));
}

#[test]
fn two_targets_retain_old_versions_until_reverse_retirement() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let a = gpu.output();
    let b = gpu.output();
    let ta = gpu.register(&mut renderer, &a);
    let tb = gpu.register(&mut renderer, &b);
    let mut resources = Resources::red();
    let first = render(&mut renderer, ta, &image(4), &resources).unwrap();
    resources.green();
    let second = render(&mut renderer, tb, &image(4), &resources).unwrap();
    assert_eq!(renderer.resident_images(), 2);
    assert_eq!(renderer.pending_submissions(), 2);
    renderer.wait(&second).unwrap();
    renderer.retire(second);
    assert_eq!(renderer.resident_images(), 2);
    assert!(renderer.unregister_target(ta));
    assert!(renderer.target(ta).is_err());
    renderer.wait(&first).unwrap();
    renderer.retire(first.clone());
    assert_eq!(renderer.wait(&first), Err(RenderError::InvalidFrame));
    renderer.retire(first); // Duplicate retirement cannot free another frame.
    assert_eq!(renderer.resident_images(), 1);
    assert_eq!(renderer.pending_submissions(), 0);
    assert_eq!(gpu.read(&a), [255, 0, 0, 255].repeat(16));
    assert_eq!(gpu.read(&b), [0, 255, 0, 255].repeat(16));
    let mut foreign = gpu.renderer();
    let foreign_id = gpu.register(&mut foreign, &a);
    let target = foreign.target(foreign_id).unwrap();
    assert!(
        renderer
            .render(&mut FrameInput::new(
                &image(4),
                &resources,
                &[],
                Target::DeviceOwned(target)
            ))
            .is_err()
    );
    let foreign_submission = render(&mut foreign, foreign_id, &image(4), &resources).unwrap();
    assert_eq!(
        renderer.wait(&foreign_submission),
        Err(RenderError::InvalidFrame)
    );
    renderer.retire(foreign_submission.clone());
    assert_eq!(foreign.pending_submissions(), 1);
    foreign.retire(foreign_submission);
}

#[test]
fn cache_pressure_keeps_pending_resources_and_early_retire_waits() {
    let gpu = Gpu::new();
    let mut renderer = WgpuRenderer::with_limits(
        &gpu.device,
        &gpu.queue,
        wgpu::TextureFormat::Rgba8Unorm,
        CacheLimits {
            image_entries: 1,
            image_bytes: 4,
            ..Default::default()
        },
    )
    .unwrap();
    let a = gpu.output();
    let b = gpu.output();
    let ta = gpu.register(&mut renderer, &a);
    let tb = gpu.register(&mut renderer, &b);
    let mut resources = Resources::red();
    let first = render(&mut renderer, ta, &image(4), &resources).unwrap();
    resources.green();
    assert!(matches!(
        render(&mut renderer, tb, &image(4), &resources),
        Err(RenderError::Failed)
    ));
    assert_eq!(renderer.pending_submissions(), 1);
    assert_eq!(renderer.resident_images(), 1);
    renderer.retire(first); // No prior wait call: the driver must wait itself.
    let second = render(&mut renderer, tb, &image(4), &resources).unwrap();
    renderer.retire(second);
    assert_eq!(gpu.read(&a), [255, 0, 0, 255].repeat(16));
    assert_eq!(gpu.read(&b), [0, 255, 0, 255].repeat(16));
}

#[test]
fn invalid_targets_words_and_resources_do_not_leave_submissions() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let output = gpu.output();
    let target = gpu.register(&mut renderer, &output);
    let mut resources = Resources::red();
    for words in [
        vec![op::RECT],
        vec![u32::MAX],
        vec![op::SCISSOR_POP],
        vec![op::SCISSOR, 0, 4 | (4 << 16)],
    ] {
        let mut list = DrawList::new();
        list.words = words;
        assert!(matches!(
            render(&mut renderer, target, &list, &resources),
            Err(RenderError::InvalidFrame)
        ));
    }
    let mut text = DrawList::new();
    text.words = vec![op::TEXT_RUN, 0, 0, 0, 0, 0, 0, 0];
    assert!(matches!(
        render(&mut renderer, target, &text, &resources),
        Err(RenderError::Unsupported)
    ));
    let mut malformed = renderer.target(target).unwrap();
    malformed.region = Rect::new(0, 0, 1, 1);
    assert!(
        renderer
            .render(&mut FrameInput::new(
                &image(4),
                &resources,
                &[],
                Target::DeviceOwned(malformed)
            ))
            .is_err()
    );
    let forged = DeviceTarget::new(u64::MAX, Rect::new(0, 0, 4, 4), PixelFormat::Rgba8888);
    assert!(
        renderer
            .render(&mut FrameInput::new(
                &image(4),
                &resources,
                &[],
                Target::DeviceOwned(forged)
            ))
            .is_err()
    );
    resources.font = Some(vec![255]);
    let mut glyph = DrawList::new();
    glyph.words = vec![op::GLYPH_RUN, 3 | (1 << 16), u32::MAX, 0, 0];
    assert!(matches!(
        render(&mut renderer, target, &glyph, &resources),
        Err(RenderError::InvalidFrame)
    ));
    assert_eq!(renderer.pending_submissions(), 0);
    let retry = render(&mut renderer, target, &image(4), &resources).unwrap();
    renderer.retire(retry);
    assert_eq!(gpu.read(&output), [255, 0, 0, 255].repeat(16));
}

#[test]
fn font_replacement_and_destruction_keep_submitted_pixels_alive() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let a = gpu.output();
    let b = gpu.output();
    let ta = gpu.register(&mut renderer, &a);
    let tb = gpu.register(&mut renderer, &b);
    let mut resources = Resources::red();
    resources.font = Some(vec![255; 4]);
    let mut list = DrawList::new();
    list.words = vec![op::GLYPH_RUN, 3 | (1 << 16), u32::MAX, 0, 0];
    let _first = render(&mut renderer, ta, &list, &resources).unwrap();
    resources.font = Some(vec![0; 4]);
    resources.revision += 1;
    let _second = render(&mut renderer, tb, &list, &resources).unwrap();
    assert_eq!(renderer.resident_fonts(), 2);
    drop(resources);
    drop(renderer); // No caller wait/retire: Drop must establish completion.
    let mut expected = [0, 0, 0, 255].repeat(16);
    for y in 0..2 {
        for x in 0..2 {
            expected[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4].fill(255);
        }
    }
    assert_eq!(gpu.read(&a), expected);
    assert_eq!(gpu.read(&b), [0, 0, 0, 255].repeat(16));
}

#[test]
fn incompatible_native_attachment_fails_terminally_and_driver_can_retry() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let incompatible = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("wrong renderer attachment format"),
        size: wgpu::Extent3d {
            width: 4,
            height: 4,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let bad = gpu.register(&mut renderer, &incompatible);
    let resources = Resources::red();
    assert!(matches!(
        render(&mut renderer, bad, &image(4), &resources),
        Err(RenderError::Failed)
    ));
    assert_eq!(renderer.pending_submissions(), 0);
    let output = gpu.output();
    let good = gpu.register(&mut renderer, &output);
    let submission = render(&mut renderer, good, &image(4), &resources).unwrap();
    renderer.retire(submission);
    assert_eq!(gpu.read(&output), [255, 0, 0, 255].repeat(16));
}

#[test]
fn shutdown_covers_submitted_work_without_a_registered_token() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let target = gpu.output();
    let view = target.create_view(&Default::default());
    let resources = Resources::red();
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    renderer
        .encode(
            &resources,
            &image(4).words,
            &mut encoder,
            &view,
            (4, 4),
            1.,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        )
        .unwrap()
        .retain_in_encoder();
    gpu.queue.submit([encoder.finish()]);
    assert_eq!(renderer.pending_submissions(), 0);
    assert_eq!(renderer.resident_images(), 1);
    let complete = Arc::new(AtomicBool::new(false));
    let completed = complete.clone();
    gpu.queue.on_submitted_work_done(move || {
        completed.store(true, Ordering::SeqCst);
    });
    renderer.shutdown();
    assert!(complete.load(Ordering::SeqCst));
    assert!(renderer.is_shutdown());
    assert_eq!(renderer.resident_images(), 0);
    assert_eq!(
        renderer.register_target(&view, (4, 4), 1., wgpu::LoadOp::Load),
        Err(RenderError::Failed)
    );
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    assert!(matches!(
        renderer.encode(
            &resources,
            &image(4).words,
            &mut encoder,
            &view,
            (4, 4),
            1.,
            wgpu::LoadOp::Load
        ),
        Err(RenderError::Failed)
    ));
    renderer.shutdown();
    assert_eq!(gpu.read(&target), [255, 0, 0, 255].repeat(16));
}

#[test]
fn shutdown_releases_cache_pins_left_by_a_resource_callback_panic() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    struct PanicResources(Resources);
    impl RenderResources for PanicResources {
        fn viewport(&self) -> (f32, f32) {
            self.0.viewport()
        }
        fn raster_revision(&self) -> u64 {
            1
        }
        fn texture(&self, id: i32) -> Option<TexView<'_>> {
            assert_ne!(id, 8, "resource callback failed after an earlier upload");
            self.0.texture(id)
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let target = gpu.output();
    let id = gpu.register(&mut renderer, &target);
    let mut list = image(4);
    let mut other = image(4);
    other.words[1] = 8;
    list.words.extend(other.words);
    let resources = PanicResources(Resources::red());
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let target = renderer.target(id).unwrap();
            let _ = renderer.render(&mut FrameInput::new(
                &list,
                &resources,
                &[],
                Target::DeviceOwned(target),
            ));
        }))
        .is_err()
    );
    assert_eq!(renderer.pending_submissions(), 0);
    assert_eq!(renderer.resident_images(), 1);
    renderer.shutdown();
    assert_eq!(renderer.resident_images(), 0);
    assert!(matches!(renderer.target(id), Err(RenderError::Failed)));
}

/// Paints every run as a 2×2 device-pixel block of its colour, offset one
/// logical pixel right of the origin, and counts the runs it painted.
struct BlockPainter(std::rc::Rc<std::cell::Cell<u32>>);
impl pocket_wgpu_render::TextPainter for BlockPainter {
    fn paint(
        &mut self,
        run: &pocket_wgpu_render::TextRunRequest<'_>,
    ) -> Option<pocket_wgpu_render::PaintedText> {
        self.0.set(self.0.get() + 1);
        if run.text.trim().is_empty() {
            return None;
        }
        let [r, g, b, a] = run.color.to_le_bytes();
        Some(pocket_wgpu_render::PaintedText {
            width: 2,
            height: 2,
            rgba: [r, g, b, a].repeat(4),
            offset: [1.0, 0.0],
        })
    }
}

fn text_run(text: &str, color: u32) -> DrawList {
    let bytes = text.as_bytes();
    let mut list = DrawList::new();
    list.words = vec![
        op::TEXT_RUN,
        0,
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        3.0f32.to_bits(),
        f32::NAN.to_bits(),
        color,
        bytes.len() as u32,
    ];
    for chunk in bytes.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        list.words.push(u32::from_le_bytes(word));
    }
    list
}

#[test]
fn text_runs_draw_the_painters_bitmap_modulated_by_the_run_alpha_and_reuse_it() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let output = gpu.output();
    let target = gpu.register(&mut renderer, &output);
    let resources = Resources::red();
    let painted = std::rc::Rc::new(std::cell::Cell::new(0));
    renderer.set_text_painter(Some(Box::new(BlockPainter(painted.clone()))));
    // opaque blue at (1,1)..(3,3)
    let submission = render(
        &mut renderer,
        target,
        &text_run("Hi", 0xffff_0000),
        &resources,
    )
    .unwrap();
    renderer.retire(submission);
    let pixels = gpu.read(&output);
    let at = |x: usize, y: usize| &pixels[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
    assert_eq!(at(1, 1), [0, 0, 255, 255]);
    assert_eq!(at(2, 2), [0, 0, 255, 255]);
    assert_eq!(at(0, 1), [0, 0, 0, 255]);
    assert_eq!(at(1, 0), [0, 0, 0, 255]);
    // the same run at half alpha reuses the bitmap and blends over black
    let submission = render(
        &mut renderer,
        target,
        &text_run("Hi", 0x80ff_0000),
        &resources,
    )
    .unwrap();
    renderer.retire(submission);
    assert_eq!(painted.get(), 1);
    assert_eq!(renderer.resident_text_runs(), 1);
    let pixels = gpu.read(&output);
    let blue = pixels[(4 + 1) * 4 + 2];
    assert!((126..=130).contains(&blue), "{blue}");
    // a run the painter draws nothing for draws nothing
    let submission = render(
        &mut renderer,
        target,
        &text_run("  ", 0xffff_ffff),
        &resources,
    )
    .unwrap();
    renderer.retire(submission);
    assert!(gpu.read(&output).chunks(4).all(|p| p == [0, 0, 0, 255]));
    // without a painter the operation is unsupported again
    renderer.set_text_painter(None);
    assert!(matches!(
        render(
            &mut renderer,
            target,
            &text_run("Hi", 0xffff_ffff),
            &resources
        ),
        Err(RenderError::Unsupported)
    ));
}

#[test]
fn transformed_text_runs_draw_the_bitmap_through_their_matrix() {
    let gpu = Gpu::new();
    let mut renderer = gpu.renderer();
    let output = gpu.output();
    let target = gpu.register(&mut renderer, &output);
    let resources = Resources::red();
    renderer.set_text_painter(Some(Box::new(BlockPainter(Default::default()))));
    // a run at origin (4, 1): its 2x2 block at (5..7, 1..3) lies off the 4x4 target; mirrored
    // about the origin's vertical axis (x' = 4 - (x - 4)) it lands on (1..3, 1..3)
    let mut list = text_run("Hi", 0xffff_0000);
    list.words[0] = op::TEXT_RUN_XF;
    list.words[2] = 4.0f32.to_bits();
    for (k, v) in [-1.0f32, 0.0, 0.0, 1.0].iter().enumerate() {
        list.words.insert(8 + k, v.to_bits());
    }
    let submission = render(&mut renderer, target, &list, &resources).unwrap();
    renderer.retire(submission);
    let pixels = gpu.read(&output);
    let at = |x: usize, y: usize| &pixels[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
    assert_eq!(at(1, 1), [0, 0, 255, 255]);
    assert_eq!(at(2, 2), [0, 0, 255, 255]);
    assert_eq!(at(0, 1), [0, 0, 0, 255]);
    assert_eq!(at(3, 2), [0, 0, 0, 255]);
}
