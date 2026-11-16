//! Presentation through a display whose scaler filters, modelled on the
//! ESP32-P4 PPA at scale 2 (measured on revision 1.3): a panel pixel is three
//! quarters of its raster pixel and one quarter of the pixel beside it on
//! each axis, and a flushed rectangle repeats its edge pixels outward. A
//! frame presented in parts must show no pixel of an earlier frame.

use std::{cell::RefCell, rc::Rc};

use pocket_drivers::{
    BufferIdentity, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, DrawList,
    FontView, PixelFormat, Rect, RenderResources, Surface, Target, TargetOwnership, TexView,
    VsyncSource, HOST_DAMAGE_RECTS,
};
use pocket_runtime::coordinator::{Coordinator, PresentError, RendererId};
use pocket_spec as spec;

const FORMAT: PixelFormat = PixelFormat::Rgb565;
/// Raster rows a flushed rectangle is aligned to, as the DPI display asks.
const ROW_QUANTUM: u32 = 8;
/// Staging bytes the display hands out before the renderer paints them.
const UNPAINTED: u8 = 0x5a;

fn software(budget: usize) -> Coordinator {
    let mut coordinator = Coordinator::new(1, budget).unwrap();
    coordinator
        .set_software_renderer(
            pocket_raster::RasterRenderer::new(1).unwrap(),
            pocket_raster::RasterRenderer::new,
        )
        .unwrap();
    coordinator
}

struct Resources(u32, u32);
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (self.0 as f32, self.1 as f32)
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

fn xy_word(x: i32, y: i32) -> u32 {
    x as i16 as u16 as u32 | (y as i16 as u16 as u32) << 16
}
fn wh_word(w: i32, h: i32) -> u32 {
    w as u16 as u32 | (h as u16 as u32) << 16
}
fn rect(x: i32, y: i32, w: i32, h: i32, color: u32) -> [u32; 4] {
    [spec::draw_op::RECT, xy_word(x, y), wh_word(w, h), color]
}
fn list(ops: &[[u32; 4]]) -> DrawList {
    let mut list = DrawList::new();
    list.words = ops.concat();
    list
}

const BACKDROP: u32 = 0xff20_1810;
const TRACK: u32 = 0xff40_3020;
const BRIGHT: u32 = 0xfff0_c040;

