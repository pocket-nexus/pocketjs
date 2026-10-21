use pocket_drivers::{FontView, RenderResources, TexView};
use pocket_present::{DamagePolicy, DamageTracker, DamageTransaction};
use pocket_spec::draw_op;

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (4.0, 2.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

fn rectangle(x: u32, color: u32) -> [u32; 4] {
    [draw_op::RECT, x, 1 | (1 << 16), color]
}

#[test]
fn failed_output_discards_history_without_committing_partial_pixels() {
    let resources = Resources;
    let transaction = DamageTransaction::new(1, 17, DamagePolicy::default());
    let mut tracker = DamageTracker::<8>::new();
    let first = rectangle(0, 0xff00_00ff);
    let second = rectangle(2, 0xff00_ff00);
    let mut pixels = [0u16; 8];

    transaction
        .run(&mut tracker, &resources, &first, |damage| {
            pocket_raster::render_scaled_rgb565_regions(
                &resources,
                &first,
                &mut pixels,
                1,
                damage.regions(),
            );
            Some(())
        })
        .unwrap();
    assert!(transaction
        .prepare(&tracker, &resources, &first)
        .unwrap()
        .is_empty());

    let result = transaction.run(&mut tracker, &resources, &second, |damage| {
        assert!(!damage.is_full_redraw());
        // Simulate an output update that wrote one pixel before failing.
        pixels[0] = 0xffff;
        None::<()>
    });
    assert_eq!(result, None);
    let retry = transaction.prepare(&tracker, &resources, &second).unwrap();
    assert!(retry.is_full_redraw());
    transaction
        .run(&mut tracker, &resources, &second, |damage| {
            pocket_raster::render_scaled_rgb565_regions(
                &resources,
                &second,
                &mut pixels,
                1,
                damage.regions(),
            );
            Some(())
        })
        .unwrap();
    let mut expected = [0u16; 8];
    pocket_raster::render_scaled_rgb565(&resources, &second, &mut expected, 1);
    assert_eq!(pixels, expected);
}

#[test]
fn prepare_does_not_commit_and_targets_keep_independent_histories() {
    let resources = Resources;
    let transaction = DamageTransaction::new(1, 17, DamagePolicy::default());
    let mut targets = [DamageTracker::<8>::new(), DamageTracker::<8>::new()];
    let first = rectangle(0, 0xff00_00ff);
    let second = rectangle(2, 0xff00_ff00);
    assert!(transaction
        .prepare(&targets[0], &resources, &first)
        .unwrap()
        .is_full_redraw());
    assert!(transaction
        .prepare(&targets[0], &resources, &first)
        .unwrap()
        .is_full_redraw());
    assert!(transaction.commit(&mut targets[0], &resources, &first));
    assert!(transaction.commit(&mut targets[1], &resources, &second));
    assert!(transaction
        .prepare(&targets[0], &resources, &first)
        .unwrap()
        .is_empty());
    assert!(transaction
        .prepare(&targets[1], &resources, &second)
        .unwrap()
        .is_empty());
    transaction.abort(&mut targets[0]);
    assert!(transaction
        .prepare(&targets[0], &resources, &first)
        .unwrap()
        .is_full_redraw());
    assert!(transaction
        .prepare(&targets[1], &resources, &second)
        .unwrap()
        .is_empty());
}

#[test]
fn generic_compositor_preserves_surface_and_following_operation_order() {
    let surface = pocket_present::compositor::CompositorRaster {
        pixels: [255, 0, 0, 255].repeat(4),
        width: 2,
        height: 2,
        density: 1,
    };
    let mut words = vec![
        draw_op::SURFACE_QUAD,
        0,
        1.0f32.to_bits(),
        0.0f32.to_bits(),
        2.0f32.to_bits(),
        2.0f32.to_bits(),
        1,
        2 | (2 << 16),
        0xffff_ffff,
    ];
    words.extend_from_slice(&rectangle(2, 0xffff_0000));
    let mut pixels = [0u8; 32];
    pocket_present::compositor::render(&Resources, &words, &mut pixels, 1, &[Some(surface)]);
    let black = [0, 0, 0, 255];
    let red = [255, 0, 0, 255];
    let blue = [0, 0, 255, 255];
    assert_eq!(
        pixels.as_slice(),
        [black, red, blue, black, black, red, red, black].concat()
    );
}

#[test]
fn incremental_entrypoints_work_without_a_core_ui() {
    let mut tracker = DamageTracker::<8>::new();
    let mut pixels = [0u8; 32];
    for x in [0, 2, 1] {
        let words = rectangle(x, 0xff00_ff00);
        pocket_present::incremental::render_scaled_incremental(
            &Resources,
            &words,
            &mut pixels,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        let mut full = [0u8; 32];
        pocket_raster::render_scaled(&Resources, &words, &mut full, 1);
        assert_eq!(pixels, full);
    }
}
