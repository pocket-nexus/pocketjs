use pocket_render::record::SurfaceQuad;
use pocket_render::{build, Backend, Batch, Emit, Fill, GlyphCell, Record, Source, Vertex};
use pocket_drivers::{DamageRect, RenderError};
use pocket_spec::draw_op::*;
use pocket_spec::GradDir;

const SCREEN: DamageRect = DamageRect::new(0, 0, 100, 50);
const WHITE: u32 = 1;

fn xy(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn wh(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct V {
    position: [f32; 2],
    uv: [f32; 2],
    color: u32,
    tag: u32,
}

impl Vertex for V {
    fn from_components(position: [f32; 2], uv: [f32; 2], color: u32) -> Self {
        Self {
            position,
            uv,
            color,
            tag: 0,
        }
    }
}

/// Images: handle 7 is texture 9 with no white patch, handle 8 is texture 10
/// with a white patch at (0.25, 0.75). Font slot 0 has 10 glyphs on two
/// pages (textures 20 and 21); slot 1 is unloaded.
#[derive(Default)]
struct Test {
    fills: Vec<u32>,
    accepted: Vec<&'static str>,
    reject_transparent: bool,
    reject_non_finite: bool,
    strip_diagonal: bool,
    surface: bool,
}

impl Backend for Test {
    type Vertex = V;
    type Texture = u32;
    type Clip = DamageRect;
    type GlyphData = u16;

    fn start(&self) -> Fill<u32> {
        Fill::point(WHITE, [0.5, 0.5])
    }

    fn clip(&self, clip: DamageRect) -> DamageRect {
        clip
    }

    fn fill(&mut self, texture: u32) -> Fill<u32> {
        self.fills.push(texture);
        if texture == 10 {
            Fill::point(10, [0.25, 0.75])
        } else {
            Fill::point(WHITE, [0.5, 0.5])
        }
    }

    fn image(&mut self, handle: i32) -> Result<Option<u32>, RenderError> {
        Ok(match handle {
            7 => Some(9),
            8 => Some(10),
            99 => return Err(RenderError::Failed),
            _ => None,
        })
    }

    fn glyph(&mut self, slot: u8, gid: u16) -> Result<Option<GlyphCell<u32, u16>>, RenderError> {
        if slot != 0 || gid >= 10 {
            return Ok(None);
        }
        let page = gid / 5;
        let column = (gid % 5) as f32;
        Ok(Some(GlyphCell {
            texture: 20 + page as u32,
            uv: [column * 0.2, 0.0, column * 0.2 + 0.2, 1.0],
            width: 8.0,
            height: 12.0,
            data: gid,
        }))
    }

    fn accepts(&mut self, record: &Record<'_>) -> Result<bool, RenderError> {
        Ok(match record {
            Record::Rect(rect) => {
                self.accepted.push("rect");
                rect.width > 0
                    && rect.height > 0
                    && !(self.reject_transparent && rect.color >> 24 == 0)
            }
            Record::GradRect(gradient) => {
                self.accepted.push("gradient");
                gradient.width > 0 && gradient.height > 0
            }
            Record::TexQuad(image) => {
                self.accepted.push("image");
                if self.reject_non_finite && image.uv1.iter().any(|value| !value.is_finite()) {
                    return Err(RenderError::InvalidFrame);
                }
                image.width > 0 && image.height > 0
            }
            _ => true,
        })
    }

    fn quad(
        &self,
        top_left: [f32; 2],
        bottom_right: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        colors: [u32; 4],
    ) -> [V; 6] {
        let standard: [V; 6] = pocket_render::quad(top_left, bottom_right, uv0, uv1, colors);
        if self.strip_diagonal {
            // TL, TR, BL / BL, TR, BR.
            [
                standard[0],
                standard[1],
                standard[5],
                standard[5],
                standard[1],
                standard[2],
            ]
        } else {
            standard
        }
    }

    fn emitted(&mut self, vertices: &mut [V], source: Source<u16>) {
        let tag = match source {
            Source::Fill => 0,
            Source::Image => 1,
            Source::Glyph(gid) => 100 + gid as u32,
            Source::Surface => 3,
        };
        for vertex in vertices {
            vertex.tag = tag;
        }
    }

    fn surface_quad(
        &mut self,
        emit: &mut Emit<'_, V, u32, DamageRect>,
        surface: &SurfaceQuad,
        clip: DamageRect,
    ) -> Result<(), RenderError> {
        if !self.surface {
            return Ok(());
        }
        let corners: [V; 6] = pocket_render::quad(
            [surface.x, surface.y],
            [surface.x + surface.width, surface.y + surface.height],
            [0.0; 2],
            [1.0; 2],
            [u32::MAX; 4],
        );
        let vertices = emit.detached(
            1000 + surface.surface,
            clip.intersect(surface.clip()),
            &corners,
        );
        self.emitted(vertices, Source::Surface);
        Ok(())
    }
}

type Built = (Vec<V>, Vec<Batch<u32, DamageRect>>);

fn run(backend: &mut Test, words: &[u32]) -> Result<Built, RenderError> {
    let mut vertices = vec![V::from_components([9.0; 2], [9.0; 2], 9)];
    let mut batches = vec![Batch {
        texture: 9,
        first: 9,
        count: 9,
        clip: SCREEN,
    }];
    build(backend, words, SCREEN, &mut vertices, &mut batches)?;
    Ok((vertices, batches))
}

fn keys(batches: &[Batch<u32, DamageRect>]) -> Vec<(u32, usize, usize)> {
    batches
        .iter()
        .map(|batch| (batch.texture, batch.first, batch.count))
        .collect()
}

#[test]
fn quads_and_triangles_keep_painter_order_corner_colors_and_fill_uvs() {
    let words = [
        GRAD_RECT,
        xy(-2, 3),
        wh(4, 5),
        0x8040_3020,
        0x8080_7060,
        GradDir::ToRight as u32,
        TRI,
        xy(7, 8),
        xy(-1, 2),
        xy(3, -4),
        0x8000_0001,
        0x8000_0002,
        0x8000_0003,
        RECT,
        xy(0, 0),
        wh(0, 5),
        0xff00_0000,
    ];
    let (vertices, batches) = run(&mut Test::default(), &words).unwrap();
    assert_eq!(
        vertices
            .iter()
            .map(|vertex| (vertex.position, vertex.color))
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
        ],
        "the caller's vectors are cleared and an empty rectangle adds nothing"
    );
    assert!(vertices[..6].iter().all(|vertex| vertex.uv == [0.5, 0.5]));
    assert!(vertices[6..].iter().all(|vertex| vertex.uv == [0.0, 0.0]));
    assert!(vertices.iter().all(|vertex| vertex.tag == 0));
    assert_eq!(keys(&batches), [(WHITE, 0, 9)]);
    assert_eq!(batches[0].clip, SCREEN);
}

#[test]
fn fills_sample_the_bound_image_until_the_bound_texture_changes() {
    let image = |handle: u32| {
        [
            TEX_QUAD,
            handle,
            xy(0, 0),
            wh(8, 8),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            u32::MAX,
        ]
    };
    let rect = [RECT, xy(8, 0), wh(8, 8), 0x8076_5432];
    let mut words = Vec::new();
    words.extend_from_slice(&rect);
    words.extend_from_slice(&image(8));
    words.extend_from_slice(&rect);
    words.extend_from_slice(&rect);
    words.extend_from_slice(&image(7));
    words.extend_from_slice(&rect);
    words.extend_from_slice(&image(8));
    let mut backend = Test::default();
    let (vertices, batches) = run(&mut backend, &words).unwrap();
    assert_eq!(
        backend.fills,
        [10, 9],
        "the fill is re-derived once per bound texture, starting from the white fill"
    );
    assert_eq!(
        keys(&batches),
        [
            (WHITE, 0, 6),
            (10, 6, 18),
            (9, 24, 6),
            (WHITE, 30, 6),
            (10, 36, 6)
        ]
    );
    assert!(vertices[..6].iter().all(|vertex| vertex.uv == [0.5, 0.5]));
    assert!(vertices[12..24]
        .iter()
        .all(|vertex| vertex.uv == [0.25, 0.75]));
    assert!(vertices[30..36]
        .iter()
        .all(|vertex| vertex.uv == [0.5, 0.5]));
    assert_eq!(
        vertices.iter().map(|vertex| vertex.tag).collect::<Vec<_>>(),
        [
            vec![0; 6],
            vec![1; 6],
            vec![0; 12],
            vec![1; 6],
            vec![0; 6],
            vec![1; 6]
        ]
        .concat()
    );
}

#[test]
fn clips_split_batches_and_equal_scissors_merge() {
    let rect = |color| [RECT, xy(2, 3), wh(4, 5), color];
    let colors = [0x80112233, 0x80445566, 0x80778899, 0x80aabbcc, 0x80ddeeff];
    let mut words = rect(colors[0]).to_vec();
    words.extend_from_slice(&[SCISSOR, xy(0, 0), wh(100, 50)]);
    words.extend_from_slice(&rect(colors[1]));
    words.push(SCISSOR_POP);
    words.extend_from_slice(&rect(colors[2]));
    words.extend_from_slice(&[SCISSOR, xy(0, 0), wh(50, 50)]);
    words.extend_from_slice(&rect(colors[3]));
    words.push(SCISSOR_POP);
    words.extend_from_slice(&rect(colors[4]));
    let (vertices, batches) = run(&mut Test::default(), &words).unwrap();
    assert_eq!(vertices.len(), 30);
    for (chunk, color) in vertices.chunks(6).zip(colors) {
        assert!(chunk.iter().all(|vertex| vertex.color == color));
    }
    assert_eq!(
        batches
            .iter()
            .map(|batch| (batch.first, batch.count, batch.clip.x1))
            .collect::<Vec<_>>(),
        [(0, 18, 100), (18, 6, 50), (24, 6, 100)]
    );
}

#[test]
fn glyph_runs_switch_pages_and_skip_unresolved_cells() {
    let words = [
        GLYPH_RUN,
        4 << 16,
        0xff11_2233,
        xy(0, 0),
        1,
        xy(8, 0),
        7,
        xy(16, 0),
        12,
        xy(24, 0),
        2,
        GLYPH_RUN,
        (1 << 16) | 1,
        0xff00_0000,
        xy(0, 20),
        0,
    ];
    let (vertices, batches) = run(&mut Test::default(), &words).unwrap();
    assert_eq!(
        vertices.len(),
        18,
        "gid 12 and the unloaded slot add nothing"
    );
    assert_eq!(vertices[0].position, [0.0, 0.0]);
    assert_eq!(vertices[2].position, [8.0, 12.0]);
    assert_eq!(vertices[0].uv, [0.2, 0.0]);
    assert_eq!(vertices[2].uv, [0.4, 1.0]);
    assert_eq!(
        vertices.iter().map(|vertex| vertex.tag).collect::<Vec<_>>(),
        [vec![101; 6], vec![107; 6], vec![102; 6]].concat()
    );
    assert_eq!(keys(&batches), [(20, 0, 6), (21, 6, 6), (20, 12, 6)]);
}

#[test]
fn the_texture_is_bound_before_the_backend_judges_a_record() {
    let words = [
        TEX_QUAD,
        8,
        xy(0, 0),
        wh(8, 8),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        f32::NAN.to_bits(),
        1.0f32.to_bits(),
        u32::MAX,
    ];
    let mut backend = Test {
        reject_non_finite: true,
        ..Test::default()
    };
    assert_eq!(run(&mut backend, &words), Err(RenderError::InvalidFrame));
    assert_eq!(backend.accepted, ["image"]);
    let mut backend = Test::default();
    let (vertices, batches) = run(&mut backend, &words).unwrap();
    assert_eq!(vertices.len(), 6);
    assert_eq!(keys(&batches), [(10, 0, 6)]);
    let missing = [TEX_QUAD, 5, xy(0, 0), wh(8, 8), 0, 0, 0, 0, u32::MAX];
    let mut backend = Test::default();
    assert_eq!(run(&mut backend, &missing).unwrap().0, []);
    assert!(
        backend.accepted.is_empty(),
        "a missing image skips the record"
    );
    let failing = [TEX_TRI, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        run(&mut Test::default(), &failing),
        Err(RenderError::Failed)
    );
}

#[test]
fn rejected_records_leave_batches_untouched() {
    let rect = [RECT, xy(2, 3), wh(4, 5), 0x0011_2233];
    let mut words = rect.to_vec();
    words.extend_from_slice(&[TEX_QUAD, 7, xy(0, 0), wh(0, 8), 0, 0, 0, 0, u32::MAX]);
    words.extend_from_slice(&[RECT, xy(2, 3), wh(4, 5), 0xff11_2233]);
    let mut backend = Test {
        reject_transparent: true,
        ..Test::default()
    };
    let (vertices, batches) = run(&mut backend, &words).unwrap();
    assert_eq!(vertices.len(), 6, "only the opaque rectangle draws");
    assert_eq!(keys(&batches), [(WHITE, 0, 6)]);
    assert_eq!(backend.accepted, ["rect", "image", "rect"]);
    assert_eq!(
        backend.fills,
        [9],
        "the fill follows the bound texture even when it drew nothing"
    );
}

#[test]
fn a_backend_quad_diagonal_applies_to_every_quad() {
    let words = [RECT, xy(0, 0), wh(4, 2), 0xff00_0001];
    let (vertices, _) = run(
        &mut Test {
            strip_diagonal: true,
            ..Test::default()
        },
        &words,
    )
    .unwrap();
    assert_eq!(
        vertices
            .iter()
            .map(|vertex| vertex.position)
            .collect::<Vec<_>>(),
        [
            [0.0, 0.0],
            [4.0, 0.0],
            [0.0, 2.0],
            [0.0, 2.0],
            [4.0, 0.0],
            [4.0, 2.0]
        ]
    );
}

#[test]
fn surface_quads_append_a_detached_batch_in_painter_order() {
    let rect = [RECT, xy(2, 3), wh(4, 5), 0xff11_2233];
    let mut words = rect.to_vec();
    words.extend_from_slice(&[
        SURFACE_QUAD,
        2,
        1.0f32.to_bits(),
        2.0f32.to_bits(),
        30.0f32.to_bits(),
        20.0f32.to_bits(),
        xy(1, 2),
        wh(30, 20),
        1,
    ]);
    words.extend_from_slice(&rect);
    let (vertices, batches) = run(
        &mut Test {
            surface: true,
            ..Test::default()
        },
        &words,
    )
    .unwrap();
    assert_eq!(vertices.len(), 18);
    assert_eq!(vertices[6].position, [1.0, 2.0]);
    assert_eq!(vertices[8].position, [31.0, 22.0]);
    assert!(vertices[6..12].iter().all(|vertex| vertex.tag == 3));
    assert_eq!(
        keys(&batches),
        [(WHITE, 0, 6), (1002, 6, 6), (WHITE, 12, 6)]
    );
    assert_eq!(batches[1].clip, DamageRect::new(1, 2, 31, 22));
    let (vertices, batches) = run(&mut Test::default(), &words).unwrap();
    assert_eq!(vertices.len(), 12, "the default backend draws no surface");
    assert_eq!(keys(&batches), [(WHITE, 0, 12)]);
}

#[test]
fn decode_errors_are_invalid_frames_and_text_runs_are_unsupported() {
    assert_eq!(
        run(&mut Test::default(), &[TEX_TRI, 0, xy(1, 2)]),
        Err(RenderError::InvalidFrame)
    );
    assert_eq!(
        run(&mut Test::default(), &[SCISSOR_POP]),
        Err(RenderError::InvalidFrame)
    );
    assert_eq!(
        run(&mut Test::default(), &[TEXT_RUN, 0, 0, 0, 0, 0, 0, 1, 0x61]),
        Err(RenderError::Unsupported)
    );
}