fn pixel(bytes: &[u8], stride: usize, x: u32, y: u32) -> u16 {
    let at = y as usize * stride + x as usize * 2;
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

/// Three quarters of `p` and one quarter of its neighbours on each axis.
fn mix(p: u16, beside: u16, above: u16, diagonal: u16) -> u16 {
    let fields = |c: u16| [(c >> 11) as u32, ((c >> 5) & 63) as u32, (c & 31) as u32];
    let (a, b, c, d) = (fields(p), fields(beside), fields(above), fields(diagonal));
    let m: [u32; 3] = core::array::from_fn(|i| (9 * a[i] + 3 * b[i] + 3 * c[i] + d[i] + 8) / 16);
    ((m[0] << 11) | (m[1] << 5) | m[2]) as u16
}

/// Scale `rect` of a raster by 2 into `panel`, repeating the rectangle's edge
/// pixels outward. `raster(x, y)` reads a pixel inside `rect`.
fn scale_rect(raster: impl Fn(u32, u32) -> u16, rect: Rect, panel: &mut [u16], panel_width: u32) {
    let (x_last, y_last) = (rect.x + rect.width - 1, rect.y + rect.height - 1);
    for y in rect.y..=y_last {
        for x in rect.x..=x_last {
            for sub in 0..4u32 {
                let nx = if sub & 1 == 1 {
                    (x + 1).min(x_last)
                } else {
                    x.max(rect.x + 1) - 1
                };
                let ny = if sub & 2 == 2 {
                    (y + 1).min(y_last)
                } else {
                    y.max(rect.y + 1) - 1
                };
                let at = (y * 2 + (sub >> 1)) * panel_width + x * 2 + (sub & 1);
                panel[at as usize] =
                    mix(raster(x, y), raster(nx, y), raster(x, ny), raster(nx, ny));
            }
        }
    }
}

#[derive(Default)]
struct Log {
    moves: Vec<(Rect, i32, i32)>,
    flushed: Vec<Rect>,
}

/// A panel twice the raster's size behind a CPU staging strip. A flush
/// scales only the flushed rectangles, each on its own.
struct FilteredDisplay {
    descriptor: DisplayDescriptor,
    staging: Vec<u8>,
    region: Rect,
    panel: Rc<RefCell<Vec<u16>>>,
    log: Rc<RefCell<Log>>,
}

impl FilteredDisplay {
    fn new(width: u32, height: u32, strip_rows: u32, filtered: bool) -> Self {
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
        descriptor.device_scaling = true;
        descriptor.filtered_scaling = filtered;
        descriptor.window_alignment = [1, ROW_QUANTUM];
        Self {
            descriptor,
            staging: vec![0; stride * strip_rows as usize],
            region: Rect::default(),
            panel: Rc::new(RefCell::new(vec![0; (width * 2 * height * 2) as usize])),
            log: Rc::default(),
        }
    }
}

impl DisplayOutput for FilteredDisplay {
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
                    && rect.y + rect.height <= r.y + r.height
                    && rect.y % ROW_QUANTUM == 0
                    && (rect.height % ROW_QUANTUM == 0
                        || rect.y + rect.height == self.descriptor.height),
                "flushed {rect:?} outside the acquired {r:?} or off the row quantum"
            );
        }
        self.log.borrow_mut().flushed.extend_from_slice(regions);
        Ok(regions.to_vec())
    }
    fn wait(&mut self, regions: Vec<Rect>) -> Result<(), DisplayError> {
        let stride = self.descriptor.stride_bytes;
        let (staging, top) = (&self.staging, self.region.y);
        let mut panel = self.panel.borrow_mut();
        for rect in regions {
            scale_rect(
                |x, y| pixel(staging, stride, x, y - top),
                rect,
                &mut panel,
                self.descriptor.width * 2,
            );
        }
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
    fn move_pixels(&mut self, destination: Rect, dx: i32, dy: i32) -> Result<(), DisplayError> {
        self.log.borrow_mut().moves.push((destination, dx, dy));
        let width = (self.descriptor.width * 2) as usize;
        let mut panel = self.panel.borrow_mut();
        let before = panel.clone();
        for y in destination.y * 2..(destination.y + destination.height) * 2 {
            for x in destination.x * 2..(destination.x + destination.width) * 2 {
                let from = (y as i32 - dy * 2) as usize * width + (x as i32 - dx * 2) as usize;
                panel[y as usize * width + x as usize] = before[from];
            }
        }
        Ok(())
    }
    fn host_damage(&mut self, _: &mut [Rect; HOST_DAMAGE_RECTS]) -> usize {
        0
    }
}

fn full_render(list: &DrawList, width: u32, height: u32) -> Vec<u8> {
    let stride = FORMAT.row_bytes(width).unwrap();
    let mut pixels = vec![0; stride * height as usize];
    let mut surface =
        Surface::new(&mut pixels, Rect::new(0, 0, width, height), stride, FORMAT).unwrap();
    pocket_raster::render_surface(&Resources(width, height), &list.words, &mut surface, 1).unwrap();
    pixels
}

/// The panel after every strip of `list` is flushed whole.
fn shown(list: &DrawList, width: u32, height: u32, strip_rows: u32) -> Vec<u16> {
    let frame = full_render(list, width, height);
    let stride = FORMAT.row_bytes(width).unwrap();
    let mut panel = vec![0; (width * 2 * height * 2) as usize];
    for top in (0..height).step_by(strip_rows as usize) {
        let strip = Rect::new(0, top, width, strip_rows.min(height - top));
        scale_rect(
            |x, y| pixel(&frame, stride, x, y),
            strip,
            &mut panel,
            width * 2,
        );
    }
    panel
}

/// Panel pixels that no filtering of `list` explains: each must be its own
/// raster pixel mixed with the pixel beside it or, at the edge of a flushed
/// rectangle, with itself.
fn unexplained(panel: &[u16], list: &DrawList, width: u32, height: u32) -> Vec<(u32, u32)> {
    let frame = full_render(list, width, height);
    let stride = FORMAT.row_bytes(width).unwrap();
    let at = |x: u32, y: u32| pixel(&frame, stride, x, y);
    let mut wrong = Vec::new();
    for py in 0..height * 2 {
        for px in 0..width * 2 {
            let (x, y) = (px / 2, py / 2);
            let beside = if px & 1 == 1 {
                (x + 1).min(width - 1)
            } else {
                x.max(1) - 1
            };
            let above = if py & 1 == 1 {
                (y + 1).min(height - 1)
            } else {
                y.max(1) - 1
            };
            let value = panel[(py * width * 2 + px) as usize];
            let explained = [(beside, above), (x, above), (beside, y), (x, y)]
                .into_iter()
                .any(|(nx, ny)| value == mix(at(x, y), at(nx, y), at(x, ny), at(nx, ny)));
            if !explained {
                wrong.push((px, py));
            }
        }
    }
    wrong
}

