use std::{cell::RefCell, rc::Rc};

use pocket_drivers::{
    DeviceTarget, FontView, PixelFormat, Rect as Region, RenderResources, Renderer, TexView,
};
use pocket_render_sifli_epic::{
    geom::{pack_wh, pack_xy},
    Capabilities, Cmd, EpicRenderer, ExecError, Executor, MaskId, Mirror, Rect, RenderStats,
    RendererConfig, TextureSource, Thresholds, TileId,
};
use pocket_spec::{draw_op, psm};

struct Resources {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    linear: bool,
}

impl Resources {
    fn new(width: u32, height: u32) -> Self {
        Self {
            pixels: (0..width * height)
                .flat_map(|i| [i.wrapping_mul(37) as u8, 83, 149, 255])
                .collect(),
            width,
            height,
            linear: true,
        }
    }
}

impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (32.0, 32.0)
    }
    fn raster_revision(&self) -> u64 {
        1
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        (handle == 1).then_some(TexView {
            pixels: &self.pixels,
            w: self.width,
            h: self.height,
            psm: psm::PSM_8888,
            palette: None,
            linear: self.linear,
        })
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

#[derive(Default)]
struct Recording {
    commands: Vec<Cmd>,
    pixels: Vec<u16>,
    stride: usize,
}

struct RecordingExecutor {
    caps: Capabilities,
    recording: Rc<RefCell<Recording>>,
    tiles: [Vec<u16>; 2],
    masks: [Vec<u8>; 2],
}

impl Executor for RecordingExecutor {
    fn caps(&self) -> Capabilities {
        self.caps
    }
    fn begin(&mut self, _: u64, width: u32, height: u32) -> Result<(), ExecError> {
        let mut r = self.recording.borrow_mut();
        r.stride = width as usize;
        r.pixels.resize((width * height) as usize, 0x39e7);
        Ok(())
    }
    fn submit(&mut self, cmds: &[Cmd]) -> Result<(), ExecError> {
        let mut r = self.recording.borrow_mut();
        r.commands.extend_from_slice(cmds);
        let stride = r.stride;
        for &cmd in cmds {
            match cmd {
                Cmd::Fill {
                    dst,
                    color: [red, green, blue],
                } => {
                    let color =
                        ((red as u16 >> 3) << 11) | ((green as u16 >> 2) << 5) | (blue as u16 >> 3);
                    for y in dst.y..dst.y + dst.h {
                        for x in dst.x..dst.x + dst.w {
                            r.pixels[y as usize * stride + x as usize] = color;
                        }
                    }
                }
                Cmd::TileOut { tile, src } => {
                    for y in 0..src.h {
                        for x in 0..src.w {
                            self.tiles[tile.0 as usize][(y * src.w + x) as usize] =
                                r.pixels[(src.y + y) as usize * stride + (src.x + x) as usize];
                        }
                    }
                }
                Cmd::TileIn { tile, dst } => {
                    for y in 0..dst.h {
                        for x in 0..dst.w {
                            r.pixels[(dst.y + y) as usize * stride + (dst.x + x) as usize] =
                                self.tiles[tile.0 as usize][(y * dst.w + x) as usize];
                        }
                    }
                }
                Cmd::Blit { .. } => {} // Geometry assertions below; not a HAL simulator.
                _ => panic!("unexpected command: {cmd:?}"),
            }
        }
        Ok(())
    }
    fn fence(&mut self) -> Result<(), ExecError> {
        Ok(())
    }
    fn end(&mut self) -> Result<(), ExecError> {
        Ok(())
    }
    fn mask_mut(&mut self, id: MaskId) -> &mut [u8] {
        &mut self.masks[id.0 as usize]
    }
    fn tile_mut(&mut self, id: TileId) -> &mut [u16] {
        &mut self.tiles[id.0 as usize]
    }
    unsafe fn register_texture(&mut self, _: &TextureSource<'_>) -> Result<u32, ExecError> {
        Ok(1)
    }
    fn release_texture(&mut self, _: u32) {}
}

fn caps() -> Capabilities {
    Capabilities {
        fill_opaque: true,
        fill_alpha: false,
        a8_blend: false,
        gradient: false,
        blit: true,
        blit_mirror_y: true,
        blit_quad: false,
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

fn render(
    words: &[u32],
    res: &Resources,
    region: Region,
    scale: u32,
    caps: Capabilities,
) -> (RenderStats, Rc<RefCell<Recording>>) {
    let recording = Rc::new(RefCell::new(Recording::default()));
    let executor = RecordingExecutor {
        caps,
        recording: recording.clone(),
        tiles: std::array::from_fn(|_| vec![0; caps.tile_pixels as usize]),
        masks: std::array::from_fn(|_| vec![0; caps.mask_bytes as usize]),
    };
    let mut renderer = EpicRenderer::new(
        RendererConfig {
            scale,
            max_textures: 4,
        },
        None,
        executor,
    )
    .unwrap();
    let target = DeviceTarget::new(
        1,
        Region::new(0, 0, 32 * scale, 32 * scale),
        PixelFormat::Rgb565,
    );
    let token = renderer
        .render_parts(words, res, &[region], &target)
        .unwrap();
    renderer.wait(&token).unwrap();
    renderer.retire(token);
    (renderer.stats(), recording)
}

fn quad(x: i32, y: i32, w: i32, h: i32, uv: [f32; 4]) -> Vec<u32> {
    vec![
        draw_op::TEX_QUAD,
        1,
        pack_xy(x, y),
        pack_wh(w, h),
        uv[0].to_bits(),
        uv[1].to_bits(),
        uv[2].to_bits(),
        uv[3].to_bits(),
        0xffff_ffff,
    ]
}

#[test]
fn scaled_damage_keeps_the_full_sampling_transform() {
    let res = Resources::new(3, 2);
    let words = quad(3, 4, 5, 7, [0.0, 0.0, 1.0, 1.0]);
    let (stats, recording) = render(&words, &res, Region::new(4, 6, 3, 4), 1, caps());
    assert_eq!(stats.software_ops, 0);
    assert_eq!(stats.epic_copies, 1);
    assert!(recording.borrow().commands.iter().any(|c| matches!(c,
        Cmd::Blit { src_rect, dst, clip, .. }
        if *src_rect == Rect { x: 0, y: 0, w: 3, h: 2 }
        && *dst == Rect { x: 3, y: 4, w: 5, h: 7 }
        && *clip == Rect { x: 4, y: 6, w: 3, h: 4 }
    )));
}

#[test]
fn atlas_mirroring_and_scissors_keep_the_transform_at_scale_two() {
    let res = Resources::new(16, 8);
    let mut words = vec![draw_op::SCISSOR, pack_xy(5, 7), pack_wh(5, 6)];
    words.extend(quad(3, 4, 11, 13, [0.75, 0.75, 0.25, 0.25]));
    words.push(draw_op::SCISSOR_POP);
    let (stats, recording) = render(&words, &res, Region::new(12, 16, 10, 12), 2, caps());
    assert_eq!(stats.software_ops, 0);
    assert!(recording.borrow().commands.iter().any(|c| matches!(c,
        Cmd::Blit { src_rect, dst, clip, mirror, .. }
        if *src_rect == Rect { x: 4, y: 2, w: 8, h: 4 }
        && *dst == Rect { x: 6, y: 8, w: 22, h: 26 }
        && *clip == Rect { x: 12, y: 16, w: 8, h: 10 }
        && *mirror == Mirror { x: true, y: true }
    )));
}

#[test]
fn offscreen_integral_crops_still_use_hardware() {
    let res = Resources::new(8, 8);
    let words = quad(-2, -1, 8, 8, [0.0, 0.0, 1.0, 1.0]);
    let (stats, recording) = render(&words, &res, Region::new(0, 0, 32, 32), 1, caps());
    assert_eq!(stats.software_ops, 0);
    assert!(recording.borrow().commands.iter().any(|c| matches!(c,
        Cmd::Blit { src_rect, dst, .. }
        if *src_rect == Rect { x: 2, y: 1, w: 6, h: 7 }
        && *dst == Rect { x: 0, y: 0, w: 6, h: 7 }
    )));
}

#[test]
fn fractional_source_edges_remain_on_cpu_without_rounding() {
    let res = Resources::new(8, 8);
    let words = quad(4, 5, 7, 9, [0.1, 0.1, 0.9, 0.9]);
    let (stats, recording) = render(&words, &res, Region::new(0, 0, 32, 32), 1, caps());
    assert_eq!(stats.epic_copies, 0);
    assert_eq!(stats.cpu_tile_pixels, 7 * 9);
    let mut expected = vec![0; 32 * 32];
    pocket_raster::render_scaled_rgb565(&res, &words, &mut expected, 1);
    assert_eq!(recording.borrow().pixels, expected);
}

#[test]
fn unsupported_triangles_copy_only_their_bounds_and_preserve_pixels() {
    let res = Resources::new(8, 8);
    let words = [
        draw_op::TRI,
        pack_xy(12, 6),
        pack_xy(18, 18),
        pack_xy(10, 20),
        0xff0000ff,
        0xff00ff00,
        0xffff0000,
    ];
    let (stats, recording) = render(&words, &res, Region::new(0, 0, 32, 32), 1, caps());
    assert!(stats.cpu_tile_pixels < 256);
    let mut expected = vec![0; 32 * 32];
    pocket_raster::render_scaled_rgb565(&res, &words, &mut expected, 1);
    assert_eq!(recording.borrow().pixels, expected);
}

#[test]
fn rotated_texture_pair_fallback_matches_full_software_rasterization() {
    let res = Resources::new(8, 8);
    let mut words = vec![draw_op::SCISSOR, pack_xy(5, 7), pack_wh(10, 15)];
    for vertices in [
        [
            (13, 6, 0.0f32, 0.0f32),
            (3, 20, 0.0, 1.0),
            (6, 22, 1.0, 1.0),
        ],
        [
            (13, 6, 0.0f32, 0.0f32),
            (6, 22, 1.0, 1.0),
            (16, 8, 1.0, 0.0),
        ],
    ] {
        words.extend([draw_op::TEX_TRI, 1]);
        for (x, y, u, v) in vertices {
            words.extend([pack_xy(x, y), u.to_bits(), v.to_bits()]);
        }
        words.push(0xcfff_ffff);
    }
    words.push(draw_op::SCISSOR_POP);
    let (stats, recording) = render(&words, &res, Region::new(0, 0, 32, 32), 1, caps());
    assert_eq!(stats.software_ops, 2);
    assert!(stats.cpu_tile_pixels <= 150);
    let mut expected = vec![0; 32 * 32];
    pocket_raster::render_scaled_rgb565(&res, &words, &mut expected, 1);
    assert_eq!(recording.borrow().pixels, expected);
}

#[test]
fn oversized_destination_keeps_an_addressable_integral_crop() {
    let res = Resources::new(16, 16);
    let words = quad(4, 5, 16, 16, [0.0, 0.0, 1.0, 1.0]);
    let mut caps = caps();
    caps.coordinate_limit = 8;
    let (stats, recording) = render(&words, &res, Region::new(6, 7, 5, 6), 1, caps);
    assert_eq!(stats.software_ops, 0);
    assert!(recording.borrow().commands.iter().any(|c| matches!(c,
        Cmd::Blit { src_rect, dst, clip, .. }
        if *src_rect == Rect { x: 2, y: 2, w: 5, h: 6 }
        && *dst == Rect { x: 6, y: 7, w: 5, h: 6 }
        && dst == clip
    )));
}
