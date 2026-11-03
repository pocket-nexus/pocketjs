//! The forwarding crate keeps every public path and names the same items.

use core::any::TypeId;

#[test]
fn paths_name_the_items_in_their_new_crates() {
    assert_eq!(
        TypeId::of::<pocket_present::Coordinator>(),
        TypeId::of::<pocket_runtime::coordinator::Coordinator>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::coordinator::Coordinator>(),
        TypeId::of::<pocket_runtime::coordinator::Coordinator>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DisplayId>(),
        TypeId::of::<pocket_runtime::DisplayId>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::RendererId>(),
        TypeId::of::<pocket_runtime::RendererId>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::PresentError>(),
        TypeId::of::<pocket_runtime::coordinator::PresentError>()
    );
    assert_eq!(pocket_present::RendererId::SOFTWARE.as_raw(), 0);

    use pocket_render::damage as render;
    assert_eq!(
        TypeId::of::<pocket_present::DamageTracker<8>>(),
        TypeId::of::<render::DamageTracker<8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::damage::DamageTracker<8>>(),
        TypeId::of::<render::DamageTracker<8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamagePlan<8>>(),
        TypeId::of::<render::DamagePlan<8>>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamagePolicy>(),
        TypeId::of::<render::DamagePolicy>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamageTarget>(),
        TypeId::of::<render::DamageTarget>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamageError>(),
        TypeId::of::<render::DamageError>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamageMotion>(),
        TypeId::of::<render::DamageMotion>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamageRect>(),
        TypeId::of::<pocket_drivers::DamageRect>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::DamageTransaction>(),
        TypeId::of::<render::DamageTransaction>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::transaction::DamageTransaction>(),
        TypeId::of::<render::DamageTransaction>()
    );
    assert_eq!(
        pocket_present::DEFAULT_DAMAGE_REGIONS,
        render::DEFAULT_DAMAGE_REGIONS
    );

    assert_eq!(
        TypeId::of::<pocket_present::compositor::CompositorRaster>(),
        TypeId::of::<pocket_raster::compositor::CompositorRaster>()
    );
    assert_eq!(
        pocket_present::compositor::draw_op_len(&[pocket_spec::draw_op::SCISSOR_POP], 0),
        Some(1)
    );
    let words = [pocket_spec::draw_op::RECT, 0, 2 | 2 << 16, 0xff00_00ff];
    let policy = pocket_present::DamagePolicy::default();
    let mut rgba = [0u8; 8 * 8 * 4];
    let mut tracker = pocket_present::DamageTracker::<8>::new();
    assert!(pocket_present::incremental::render_scaled_incremental(
        &Resources,
        &words,
        &mut rgba,
        1,
        &mut tracker,
        policy
    )
    .is_ok());
    let mut argb = [0u8; 8 * 8 * 4];
    let mut tracker = render::DamageTracker::<8>::new();
    assert!(pocket_present::incremental::render_scaled_argb_incremental(
        &Resources,
        &words,
        &mut argb,
        1,
        &mut tracker,
        policy
    )
    .is_ok());
    let mut rgb565 = [0u16; 8 * 8];
    let mut tracker = render::DamageTracker::<8>::new();
    assert!(
        pocket_present::incremental::render_scaled_rgb565_incremental(
            &Resources,
            &words,
            &mut rgb565,
            1,
            &mut tracker,
            policy
        )
        .is_ok()
    );

    assert_eq!(
        TypeId::of::<pocket_present::ink::InkRefresh>(),
        TypeId::of::<pocket_drivers::ink::InkRefresh>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::ink::InkTiming>(),
        TypeId::of::<pocket_drivers::ink::InkTiming>()
    );
    assert_eq!(
        TypeId::of::<pocket_present::ink::InkUpdate>(),
        TypeId::of::<pocket_drivers::ink::InkUpdate>()
    );
}

struct Resources;
impl pocket_drivers::RenderResources for Resources {
    fn raster_revision(&self) -> u64 {
        1
    }
    fn viewport(&self) -> (f32, f32) {
        (8.0, 8.0)
    }
    fn texture(&self, _: i32) -> Option<pocket_drivers::TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<pocket_drivers::FontView<'_>> {
        None
    }
}
