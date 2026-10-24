use pocket_drivers::{FontView, RenderResources, TexView};
use pocket_present::*;
use pocket_spec as spec;
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

// ---- motion ----------------------------------------------------------

const W: i32 = 64;
const H: i32 = 48;

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

fn rect(x: i32, y: i32, w: i32, h: i32, color: u32) -> Vec<u32> {
    clipped(spec::draw_op::RECT, x, y, w, h, &[color])
}

/// A gradient as a clip-invariant DrawList emits it: partially clipped
/// ones stay unclipped inside a screen scissor.
fn grad(x: i32, y: i32, w: i32, h: i32, from: u32, to: u32) -> Vec<u32> {
    let visible = clipped(spec::draw_op::GRAD_RECT, x, y, w, h, &[from, to, 1]);
    if visible.is_empty() || (x >= 0 && y >= 0 && x + w <= W && y + h <= H) {
        return visible;
    }
    vec![
        spec::draw_op::SCISSOR,
        xy_word(0, 0),
        wh_word(W as u16, H as u16),
        spec::draw_op::GRAD_RECT,
        xy_word(x as i16, y as i16),
        wh_word(w as u16, h as u16),
        from,
        to,
        spec::GradDir::ToBottom as u32,
        spec::draw_op::SCISSOR_POP,
    ]
}

/// A panel: opaque background, translucent keys, and a 1px edge.
fn panel(y: i32) -> Vec<u32> {
    let mut words = grad(0, y, W, 30, 0xff40_2010, 0xff10_0804);
    for (i, kx) in [2, 18, 34, 50].into_iter().enumerate() {
        words.extend(rect(kx, y + 4 + (i as i32 % 2) * 12, 12, 10, 0x80ff_ffff));
    }
    words.extend(rect(0, y, W, 1, 0x40ff_ffff));
    words
}

fn rows(scroll: i32) -> Vec<u32> {
    let mut words = rect(0, 0, W, H, 0xff00_0000);
    for row in 0..10 {
        let y = row * 8 - scroll;
        words.extend(grad(
            0,
            y,
            W,
            8,
            0xff00_40f0 + row as u32,
            0xff00_20c0 + row as u32,
        ));
        words.extend(rect(4, y + 2, 20 + row * 3, 4, 0xc0ff_ffff));
    }
    words
}

/// Render `previous`, plan `current` with motion, apply it, and require
/// the result to equal a full render of `current`.
fn motion_plan(ui: &Resources, previous: &[u32], current: &[u32], scale: u32) -> DamagePlan {
    let (width, height) = (W as usize * scale as usize, H as usize * scale as usize);
    let target = DamageTarget::new(width as u32, height as u32, scale, 1);
    let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
    let mut pixels = vec![0u16; width * height];
    pocket_raster::render_scaled_rgb565(ui, previous, &mut pixels, scale);
    tracker.commit(ui, previous, target);
    let plan = tracker.prepare_with_motion(ui, current, target).unwrap();
    if let Some(motion) = plan.motion() {
        let before = pixels.clone();
        let s = scale as i32;
        let destination = motion.destination;
        for y in destination.y0 * s..destination.y1 * s {
            for x in destination.x0 * s..destination.x1 * s {
                let from = (y - motion.dy * s) as usize * width + (x - motion.dx * s) as usize;
                pixels[y as usize * width + x as usize] = before[from];
            }
        }
    }
    pocket_raster::render_scaled_rgb565_regions(ui, current, &mut pixels, scale, plan.regions());
    let mut expected = vec![0u16; width * height];
    pocket_raster::render_scaled_rgb565(ui, current, &mut expected, scale);
    assert_eq!(
        pixels, expected,
        "motion plus damage must equal a full render"
    );
    plan
}

fn screen_ui() -> Resources {
    Resources
}

#[test]
fn a_panel_sliding_past_the_screen_edge_moves_its_visible_pixels() {
    let ui = screen_ui();
    let mut previous = rows(0);
    previous.extend(panel(30));
    let mut current = rows(0);
    current.extend(panel(24));
    for scale in [1, 2] {
        let plan = motion_plan(&ui, &previous, &current, scale);
        let motion = plan.motion().expect("the panel moved");
        assert_eq!((motion.dx, motion.dy), (0, -6));
        // Rows the panel brings in at the bottom edge stay damage; keys
        // the edge clips keep their pixels where both frames show them.
        assert_eq!(motion.destination, DamageRect::new(0, 24, W, H - 6));
        assert!(plan.area() < (W * H) as u64 / 2);
    }
}

