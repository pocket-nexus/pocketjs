use pocket_runtime::{OpArg, OpContext, OpResult};
use pocketjs_core::{spec, Ui};

fn words(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[test]
fn node_rect_dispatch_returns_root_space_words_for_a_live_node_only() {
    let mut ui = Ui::new();
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_T, 5.0);
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_L, 7.0);
    let parent = ui.create_node(0);
    ui.set_prop(parent, spec::prop::WIDTH, 200.0);
    ui.set_prop(parent, spec::prop::HEIGHT, 100.0);
    ui.set_prop(parent, spec::prop::PADDING_T, 4.0);
    ui.set_prop(parent, spec::prop::PADDING_L, 3.0);
    ui.insert_before(spec::ROOT_ID, parent, 0);
    let child = ui.create_node(0);
    ui.set_prop(child, spec::prop::WIDTH, 50.0);
    ui.set_prop(child, spec::prop::HEIGHT, 20.0);
    ui.insert_before(parent, child, 0);
    ui.tick();
    let ops = OpContext::from_ui(ui);

    let OpResult::Bytes(bytes) = ops.dispatch(62, &[OpArg::Integer(child as i64)]).unwrap() else {
        panic!("nodeRect must return four f32 words");
    };
    assert_eq!(bytes.len(), 16);
    assert_eq!(words(&bytes), [10.0, 9.0, 50.0, 20.0]);

    assert!(matches!(
        ops.dispatch(62, &[OpArg::Integer(0)]).unwrap(),
        OpResult::None
    ));
    ops.dispatch(2, &[OpArg::Integer(child as i64)]).unwrap();
    assert!(matches!(
        ops.dispatch(62, &[OpArg::Integer(child as i64)]).unwrap(),
        OpResult::None
    ));
}
