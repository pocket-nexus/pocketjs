fn main() {
    use pocket_guest_rquickjs::RquickjsGuest;
    use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext};
    use pocketjs_core::Ui;

    let ops = OpContext::from_ui(Ui::new());
    let environment = GuestEnvironment {
        host: "example",
        host_abi: pocket_drivers::spec::BINDING_GENERATION,
        tick_hz: 60,
        sim_hz: 60,
        viewport: [320, 240],
        auxiliary_viewport: None,
        auxiliary_root: -1,
        raster_density: 1,
        heap_limit: 1024 * 1024,
        pak: &[],
        worker_javascript: &[],
        assets: None,
    };
    let mut guest = RquickjsGuest::default();
    guest.initialize(ops, &environment).unwrap();
    guest
        .evaluate(b"globalThis.turns = 0; globalThis.frame = () => { turns++; };")
        .unwrap();
    guest
        .frame(&GuestFrame {
            buttons: 0,
            analog: 0,
            touches: &[],
            hits: &[],
            touch_surfaces: &[],
            right_analog: 0,
            axis_deltas: &[],
            motion: None,
            text: &[],
        })
        .unwrap();
    let turns = guest
        .with(|ctx| ctx.globals().get::<_, u32>("turns").unwrap())
        .unwrap();
    assert_eq!(turns, 1);
    guest.shutdown();
}