#[test]
fn scrolled_rows_merge_into_one_moved_rectangle() {
    let ui = screen_ui();
    let plan = motion_plan(&ui, &rows(0), &rows(3), 2);
    let motion = plan.motion().expect("the rows moved");
    assert_eq!((motion.dx, motion.dy), (0, -3));
    assert_eq!((motion.destination.x0, motion.destination.x1), (0, W));
    assert!(motion.destination.area() >= (W * 32) as u64);
}

#[test]
fn a_fixed_overlay_cuts_the_moved_rectangle() {
    let ui = screen_ui();
    let overlay = rect(4, 38, 12, 6, 0x80ff_0000);
    let mut previous = rows(0);
    previous.extend(panel(20));
    previous.extend(&overlay);
    let mut current = rows(0);
    current.extend(panel(16));
    current.extend(&overlay);
    let plan = motion_plan(&ui, &previous, &current, 1);
    let motion = plan.motion().expect("the panel moved");
    assert!(motion
        .destination
        .intersect(DamageRect::new(4, 38, 16, 44))
        .is_empty());
}

#[test]
fn translucent_content_does_not_move_pixels() {
    let ui = screen_ui();
    let sheet = |y: i32| {
        let mut words = rows(0);
        words.extend(rect(0, y, W, 20, 0x80ff_ffff));
        words
    };
    let plan = motion_plan(&ui, &sheet(10), &sheet(6), 1);
    assert!(plan.motion().is_none());
}

#[test]
fn two_movers_keep_exact_pixels() {
    let ui = screen_ui();
    let scene = |a: i32, b: i32| {
        let mut words = rect(0, 0, W, H, 0xff10_1010);
        words.extend(grad(0, a, 32, 36, 0xff80_0000, 0xff40_0000));
        words.extend(rect(2, a + 2, 10, 4, 0x90ff_ffff));
        words.extend(grad(32, b, 32, 36, 0xff00_8000, 0xff00_4000));
        words.extend(rect(36, b + 2, 10, 4, 0x90ff_ffff));
        words
    };
    let plan = motion_plan(&ui, &scene(4, 10), &scene(9, 6), 2);
    assert!(plan.motion().is_some());
    motion_plan(&ui, &scene(9, 14), &scene(9, 14), 2);
}

#[test]
fn a_growing_scissor_repaints_what_it_reveals() {
    let ui = screen_ui();
    let scene = |h: u16| {
        let mut words = rect(0, 0, W, H, 0xff00_0000);
        words.extend([spec::draw_op::SCISSOR, xy_word(0, 0), wh_word(W as u16, h)]);
        words.extend(rect(0, 0, W, H, 0xff80_4020));
        words.extend(rect(10, 10, 20, 30, 0x80ff_ffff));
        words.push(spec::draw_op::SCISSOR_POP);
        words
    };
    let plan = motion_plan(&ui, &scene(20), &scene(32), 1);
    assert_eq!(plan.bounds(), DamageRect::new(0, 0, W, 32));
}

#[test]
fn a_static_translucent_bar_keeps_the_rows_under_it_moving() {
    let ui = screen_ui();
    let bar = rect(0, 10, W, 20, 0x6000_0000);
    let mut previous = rows(0);
    previous.extend(&bar);
    let mut current = rows(3);
    current.extend(&bar);
    let plan = motion_plan(&ui, &previous, &current, 2);
    let motion = plan.motion().expect("the rows moved");
    assert_eq!((motion.dx, motion.dy), (0, -3));
    // A flat color paints the same pixels wherever both frames show the
    // bar, so only its edges stay damage.
    assert!(motion.destination.y0 <= 10 && motion.destination.y1 >= 27);
}

#[test]
fn a_motion_plan_is_not_promoted_to_a_full_redraw() {
    let ui = screen_ui();
    let target = DamageTarget::new(W as u32, H as u32, 1, 1);
    let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
    tracker.commit(&ui, &rows(0), target);
    let plan = tracker.prepare_with_motion(&ui, &rows(5), target).unwrap();
    assert!(plan.motion().is_some());
    let promoted = plan.with_policy(DamagePolicy::new(1)).unwrap();
    assert!(!promoted.is_full_redraw());
    assert_eq!(promoted.motion(), plan.motion());
}

#[test]
fn committing_the_prepared_list_plans_the_next_frame_like_a_fresh_tracker() {
    let ui = screen_ui();
    let target = DamageTarget::new(W as u32, H as u32, 1, 1);
    let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
    assert!(
        !tracker.commit_prepared(&ui, target),
        "nothing was prepared"
    );
    tracker.commit(&ui, &rows(0), target);
    tracker.prepare_with_motion(&ui, &rows(2), target).unwrap();
    assert!(tracker.commit_prepared(&ui, target));
    let next = tracker.prepare_with_motion(&ui, &rows(5), target).unwrap();
    let mut fresh = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
    fresh.commit(&ui, &rows(2), target);
    let expected = fresh.prepare_with_motion(&ui, &rows(5), target).unwrap();
    assert_eq!(next.motion(), expected.motion());
    assert_eq!(next.regions(), expected.regions());
}

