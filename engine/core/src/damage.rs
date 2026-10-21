//! Compatibility exports for damage tracking in pocket-present.

pub use pocket_present::damage::*;

#[cfg(test)]
use crate::{spec, Ui};

#[cfg(test)]
mod tests {
    use super::*;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn target(width: u32, height: u32, scale: u32) -> DamageTarget {
        DamageTarget::new(width, height, scale, 1)
    }

    fn frame(left: u32, right: u32) -> Vec<u32> {
        vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(32, 16),
            0xff20_1008,
            spec::draw_op::RECT,
            xy_word(2, 4),
            wh_word(4, 4),
            left,
            spec::draw_op::RECT,
            xy_word(26, 4),
            wh_word(4, 4),
            right,
        ]
    }

    #[test]
    fn first_unchanged_and_disjoint_frames_are_classified() {
        let mut ui = Ui::new();
        ui.set_viewport(32.0, 16.0);
        let previous = frame(0xff00_00ff, 0xff00_ff00);
        let current = frame(0xffff_0000, 0xffff_ffff);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();

        let first = tracker.prepare(&ui, &previous, target(32, 16, 1)).unwrap();
        assert!(first.is_full_redraw());
        assert_eq!(first.area(), 32 * 16);
        tracker.commit(&ui, &previous, target(32, 16, 1));

        let unchanged = tracker.prepare(&ui, &previous, target(32, 16, 1)).unwrap();
        assert!(!unchanged.is_full_redraw());
        assert!(unchanged.is_empty());

        let changed = tracker.prepare(&ui, &current, target(32, 16, 1)).unwrap();
        assert!(!changed.is_full_redraw());
        assert_eq!(changed.region_count(), 2);
        assert_eq!(changed.area(), 32);
    }

    #[test]
    fn structure_target_and_invalidation_force_full_redraws() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(1, 1),
            wh_word(3, 3),
            0xff00_00ff,
        ];
        let current = Vec::new();
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(16, 8, 1));

        let structural = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        assert!(structural.is_full_redraw());

        tracker.commit(&ui, &current, target(16, 8, 1));
        tracker.invalidate();
        assert!(tracker
            .prepare(&ui, &current, target(16, 8, 1))
            .unwrap()
            .is_full_redraw());

        tracker.commit(&ui, &current, target(16, 8, 1));
        assert!(tracker
            .prepare(&ui, &current, target(32, 16, 2))
            .unwrap()
            .is_full_redraw());

        tracker.commit(&ui, &current, target(32, 16, 2));
        assert!(tracker
            .prepare(&ui, &current, DamageTarget::new(32, 16, 2, 2),)
            .unwrap()
            .is_full_redraw());
    }

    #[test]
    fn policy_promotes_large_damage_and_rejects_invalid_configuration() {
        let mut ui = Ui::new();
        ui.set_viewport(10.0, 10.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 10),
            0xff00_00ff,
        ];
        let current = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 10),
            0xff00_ff00,
        ];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(10, 10, 1));
        let plan = tracker
            .prepare(&ui, &current, target(10, 10, 1))
            .unwrap()
            .with_policy(DamagePolicy::new(75))
            .unwrap();
        assert!(plan.is_full_redraw());

        assert_eq!(
            tracker
                .prepare(&ui, &current, target(10, 10, 1))
                .unwrap()
                .with_policy(DamagePolicy::new(0)),
            Err(DamageError::InvalidPolicy)
        );
        let empty_tracker = DamageTracker::<0>::new();
        assert_eq!(
            empty_tracker.prepare(&ui, &current, target(10, 10, 1)),
            Err(DamageError::InvalidCapacity)
        );
    }

    #[test]
    fn malformed_drawlists_are_rejected_and_prepare_does_not_commit() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(1, 1),
            wh_word(3, 3),
            0xff00_00ff,
        ];
        let current = vec![
            spec::draw_op::RECT,
            xy_word(4, 1),
            wh_word(3, 3),
            0xff00_ff00,
        ];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(16, 8, 1));

        let first_plan = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        let second_plan = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        assert_eq!(first_plan, second_plan);

        let fresh = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        assert_eq!(
            fresh.prepare(&ui, &[spec::draw_op::RECT, xy_word(0, 0)], target(16, 8, 1),),
            Err(DamageError::MalformedDrawList)
        );
        assert_eq!(
            fresh.prepare(
                &ui,
                &[spec::draw_op::SCISSOR, xy_word(0, 0), wh_word(4, 4),],
                target(16, 8, 1),
            ),
            Err(DamageError::MalformedDrawList)
        );
    }

    #[test]
    fn capacity_merges_regions_and_fractional_viewports_match_raster_semantics() {
        let mut ui = Ui::new();
        ui.set_viewport(30.0, 10.0);
        let frame = |colors: [u32; 3]| {
            let mut words = Vec::new();
            for (index, color) in colors.into_iter().enumerate() {
                words.extend_from_slice(&[
                    spec::draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame([0xff00_00ff, 0xff00_ff00, 0xffff_0000]);
        let current = frame([0xffff_ffff, 0xff80_8080, 0xff00_0000]);
        let mut tracker = DamageTracker::<2>::new();
        tracker.commit(&ui, &previous, target(30, 10, 1));
        let plan = tracker.prepare(&ui, &current, target(30, 10, 1)).unwrap();
        assert_eq!(plan.region_count(), 2);
        assert!(plan.area() >= 12);

        ui.set_viewport(7.5, 5.5);
        let fractional = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new()
            .prepare(&ui, &[], target(7, 5, 1))
            .unwrap();
        assert!(fractional.is_full_redraw());
    }

    #[test]
    fn default_capacity_merges_a_ninth_disjoint_region() {
        assert_eq!(DEFAULT_DAMAGE_REGIONS, 8);
        let mut ui = Ui::new();
        ui.set_viewport(96.0, 8.0);
        let frame = |color: u32| {
            let mut words = Vec::new();
            for index in 0..9 {
                words.extend_from_slice(&[
                    spec::draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame(0xff00_00ff);
        let current = frame(0xff00_ff00);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(96, 8, 1));

        let plan = tracker.prepare(&ui, &current, target(96, 8, 1)).unwrap();
        assert!(!plan.is_full_redraw());
        assert_eq!(plan.region_count(), DEFAULT_DAMAGE_REGIONS);
        assert!(plan.area() > 9 * 4);
    }

    #[test]
    fn core_resource_revision_invalidates_unchanged_drawlists() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &[], target(4, 2, 1));
        assert!(tracker
            .prepare(&ui, &[], target(4, 2, 1))
            .unwrap()
            .is_empty());

        assert!(ui.upload_texture(&[0xff, 0xff, 0xff, 0xff], 1, 1, spec::psm::PSM_8888,) >= 0);
        assert!(tracker
            .prepare(&ui, &[], target(4, 2, 1))
            .unwrap()
            .is_full_redraw());
    }
}
