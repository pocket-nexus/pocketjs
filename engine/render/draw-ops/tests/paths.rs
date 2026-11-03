//! The forwarding crate keeps every public path and names the same items.

use core::any::TypeId;
use pocket_drivers::DamageRect;
use pocket_spec::draw_op;

type Walk = fn(
    &mut NoBackend,
    &[u32],
    DamageRect,
    &mut Vec<Point>,
    &mut Vec<pocket_render::Batch<u8, u8>>,
) -> Result<(), pocket_drivers::RenderError>;

#[test]
fn paths_name_the_pocket_render_items() {
    assert_eq!(
        TypeId::of::<pocket_draw_ops::DrawOps<'static>>(),
        TypeId::of::<pocket_render::DrawOps<'static>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Operation<'static>>(),
        TypeId::of::<pocket_render::Operation<'static>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::DecodeError>(),
        TypeId::of::<pocket_render::DecodeError>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Record<'static>>(),
        TypeId::of::<pocket_render::record::Record<'static>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Corners>(),
        TypeId::of::<pocket_render::record::Corners>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::record::SurfaceQuad>(),
        TypeId::of::<pocket_render::record::SurfaceQuad>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Batch<u8, u8>>(),
        TypeId::of::<pocket_render::batch::Batch<u8, u8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::batch::Batch<u8, u8>>(),
        TypeId::of::<pocket_render::Batch<u8, u8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Fill<u8>>(),
        TypeId::of::<pocket_render::build::Fill<u8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::GlyphCell<u8, u8>>(),
        TypeId::of::<pocket_render::build::GlyphCell<u8, u8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_draw_ops::Source<u8>>(),
        TypeId::of::<pocket_render::build::Source<u8>>()
    );
    assert_eq!(
        pocket_draw_ops::DRAW_LIST_VERSION,
        pocket_render::DRAW_LIST_VERSION
    );
    assert_eq!(
        pocket_draw_ops::MAX_CLIP_DEPTH,
        pocket_render::MAX_CLIP_DEPTH
    );

    let words = [draw_op::RECT, 0x0002_0001, 0x0004_0003, 0xff00_00ff];
    let viewport = DamageRect::new(0, 0, 320, 240);
    assert_eq!(pocket_draw_ops::word_len(&words, 0), Ok(4));
    assert_eq!(pocket_draw_ops::validate(&words, viewport), Ok(()));
    assert_eq!(pocket_draw_ops::xy(words[1]), (1, 2));
    assert_eq!(pocket_draw_ops::wh(words[2]), (3, 4));
    assert_eq!(
        pocket_draw_ops::logical_rect(words[1], words[2]),
        DamageRect::new(1, 2, 4, 6)
    );
    let operation = pocket_draw_ops::DrawOps::new(&words, viewport)
        .next()
        .unwrap()
        .unwrap();
    assert!(matches!(
        pocket_draw_ops::record(operation.words),
        Ok(pocket_draw_ops::Record::Rect(_))
    ));
    assert!(matches!(
        pocket_draw_ops::record::record(operation.words),
        Ok(pocket_render::record::Record::Rect(_))
    ));
    let corners = pocket_draw_ops::gradient_corners(1, 2, 0);
    assert_eq!(corners, pocket_render::gradient_corners(1, 2, 0));
    let mut vertices = Vec::new();
    let mut batches = Vec::new();
    vertices.extend_from_slice(&pocket_draw_ops::quad::<Point>(
        [0.0; 2], [1.0; 2], [0.0; 2], [1.0; 2], [7; 4],
    ));
    vertices.extend_from_slice(&pocket_draw_ops::batch::triangle::<Point>(
        [[0.0; 2]; 3],
        [[0.0; 2]; 3],
        [7; 3],
    ));
    pocket_draw_ops::append_batch(&mut batches, 1u8, 2u8, 0..9);
    assert_eq!(
        batches,
        [pocket_render::Batch {
            texture: 1,
            first: 0,
            count: 9,
            clip: 2
        }]
    );
    assert_eq!(vertices.len(), 9);
    let walk: Walk = pocket_draw_ops::build::build::<NoBackend>;
    let walked: Result<(), pocket_drivers::RenderError> =
        walk(&mut NoBackend, &[], viewport, &mut vertices, &mut batches);
    assert_eq!(walked, Ok(()));
    requires_render_traits::<Point>();
}

fn requires_render_traits<V: pocket_render::Vertex + pocket_draw_ops::Vertex>() {}

#[derive(Clone, Copy)]
struct Point;
impl pocket_draw_ops::Vertex for Point {
    fn from_components(_: [f32; 2], _: [f32; 2], _: u32) -> Self {
        Point
    }
}

struct NoBackend;
impl pocket_draw_ops::Backend for NoBackend {
    type Vertex = Point;
    type Texture = u8;
    type Clip = u8;
    type GlyphData = ();
    fn start(&self) -> pocket_draw_ops::Fill<u8> {
        pocket_render::build::Fill::point(0, [0.0; 2])
    }
    fn clip(&self, _: DamageRect) -> u8 {
        0
    }
    fn fill(&mut self, _: u8) -> pocket_render::build::Fill<u8> {
        pocket_draw_ops::Fill::point(0, [0.0; 2])
    }
    fn image(&mut self, _: i32) -> Result<Option<u8>, pocket_drivers::RenderError> {
        Ok(None)
    }
    fn glyph(
        &mut self,
        _: u8,
        _: u16,
    ) -> Result<Option<pocket_draw_ops::GlyphCell<u8, ()>>, pocket_drivers::RenderError> {
        Ok(None)
    }
    fn surface_quad(
        &mut self,
        _: &mut pocket_draw_ops::Emit<'_, Point, u8, u8>,
        _: &pocket_draw_ops::record::SurfaceQuad,
        _: DamageRect,
    ) -> Result<(), pocket_drivers::RenderError> {
        Ok(())
    }
}