#[test]
fn subtracting_a_hole_leaves_disjoint_pieces() {
    let rect = DamageRect::new(0, 0, 10, 10);
    let pieces = rect.subtract(DamageRect::new(2, 3, 6, 7));
    let area: u64 = pieces
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| p.area())
        .sum();
    assert_eq!(area, 100 - 16);
    assert_eq!(rect.subtract(DamageRect::new(20, 20, 30, 30))[0], rect);
}

#[test]
fn plain_prepare_never_moves_pixels() {
    let ui = screen_ui();
    let target = DamageTarget::new(W as u32, H as u32, 1, 1);
    let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
    tracker.commit(&ui, &rows(0), target);
    assert!(tracker
        .prepare(&ui, &rows(3), target)
        .unwrap()
        .motion()
        .is_none());
}

#[test]
fn a_noop_or_invalid_prepare_discards_an_older_pending_list() {
    let ui = screen_ui();
    let target = DamageTarget::new(W as u32, H as u32, 1, 1);
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&ui, &rows(0), target);
    tracker.prepare_with_motion(&ui, &rows(2), target).unwrap();
    assert!(tracker
        .prepare_with_motion(&ui, &rows(0), target)
        .unwrap()
        .is_empty());
    assert!(!tracker.commit_prepared(&ui, target));
    tracker.prepare_with_motion(&ui, &rows(2), target).unwrap();
    assert!(tracker
        .prepare_with_motion(&ui, &[spec::draw_op::RECT], target)
        .is_err());
    assert!(!tracker.commit_prepared(&ui, target));
    let expected = motion_plan(&ui, &rows(0), &rows(3), 1);
    let actual = tracker.prepare_with_motion(&ui, &rows(3), target).unwrap();
    assert_eq!(actual.motion(), expected.motion());
    assert_eq!(actual.regions(), expected.regions());
}

#[test]
fn committing_prepared_pixels_rejects_a_changed_target() {
    let ui = screen_ui();
    let target = DamageTarget::new(W as u32, H as u32, 1, 1);
    let mut tracker = DamageTracker::<8>::new();
    tracker.prepare_with_motion(&ui, &rows(0), target).unwrap();
    assert!(!tracker.commit_prepared(
        &ui,
        DamageTarget {
            signature: 2,
            ..target
        }
    ));
    assert!(tracker
        .prepare_with_motion(&ui, &rows(2), target)
        .unwrap()
        .is_full_redraw());
}

#[test]
fn pixel_moves_handle_overlap_stride_and_reject_out_of_surface_sources() {
    use pocket_drivers::{PixelFormat, Rect, Surface};
    use pocket_present::motion::move_pixels;
    for scale in [1, 2] {
        let (width, height) = (12 * scale, 10 * scale);
        let stride = width as usize * 2 + 7;
        for (dx, dy) in [(-2, 0), (2, 0), (0, -2), (0, 2), (-2, 2), (2, -2)] {
            let mut data: Vec<u8> = (0..stride * height as usize)
                .map(|n| (n * 71) as u8)
                .collect();
            let before = data.clone();
            let motion = DamageMotion {
                destination: DamageRect::new(4, 4, 8, 7),
                dx,
                dy,
            };
            let mut expected = before.clone();
            for y in 4 * scale..7 * scale {
                for x in 4 * scale..8 * scale {
                    let from = (y as i32 - dy * scale as i32) as usize * stride
                        + (x as i32 - dx * scale as i32) as usize * 2;
                    let to = y as usize * stride + x as usize * 2;
                    expected[to..to + 2].copy_from_slice(&before[from..from + 2]);
                }
            }
            let mut surface = Surface::new(
                &mut data,
                Rect::new(0, 0, width, height),
                stride,
                PixelFormat::Rgb565,
            )
            .unwrap();
            move_pixels(&mut surface, scale, motion).unwrap();
            assert_eq!(data, expected);
        }
    }
    let mut data = vec![0x5a; 64];
    let mut surface =
        Surface::new(&mut data, Rect::new(4, 4, 4, 4), 16, PixelFormat::Rgb565).unwrap();
    for dx in [1, i32::MAX] {
        assert!(move_pixels(
            &mut surface,
            1,
            DamageMotion {
                destination: DamageRect::new(4, 4, 8, 8),
                dx,
                dy: 0
            }
        )
        .is_err());
        assert!(surface.pixels().iter().all(|&value| value == 0x5a));
    }
}

