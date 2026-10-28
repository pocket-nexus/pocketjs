//! Presentation through a `retained_move` display: the display moves pixels
//! that only moved, reports host damage, and every frame must equal a full
//! software render.

use std::{cell::RefCell, rc::Rc};

use pocket_drivers::{
    BufferIdentity, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, DrawList,
    FontView, PixelFormat, Rect, RenderResources, Surface, Target, TargetOwnership, TexView,
    VsyncSource, HOST_DAMAGE_RECTS,
};
use pocket_present::{Coordinator, PresentError, RendererId};
use pocket_spec as spec;

const W: i32 = 64;
const H: i32 = 48;
const FORMAT: PixelFormat = PixelFormat::Rgb565;
/// Staging bytes the display hands out before the renderer paints them.
const UNPAINTED: u8 = 0x5a;

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (W as f32, H as f32)
    }
    fn raster_revision(&self) -> u64 {
        1
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

fn xy_word(x: i16, y: i16) -> u32 {
    x as u16 as u32 | (y as u16 as u32) << 16
}
fn wh_word(w: u16, h: u16) -> u32 {
    w as u32 | (h as u32) << 16
}

/// A RECT or GRAD_RECT clipped to the screen the way the core emits it.
fn clipped(code: u32, x: i32, y: i32, w: i32, h: i32, colors: &[u32]) -> Vec<u32> {
    let (x0, y0, x1, y1) = (x.max(0), y.max(0), (x + w).min(W), (y + h).min(H));
    if x0 >= x1 || y0 >= y1 {
        return Vec::new();
    }
    let mut op = vec![
        code,
        xy_word(x0 as i16, y0 as i16),
        wh_word((x1 - x0) as u16, (y1 - y0) as u16),
    ];
    op.extend_from_slice(colors);
    op
}

/// Opaque gradient rows with a translucent bar each, scrolled up by `scroll`.
fn rows(scroll: i32) -> DrawList {
    let mut words = clipped(spec::draw_op::RECT, 0, 0, W, H, &[0xff00_0000]);
    for row in 0..10 {
        let y = row * 8 - scroll;
        let colors = [0xff00_40f0 + row as u32, 0xff00_20c0 + row as u32, 1];
        if y >= 0 && y + 8 <= H {
            words.extend(clipped(spec::draw_op::GRAD_RECT, 0, y, W, 8, &colors));
        } else if y + 8 > 0 && y < H {
            // Partially visible gradients stay unclipped inside a scissor.
            words.extend([
                spec::draw_op::SCISSOR,
                xy_word(0, 0),
                wh_word(W as u16, H as u16),
                spec::draw_op::GRAD_RECT,
                xy_word(0, y as i16),
                wh_word(W as u16, 8),
                colors[0],
                colors[1],
                spec::GradDir::ToBottom as u32,
                spec::draw_op::SCISSOR_POP,
            ]);
        }
        words.extend(clipped(
            spec::draw_op::RECT,
            4,
            y + 2,
            20 + row * 3,
            4,
            &[0xc0ff_ffff],
        ));
    }
    let mut list = DrawList::new();
    list.words = words;
    list
}

#[derive(Default)]
struct Log {
    moves: Vec<(Rect, i32, i32)>,
    flushed: Vec<Rect>,
}

/// Retained RGB565 frame storage behind a CPU staging buffer: a flush
/// transfers only the flushed rectangles, so a pixel the frame's damage
/// omits keeps its retained value and an unpainted damaged pixel shows.
struct MoveDisplay {
    descriptor: DisplayDescriptor,
    staging: Vec<u8>,
    region: Rect,
    screen: Rc<RefCell<Vec<u8>>>,
    log: Rc<RefCell<Log>>,
    host: Rc<RefCell<Vec<Rect>>>,
    decline_moves: bool,
}

impl MoveDisplay {
    fn new(scale: u32, strip_rows: u32) -> Self {
        let (width, height) = (W as u32 * scale, H as u32 * scale);
        let stride = FORMAT.row_bytes(width).unwrap();
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            width,
            height,
            FORMAT,
            stride,
            TargetOwnership::CpuVisible,
        );
        descriptor.device_frame_storage = true;
        descriptor.partial_refresh = true;
        descriptor.retained_move = true;
        Self {
            descriptor,
            staging: vec![0; stride * strip_rows as usize],
            region: Rect::default(),
            screen: Rc::new(RefCell::new(vec![0; stride * height as usize])),
            log: Rc::default(),
            host: Rc::default(),
            decline_moves: false,
        }
    }
}