struct Screen {
    coordinator: Coordinator,
    panel: Rc<RefCell<Vec<u16>>>,
    log: Rc<RefCell<Log>>,
    size: (u32, u32),
    strip_rows: u32,
}

impl Screen {
    fn new(width: u32, height: u32, strip_rows: u32, filtered: bool, moves: bool) -> Self {
        let mut display = FilteredDisplay::new(width, height, strip_rows, filtered);
        display.descriptor.retained_move = moves;
        let (panel, log) = (display.panel.clone(), display.log.clone());
        let mut coordinator = software(display.descriptor.stride_bytes * strip_rows as usize);
        let id = coordinator
            .add_display(display, RendererId::SOFTWARE)
            .unwrap();
        assert_eq!(coordinator.strip_height(id), Some(strip_rows));
        Self {
            coordinator,
            panel,
            log,
            size: (width, height),
            strip_rows,
        }
    }
    fn present(&mut self, list: &DrawList) {
        self.log.borrow_mut().flushed.clear();
        self.coordinator
            .present(list, None, &Resources(self.size.0, self.size.1))
            .unwrap();
    }
    fn equals_a_full_present(&self, list: &DrawList) -> bool {
        *self.panel.borrow() == shown(list, self.size.0, self.size.1, self.strip_rows)
    }
    fn unexplained(&self, list: &DrawList) -> Vec<(u32, u32)> {
        unexplained(&self.panel.borrow(), list, self.size.0, self.size.1)
    }
}

/// The backdrop with or without one bar. A list that loses an operation is
/// planned in parts only by a display that moves retained pixels: the tests
/// below declare one, as the DPI display does.
fn with_bar(bar: Option<(i32, i32, i32, i32)>) -> DrawList {
    let mut ops = vec![rect(0, 0, 96, 64, BACKDROP)];
    if let Some((x, y, w, h)) = bar {
        ops.push(rect(x, y, w, h, BRIGHT));
    }
    list(&ops)
}

#[test]
fn a_removed_bar_leaves_a_quarter_of_itself_beside_its_bounds_without_the_flag() {
    let mut screen = Screen::new(96, 64, 16, false, true);
    screen.present(&with_bar(Some((28, 20, 4, 24))));
    assert!(screen.equals_a_full_present(&with_bar(Some((28, 20, 4, 24)))));
    screen.present(&with_bar(None));
    assert!(!screen.equals_a_full_present(&with_bar(None)));
    // Panel columns 55 and 64 lie outside the bar's raster columns 28..31.
    let wrong = screen.unexplained(&with_bar(None));
    assert!(
        wrong.contains(&(55, 48)) && wrong.contains(&(64, 48)),
        "{wrong:?}"
    );
    assert!(wrong.iter().all(|&(x, _)| x == 55 || x == 64), "{wrong:?}");
}

#[test]
fn a_removed_bar_leaves_nothing_on_a_filtering_display() {
    let mut screen = Screen::new(96, 64, 16, true, true);
    screen.present(&with_bar(Some((28, 20, 4, 24))));
    assert!(screen.equals_a_full_present(&with_bar(Some((28, 20, 4, 24)))));
    screen.present(&with_bar(None));
    assert!(screen.equals_a_full_present(&with_bar(None)));
    // One raster column on each side of the bar, rows to the quantum.
    let flushed = screen.log.borrow().flushed.clone();
    assert!(!flushed.is_empty());
    for rect in flushed {
        assert_eq!((rect.x, rect.width), (27, 6), "{rect:?}");
    }
}

#[test]
fn a_fill_that_changes_width_equals_a_full_present_every_frame() {
    let gauge = |width: i32| {
        list(&[
            rect(0, 0, 96, 64, BACKDROP),
            rect(28, 24, 60, 10, TRACK),
            rect(28, 24, width, 10, BRIGHT),
        ])
    };
    for filtered in [true, false] {
        let mut screen = Screen::new(96, 64, 16, filtered, false);
        let mut equal = true;
        for width in [50, 40, 33, 21, 12, 30, 8] {
            screen.present(&gauge(width));
            equal &= screen.equals_a_full_present(&gauge(width));
        }
        assert_eq!(equal, filtered);
    }
}

