//! A display whose refresh window spans its width receives every change as
//! whole rows. Changes that share rows are one run of rows: the display
//! transfers rows in ascending order and the renderer draws them once.
use pocket_drivers::*;
use pocket_runtime::coordinator::{Coordinator, RendererId};
use std::{cell::RefCell, rc::Rc};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 16;
const STRIDE: usize = WIDTH as usize * 4;

struct Resources;
impl RenderResources for Resources {
    fn raster_revision(&self) -> u64 {
        1
    }
    fn viewport(&self) -> (f32, f32) {
        (WIDTH as f32, HEIGHT as f32)
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

/// Opaque rectangles `(x, y, width, height, color)`.
fn scene(rects: &[(u32, u32, u32, u32, u32)]) -> DrawList {
    let mut list = DrawList::new();
    for &(x, y, w, h, color) in rects {
        list.words
            .extend([pocket_spec::draw_op::RECT, x | y << 16, w | h << 16, color]);
    }
    list
}

fn reference(list: &DrawList) -> Vec<u8> {
    let mut pixels = vec![0; STRIDE * HEIGHT as usize];
    let target = Surface::new(
        &mut pixels,
        Rect::new(0, 0, WIDTH, HEIGHT),
        STRIDE,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    let damage = [Rect::new(0, 0, WIDTH, HEIGHT)];
    let mut input = FrameInput::new(list, &Resources, &damage, Target::CpuVisible(target));
    let mut raster = pocket_raster::RasterRenderer::new(1).unwrap();
    raster.render(&mut input).unwrap();
    raster.wait(&()).unwrap();
    raster.retire(());
    pixels
}

#[derive(Default)]
struct Facts {
    /// The panel's frame memory.
    pixels: Vec<u8>,
    /// The rows of every flush after the first frame.
    flushed: Vec<Vec<Rect>>,
}

/// A panel with frame memory that takes whole rows of one strip in ascending
/// order, as `pocket_display_esp_lcd` does.
struct RowPanel {
    strip: Vec<u8>,
    region: Rect,
    facts: Rc<RefCell<Facts>>,
}
impl DisplayOutput for RowPanel {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            WIDTH,
            HEIGHT,
            PixelFormat::Rgba8888,
            STRIDE,
            TargetOwnership::CpuVisible,
        );
        descriptor.device_frame_storage = true;
        descriptor.partial_refresh = true;
        descriptor.refresh_granularity = [WIDTH, 1];
        descriptor.window_alignment = [WIDTH, 1];
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 0,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        self.region = region;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.strip,
            region,
            STRIDE,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<(), DisplayError> {
        let mut facts = self.facts.borrow_mut();
        let mut end = self.region.y;
        for r in regions {
            if r.x != 0
                || r.width != WIDTH
                || r.height == 0
                || r.y < end
                || r.y + r.height > self.region.y + self.region.height
            {
                return Err(DisplayError::InvalidTarget);
            }
            end = r.y + r.height;
            for y in r.y..end {
                let from = (y - self.region.y) as usize * STRIDE;
                let to = y as usize * STRIDE;
                facts.pixels[to..to + STRIDE].copy_from_slice(&self.strip[from..from + STRIDE]);
            }
        }
        facts.flushed.push(regions.to_vec());
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

fn panel(facts: Rc<RefCell<Facts>>) -> Coordinator {
    facts.borrow_mut().pixels = vec![0; STRIDE * HEIGHT as usize];
    // Four rows per strip.
    let budget = STRIDE * 4;
    let mut coordinator = Coordinator::new(1, budget).unwrap();
    coordinator
        .set_software_renderer(
            pocket_raster::RasterRenderer::new(1).unwrap(),
            pocket_raster::RasterRenderer::new,
        )
        .unwrap();
    let id = coordinator
        .add_display(
            RowPanel {
                strip: vec![0; budget],
                region: Rect::default(),
                facts,
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    assert_eq!(coordinator.strip_height(id), Some(4));
    coordinator
}

/// Present `first`, then `second`; return the rows flushed for `second`.
fn rows_after(
    first: &[(u32, u32, u32, u32, u32)],
    second: &[(u32, u32, u32, u32, u32)],
) -> Vec<(u32, u32)> {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut coordinator = panel(facts.clone());
    let list = scene(first);
    coordinator.present(&list, None, &Resources).unwrap();
    assert_eq!(facts.borrow().pixels, reference(&list));
    facts.borrow_mut().flushed.clear();
    let list = scene(second);
    coordinator
        .present(&list, None, &Resources)
        .expect("the panel takes the rows of the second frame");
    assert_eq!(facts.borrow().pixels, reference(&list));
    let rows: Vec<(u32, u32)> = facts
        .borrow()
        .flushed
        .iter()
        .flatten()
        .map(|r| (r.y, r.height))
        .collect();
    rows
}

const RED: u32 = 0xff00_00ff;
const BLUE: u32 = 0xffff_0000;

#[test]
fn changes_side_by_side_are_one_run_of_rows() {
    // Two rectangles far apart on rows 5..11 change colour.
    let rows = rows_after(
        &[(2, 5, 4, 6, RED), (50, 5, 4, 6, RED)],
        &[(2, 5, 4, 6, BLUE), (50, 5, 4, 6, BLUE)],
    );
    // Strips of four rows: 4..8, 8..12.
    assert_eq!(rows, [(5, 3), (8, 3)]);
}

#[test]
fn changes_on_overlapping_rows_are_merged() {
    // Rows 3..9 and 6..12.
    let rows = rows_after(
        &[(2, 3, 4, 6, RED), (50, 6, 4, 6, RED)],
        &[(2, 3, 4, 6, BLUE), (50, 6, 4, 6, BLUE)],
    );
    assert_eq!(rows, [(3, 1), (4, 4), (8, 4)]);
}

#[test]
fn rows_of_one_strip_arrive_in_ascending_order() {
    // The lower rectangle is first in the draw list: rows 14..16, then 12..13.
    let rows = rows_after(
        &[(2, 14, 4, 2, RED), (50, 12, 4, 1, RED)],
        &[(2, 14, 4, 2, BLUE), (50, 12, 4, 1, BLUE)],
    );
    assert_eq!(rows, [(12, 1), (14, 2)]);
}