impl DisplayOutput for MoveDisplay {
    type Token = Vec<Rect>;
    fn descriptor(&self) -> DisplayDescriptor {
        self.descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 1,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        self.region = region;
        self.staging.fill(UNPAINTED);
        Surface::new(
            &mut self.staging,
            region,
            self.descriptor.stride_bytes,
            FORMAT,
        )
        .map(Target::CpuVisible)
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<Vec<Rect>, DisplayError> {
        let r = self.region;
        for rect in regions {
            assert!(
                rect.x + rect.width <= r.x + r.width
                    && rect.y >= r.y
                    && rect.y + rect.height <= r.y + r.height,
                "flushed {rect:?} outside the acquired {r:?}"
            );
        }
        self.log.borrow_mut().flushed.extend_from_slice(regions);
        Ok(regions.to_vec())
    }
    fn wait(&mut self, regions: Vec<Rect>) -> Result<(), DisplayError> {
        let stride = self.descriptor.stride_bytes;
        let mut screen = self.screen.borrow_mut();
        for rect in regions {
            let (x, bytes) = (rect.x as usize * 2, rect.width as usize * 2);
            for row in rect.y..rect.y + rect.height {
                let source = (row - self.region.y) as usize * stride + x;
                let target = row as usize * stride + x;
                screen[target..target + bytes]
                    .copy_from_slice(&self.staging[source..source + bytes]);
            }
        }
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
    fn move_pixels(&mut self, destination: Rect, dx: i32, dy: i32) -> Result<(), DisplayError> {
        self.log.borrow_mut().moves.push((destination, dx, dy));
        if self.decline_moves {
            return Err(DisplayError::Unsupported);
        }
        let stride = self.descriptor.stride_bytes;
        let mut screen = self.screen.borrow_mut();
        let before = screen.clone();
        for y in destination.y..destination.y + destination.height {
            for x in destination.x..destination.x + destination.width {
                let from = (y as i32 - dy) as usize * stride + (x as i32 - dx) as usize * 2;
                let to = y as usize * stride + x as usize * 2;
                screen[to..to + 2].copy_from_slice(&before[from..from + 2]);
            }
        }
        Ok(())
    }
    fn host_damage(&mut self, out: &mut [Rect; HOST_DAMAGE_RECTS]) -> usize {
        let host = self.host.borrow();
        out[..host.len()].copy_from_slice(&host);
        host.len()
    }
}

fn full_render(list: &DrawList, scale: u32) -> Vec<u8> {
    let (width, height) = (W as u32 * scale, H as u32 * scale);
    let stride = FORMAT.row_bytes(width).unwrap();
    let mut pixels = vec![0; stride * height as usize];
    let mut surface =
        Surface::new(&mut pixels, Rect::new(0, 0, width, height), stride, FORMAT).unwrap();
    pocket_raster::render_surface(&Resources, &list.words, &mut surface, scale).unwrap();
    pixels
}

fn area(rects: &[Rect]) -> u64 {
    rects
        .iter()
        .map(|r| u64::from(r.width) * u64::from(r.height))
        .sum()
}

#[test]
fn scrolled_rows_move_on_the_display_and_the_frame_equals_a_full_render() {
    for scale in [1, 2] {
        let display = MoveDisplay::new(scale, 8 * scale);
        let (screen, log) = (display.screen.clone(), display.log.clone());
        let budget = display.descriptor.stride_bytes * 8 * scale as usize;
        let mut coordinator = Coordinator::new(scale, budget).unwrap();
        coordinator
            .add_display(display, RendererId::SOFTWARE)
            .unwrap();
        coordinator.present(&rows(0), None, &Resources).unwrap();
        assert_eq!(*screen.borrow(), full_render(&rows(0), scale));
        assert!(
            log.borrow().moves.is_empty(),
            "a first frame has no history"
        );

        log.borrow_mut().flushed.clear();
        coordinator.present(&rows(3), None, &Resources).unwrap();
        assert_eq!(*screen.borrow(), full_render(&rows(3), scale));
        let log = log.borrow();
        let [(destination, dx, dy)] = log.moves[..] else {
            panic!("one move expected, got {:?}", log.moves);
        };
        // The move is in physical pixels: logical offsets times the scale.
        assert_eq!((dx, dy), (0, -3 * scale as i32));
        assert_eq!((destination.x, destination.width), (0, W as u32 * scale));
        let full = u64::from(W as u32 * scale) * u64::from(H as u32 * scale);
        assert!(
            area(&log.flushed) < full / 2,
            "only rows the move did not supply are repainted: {:?}",
            log.flushed
        );
    }
}

#[test]
fn a_declined_move_repaints_its_destination() {
    let mut display = MoveDisplay::new(2, 96);
    display.decline_moves = true;
    let (screen, log) = (display.screen.clone(), display.log.clone());
    let budget = display.descriptor.stride_bytes * 96;
    let mut coordinator = Coordinator::new(2, budget).unwrap();
    coordinator
        .add_display(display, RendererId::SOFTWARE)
        .unwrap();
    coordinator.present(&rows(0), None, &Resources).unwrap();
    coordinator.present(&rows(3), None, &Resources).unwrap();
    assert_eq!(log.borrow().moves.len(), 1, "the move was offered");
    assert_eq!(*screen.borrow(), full_render(&rows(3), 2));
}

#[test]
fn host_damage_is_repainted_when_the_words_do_not_change() {
    let display = MoveDisplay::new(2, 96);
    let (screen, log, host) = (
        display.screen.clone(),
        display.log.clone(),
        display.host.clone(),
    );
    let stride = display.descriptor.stride_bytes;
    let mut coordinator = Coordinator::new(2, stride * 96).unwrap();
    coordinator
        .add_display(display, RendererId::SOFTWARE)
        .unwrap();
    coordinator.present(&rows(0), None, &Resources).unwrap();
    // A host overlay drew over retained pixels; its rectangle is odd so the
    // logical conversion must round outward.
    let overlay = Rect::new(5, 7, 9, 3);
    {
        let mut screen = screen.borrow_mut();
        for y in overlay.y..overlay.y + overlay.height {
            let start = y as usize * stride + overlay.x as usize * 2;
            screen[start..start + overlay.width as usize * 2].fill(0xff);
        }
    }
    host.borrow_mut().push(overlay);
    log.borrow_mut().flushed.clear();
    coordinator.present(&rows(0), None, &Resources).unwrap();
    assert_eq!(*screen.borrow(), full_render(&rows(0), 2));
    let log = log.borrow();
    assert!(log.moves.is_empty());
    assert!(!log.flushed.is_empty());
    assert!(area(&log.flushed) < u64::from(W as u32 * 2) * 8);
}

#[test]
fn retained_move_requires_device_frame_storage_and_partial_refresh() {
    for missing in 0..2 {
        let mut display = MoveDisplay::new(1, 48);
        match missing {
            0 => display.descriptor.device_frame_storage = false,
            _ => display.descriptor.partial_refresh = false,
        }
        let budget = display.descriptor.stride_bytes * 48;
        let mut coordinator = Coordinator::new(1, budget).unwrap();
        assert_eq!(
            coordinator.add_display(display, RendererId::SOFTWARE),
            Err(PresentError::InvalidDisplayDescriptor)
        );
    }
}