#[test]
fn rows_stop_at_a_strip_edge_and_columns_at_the_screen_edge() {
    // One bar starts on the first row of the strip at 16, two touch the
    // left and right screen edges.
    let bars = [(40, 16, 6, 10), (0, 40, 3, 8), (93, 4, 3, 8)];
    let scene = |shown: bool| {
        let mut ops = vec![rect(0, 0, 96, 64, BACKDROP)];
        if shown {
            ops.extend(bars.map(|(x, y, w, h)| rect(x, y, w, h, BRIGHT)));
        }
        list(&ops)
    };
    let mut screen = Screen::new(96, 64, 16, true, true);
    screen.present(&scene(true));
    screen.present(&scene(false));
    assert!(screen.equals_a_full_present(&scene(false)));
    let flushed = screen.log.borrow().flushed.clone();
    // Nothing of the strip above the first bar is flushed for it.
    assert!(
        flushed
            .iter()
            .all(|r| r.x + r.width <= 39 || r.x >= 47 || r.y >= 16),
        "{flushed:?}"
    );
    assert!(flushed.iter().any(|r| r.x == 0) && flushed.iter().any(|r| r.x + r.width == 96));
}

/// Opaque gradient rows 48 wide with a translucent bar each, scrolled up by
/// `scroll`, beside a column of bands that stays: no operation that moves
/// reaches the column, so nothing but the moved pixels' edge is damaged
/// there.
fn rows(scroll: i32) -> DrawList {
    const W: i32 = 64;
    const H: i32 = 48;
    const ROWS: i32 = 48;
    let mut words = rect(0, 0, W, H, 0xff00_0000).to_vec();
    for band in 0..8 {
        let shade = (band as u32 + 1) * 0x1c;
        words.extend(rect(
            ROWS,
            band * 6,
            W - ROWS,
            6,
            0xff00_0020 | shade << 16 | shade << 8,
        ));
    }
    for row in 0..10 {
        let y = row * 8 - scroll;
        let colors = [0xff00_40f0 + row as u32, 0xff00_20c0 + row as u32, 1];
        if y >= 0 && y + 8 <= H {
            words.extend([spec::draw_op::GRAD_RECT, xy_word(0, y), wh_word(ROWS, 8)]);
            words.extend(colors);
        } else if y + 8 > 0 && y < H {
            words.extend([
                spec::draw_op::SCISSOR,
                xy_word(0, 0),
                wh_word(W, H),
                spec::draw_op::GRAD_RECT,
                xy_word(0, y),
                wh_word(ROWS, 8),
                colors[0],
                colors[1],
                spec::GradDir::ToBottom as u32,
                spec::draw_op::SCISSOR_POP,
            ]);
        }
        let (x0, y0, x1, y1) = (4, (y + 2).max(0), 24 + row * 2, (y + 6).min(H));
        if y0 < y1 {
            words.extend(rect(x0, y0, x1 - x0, y1 - y0, 0xc0ff_ffff));
        }
    }
    let mut list = DrawList::new();
    list.words = words;
    list
}

#[test]
fn moved_pixels_show_the_current_frame_at_their_edges() {
    for strip_rows in [8, 16, 48] {
        let mut screen = Screen::new(64, 48, strip_rows, true, true);
        screen.present(&rows(0));
        assert!(screen.equals_a_full_present(&rows(0)));
        for scroll in [3, 5, 12, 13, 4] {
            screen.present(&rows(scroll));
            let wrong = screen.unexplained(&rows(scroll));
            assert!(
                wrong.is_empty(),
                "strips of {strip_rows}, scroll {scroll}: {wrong:?}"
            );
        }
        // The rows moved and the column beside them did not.
        let moves = screen.log.borrow().moves.clone();
        assert!(
            moves.iter().any(|&(destination, dx, dy)| dx == 0
                && dy != 0
                && destination.x + destination.width == 48),
            "strips of {strip_rows}: {moves:?}"
        );
    }
}

#[test]
fn filtered_scaling_requires_device_scaling() {
    let mut display = FilteredDisplay::new(96, 64, 16, true);
    display.descriptor.device_scaling = false;
    let mut coordinator = software(display.descriptor.stride_bytes * 16);
    assert_eq!(
        coordinator.add_display(display, RendererId::SOFTWARE),
        Err(PresentError::InvalidDisplayDescriptor)
    );
}