#[test]
fn coordinator_moves_retained_software_pixels_and_flushes_the_destination() {
    use pocket_drivers::*;
    use std::{cell::RefCell, rc::Rc};
    #[derive(Default)]
    struct Facts {
        selected: usize,
        failed: bool,
        pixels: Vec<u8>,
        flushes: Vec<Vec<Rect>>,
    }
    struct Display {
        buffers: [Vec<u8>; 2],
        facts: Rc<RefCell<Facts>>,
    }
    impl DisplayOutput for Display {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            let mut value = DisplayDescriptor::new(
                DisplayRole::Primary,
                W as u32,
                H as u32,
                PixelFormat::Rgb565,
                W as usize * 2,
                TargetOwnership::CpuVisible,
            );
            value.partial_refresh = true;
            value.double_buffered = true;
            value
        }
        fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
            Ok(Some(BufferIdentity {
                buffer: self.facts.borrow().selected as u64,
                generation: 0,
            }))
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            let selected = self.facts.borrow().selected;
            Ok(Target::CpuVisible(Surface::new(
                &mut self.buffers[selected],
                region,
                W as usize * 2,
                PixelFormat::Rgb565,
            )?))
        }
        fn flush(&mut self, regions: &[Rect]) -> Result<(), DisplayError> {
            let mut facts = self.facts.borrow_mut();
            facts.flushes.push(regions.to_vec());
            facts.pixels = self.buffers[facts.selected].clone();
            if std::mem::take(&mut facts.failed) {
                Err(DisplayError::Failed)
            } else {
                Ok(())
            }
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            Ok(())
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut coordinator = Coordinator::new(1, (W * H * 4) as usize).unwrap();
    coordinator
        .add_display(
            Display {
                buffers: [vec![0; (W * H * 2) as usize], vec![0; (W * H * 2) as usize]],
                facts: facts.clone(),
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    for (scroll, selected) in [(0, 0), (1, 1), (3, 0), (4, 1)] {
        facts.borrow_mut().selected = selected;
        let list = DrawList {
            words: rows(scroll),
            ..DrawList::new()
        };
        coordinator.present(&list, None, &Resources).unwrap();
        let mut expected = vec![0u16; (W * H) as usize];
        pocket_raster::render_scaled_rgb565(&Resources, &list.words, &mut expected, 1);
        let expected: Vec<u8> = expected.iter().flat_map(|p| p.to_le_bytes()).collect();
        assert_eq!(facts.borrow().pixels, expected);
        if scroll >= 3 {
            let f = facts.borrow();
            let flushed = f.flushes.last().unwrap();
            assert!(
                flushed.len() > 1,
                "repaint plus moved destination must be flushed"
            );
            assert!(flushed
                .iter()
                .all(|rect| rect.width * rect.height < (W * H) as u32));
        }
    }
    facts.borrow_mut().failed = true;
    let list = DrawList {
        words: rows(6),
        ..DrawList::new()
    };
    assert!(coordinator.present(&list, None, &Resources).is_err());
    coordinator.present(&list, None, &Resources).unwrap();
    assert_eq!(
        facts.borrow().flushes.last().unwrap(),
        &[Rect::new(0, 0, W as u32, H as u32)]
    );
}

#[test]
fn unchanged_words_commit_new_resource_bounds_before_the_next_motion() {
    use std::cell::Cell;
    struct FontResources(Cell<bool>);
    impl RenderResources for FontResources {
        fn viewport(&self) -> (f32, f32) {
            (64.0, 48.0)
        }
        fn raster_revision(&self) -> u64 {
            self.0.get() as u64
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            None
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            Some(FontView {
                bitmap: &[128; 1024],
                cell_w: 24,
                cell_h: if self.0.get() { 20 } else { 2 },
                raster_density: 1,
                glyph_count: 1,
            })
        }
    }
    let resources = FontResources(Cell::new(false));
    let scene = |y: i16| {
        let mut list = rows(0);
        list.extend([
            spec::draw_op::GLYPH_RUN,
            1 << 16,
            0x80ff_ffff,
            xy_word(10, y),
            0,
        ]);
        list
    };
    let target = DamageTarget::new(64, 48, 1, 1);
    let mut tracker = DamageTracker::<8>::new();
    tracker
        .prepare_with_motion(&resources, &scene(8), target)
        .unwrap();
    tracker.commit(&resources, &scene(8), target);
    resources.0.set(true);
    tracker
        .prepare_with_motion(&resources, &scene(8), target)
        .unwrap();
    tracker.commit(&resources, &scene(8), target);
    let actual = tracker
        .prepare_with_motion(&resources, &scene(12), target)
        .unwrap();
    let mut fresh = DamageTracker::<8>::new();
    fresh.commit(&resources, &scene(8), target);
    let expected = fresh
        .prepare_with_motion(&resources, &scene(12), target)
        .unwrap();
    assert_eq!(actual.regions(), expected.regions());
    assert_eq!(actual.motion(), expected.motion());
}
