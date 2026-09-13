//! Execute DrawList fixtures on the selected GPU, then read back the result.
//! CI must install a GPU driver (Mesa Vulkan is sufficient); absence fails.
use super::UiRenderer;
use pocket3d::gpu::{Gpu, OffscreenTarget};
use pocketjs_core::{
    Ui, compositor, raster,
    spec::{self, draw_op as op},
};

fn packed(x: u16, y: u16) -> u32 {
    x as u32 | ((y as u32) << 16)
}
fn target(gpu: &Gpu, size: u32, format: wgpu::TextureFormat) -> OffscreenTarget {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("DrawList fixture"),
        size: wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    OffscreenTarget {
        texture,
        view,
        size: (size, size),
    }
}
fn draw(
    gpu: &Gpu,
    renderer: &mut UiRenderer,
    ui: &Ui,
    words: &[u32],
    out: &OffscreenTarget,
    scale: u32,
) -> Vec<u8> {
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    renderer
        .render_words_scaled(
            gpu,
            ui,
            words,
            &mut encoder,
            &out.view,
            out.size,
            scale as f32,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        )
        .unwrap();
    gpu.queue.submit([encoder.finish()]);
    out.read_rgba(gpu).unwrap()
}
fn close(actual: &[u8], expected: &[u8], tolerance: u8) {
    assert_eq!(actual.len(), expected.len());
    for (i, (&a, &e)) in actual.iter().zip(expected).enumerate() {
        assert!(
            a.abs_diff(e) <= tolerance,
            "byte {i}: GPU {a}, software {e}"
        );
    }
}
fn image(handle: i32, x: u16, y: u16, w: u16, h: u16) -> [u32; 9] {
    [
        op::TEX_QUAD,
        handle as u32,
        packed(x, y),
        packed(w, h),
        0,
        0,
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xffffffff,
    ]
}
fn font(coverage: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend(spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend([2, 2, 1, 2, 3, 0, 1, 0]); // slot 3, one 2x2 glyph
    bytes.extend(65u32.to_le_bytes());
    bytes.extend([0, 0, 2, 0]);
    bytes.extend([coverage; 4]);
    bytes
}

#[test]
fn gpu_drawlist_composition_and_resource_lifecycle() {
    let gpu = Gpu::new_headless().expect("GPU required for DrawList conformance");
    eprintln!("DrawList conformance: {:?}", gpu.adapter.get_info());
    for scale in [1, 2] {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 16.0);
        let out = target(&gpu, 16 * scale, wgpu::TextureFormat::Rgba8Unorm);
        let mut renderer = UiRenderer::new(&gpu, wgpu::TextureFormat::Rgba8Unorm);
        let mut words = vec![op::RECT, 0, packed(16, 16), 0xff204060];
        words.extend([
            op::SCISSOR,
            packed(2, 2),
            packed(8, 8),
            op::RECT,
            0,
            packed(16, 16),
            0x808020e0,
            op::SCISSOR_POP,
        ]);
        let mut expected = vec![0; (16 * scale * 16 * scale * 4) as usize];
        raster::render_scaled(&ui, &words, &mut expected, scale);
        close(
            &draw(&gpu, &mut renderer, &ui, &words, &out, scale),
            &expected,
            1,
        );

        // Gradient directions and both triangle modes use physical samples.
        for dir in [
            spec::GradDir::ToTop,
            spec::GradDir::ToBottom,
            spec::GradDir::ToLeft,
            spec::GradDir::ToRight,
        ] {
            let w = [
                op::GRAD_RECT,
                0,
                packed(16, 16),
                0xff204080,
                0xffe0a010,
                dir as u32,
            ];
            raster::render_scaled(&ui, &w, &mut expected, scale);
            close(
                &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
                &expected,
                1,
            );
        }
        let w = [
            op::TRI,
            0,
            packed(16, 0),
            packed(16, 16),
            0xff204080,
            0xff80a040,
            0xffe0a040,
            op::TRI,
            0,
            packed(16, 16),
            packed(0, 16),
            0xff204080,
            0xffe0a040,
            0xff804080,
        ];
        raster::render_scaled(&ui, &w, &mut expected, scale);
        close(
            &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
            &expected,
            1,
        );
        let handle = ui.upload_texture(&[64, 128, 192, 255], 1, 1, spec::psm::PSM_8888);
        let one = 1.0f32.to_bits();
        let w = [
            op::TEX_TRI,
            handle as u32,
            0,
            0,
            0,
            packed(16, 0),
            one,
            0,
            packed(16, 16),
            one,
            one,
            0xffffffff,
            op::TEX_TRI,
            handle as u32,
            0,
            0,
            0,
            packed(16, 16),
            one,
            one,
            packed(0, 16),
            0,
            one,
            0xffffffff,
        ];
        raster::render_scaled(&ui, &w, &mut expected, scale);
        close(
            &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
            &expected,
            0,
        );
        ui.free_texture(handle);
        // Every image format, then a freed handle followed by a solid rectangle.
        for (psm, data) in [
            (spec::psm::PSM_8888, vec![32, 64, 128, 128]),
            (spec::psm::PSM_5650, vec![0x1f, 0x78]),
            (spec::psm::PSM_4444, vec![0x84, 0x8c]),
        ] {
            let handle = ui.upload_texture(&data, 1, 1, psm);
            assert!(handle >= 0);
            let w = image(handle, 0, 0, 16, 16);
            raster::render_scaled(&ui, &w, &mut expected, scale);
            close(
                &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
                &expected,
                1,
            );
            ui.free_texture(handle);
            let mut stale = w.to_vec();
            stale.extend([op::RECT, packed(2, 2), packed(4, 4), 0xff802040]);
            raster::render_scaled(&ui, &stale, &mut expected, scale);
            close(
                &draw(&gpu, &mut renderer, &ui, &stale, &out, scale),
                &expected,
                0,
            );
        }
        let mut palette = vec![0u8; 1024];
        palette[..4].copy_from_slice(&[64, 128, 192, 255]);
        let mut t8 = palette.clone();
        t8.push(0);
        let handle = ui.upload_texture(&t8, 1, 1, spec::psm::PSM_T8);
        let w = image(handle, 0, 0, 16, 16);
        for color in [[64, 128, 192, 255], [192, 32, 64, 255]] {
            palette[..4].copy_from_slice(&color);
            assert!(ui.update_texture_t8(handle, &palette, &[0]));
            raster::render_scaled(&ui, &w, &mut expected, scale);
            close(
                &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
                &expected,
                0,
            );
        }

        // Same glyph count and metrics with new coverage must refresh the atlas.
        let w = [op::GLYPH_RUN, 3 | (1 << 16), 0xff80c0ff, packed(2, 2), 0];
        for coverage in [255, 0, 128] {
            assert!(ui.load_font_atlas(&font(coverage)));
            raster::render_scaled(&ui, &w, &mut expected, scale);
            close(
                &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
                &expected,
                1,
            );
        }

        // The child has its own texture namespace, and an unclipped full origin.
        let mut child_ui = Ui::new();
        child_ui.set_viewport(16.0, 16.0);
        let child_handle = child_ui.upload_texture(&[255, 128, 32, 255], 1, 1, spec::psm::PSM_8888);
        let mut child_words = image(child_handle, 0, 0, 16, 16).to_vec();
        child_words.extend([op::RECT, packed(8, 0), packed(8, 16), 0xff804020]);
        let child_target = target(&gpu, 16 * scale, wgpu::TextureFormat::Rgba8Unorm);
        let mut child_renderer = UiRenderer::new(&gpu, wgpu::TextureFormat::Rgba8Unorm);
        let child_pixels = draw(
            &gpu,
            &mut child_renderer,
            &child_ui,
            &child_words,
            &child_target,
            scale,
        );
        renderer.set_surface(&gpu, 7, &child_target.view, (16, 16));
        let mut w = vec![
            op::RECT,
            0,
            packed(16, 16),
            0xff102030,
            op::SCISSOR,
            packed(2, 2),
            packed(10, 10),
        ];
        w.extend([
            op::SURFACE_QUAD,
            7,
            (-4.0f32).to_bits(),
            0,
            16.0f32.to_bits(),
            16.0f32.to_bits(),
            packed(2, 2),
            packed(10, 10),
            0,
        ]);
        w.extend([
            op::RECT,
            packed(0, 10),
            packed(16, 2),
            0xff20e040,
            op::SCISSOR_POP,
            op::RECT,
            packed(0, 14),
            packed(16, 2),
            0xff503010,
        ]);
        let mut surfaces = vec![None; 8];
        surfaces[7] = Some(compositor::CompositorRaster {
            pixels: child_pixels,
            width: 16,
            height: 16,
            density: scale,
        });
        compositor::render(&ui, &w, &mut expected, scale, &surfaces);
        close(
            &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
            &expected,
            0,
        );
        renderer.retain_surfaces(|_| false);
        compositor::render(&ui, &w, &mut expected, scale, &[]);
        close(
            &draw(&gpu, &mut renderer, &ui, &w, &out, scale),
            &expected,
            0,
        );

        // Bad lengths must fail before encoding or resource submission.
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        for bad in [
            &[op::SURFACE_QUAD, 1][..],
            &[op::GLYPH_RUN, u32::MAX][..],
            &[u32::MAX][..],
        ] {
            assert!(
                renderer
                    .render_words(
                        &gpu,
                        &ui,
                        bad,
                        &mut encoder,
                        &out.view,
                        out.size,
                        wgpu::LoadOp::Load
                    )
                    .is_err()
            );
        }
    }
    // Existing sRGB overlay target keeps its established color interpretation.
    let ui = Ui::new();
    let out = target(&gpu, 16, wgpu::TextureFormat::Rgba8UnormSrgb);
    let mut renderer = UiRenderer::new(&gpu, wgpu::TextureFormat::Rgba8UnormSrgb);
    let pixels = draw(
        &gpu,
        &mut renderer,
        &ui,
        &[op::RECT, 0, packed(16, 16), 0xff806040],
        &out,
        1,
    );
    close(&pixels, &[64, 96, 128, 255].repeat(256), 1);
}
