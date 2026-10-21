use pocket_drivers::*;
use pocket_runtime::input::InputEncoder;
use pocketjs_core::{spec, Ui};
fn contact(surface: u32, id: u32, x: f32, y: f32) -> Contact {
    Contact {
        surface,
        id,
        x,
        y,
        cancelled: false,
    }
}
#[test]
fn keeps_legacy_ids_packing_and_down_edge_hits_until_release() {
    let mut ui = Ui::new();
    ui.set_viewport(900., 700.);
    let node = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(node, spec::prop::WIDTH, 100.);
    ui.set_prop(node, spec::prop::HEIGHT, 100.);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.draw();
    let mut encoder = InputEncoder::new();
    let mut input = InputFrameBuilder::new();
    input.contacts.push(contact(0, 73, 20., 30.));
    let first = encoder.encode(&mut ui, &input.frame()).unwrap();
    assert_eq!(first.touches, [73 << 18 | 30 << 9 | 20]);
    assert_eq!(first.hits, [node]);
    ui.destroy_node(node);
    input.contacts[0].x = 700.;
    input.contacts[0].y = 600.;
    let moved = encoder.encode(&mut ui, &input.frame()).unwrap();
    assert_eq!(moved.touches, [0x8000_0000 | 73 << 20 | 600 << 10 | 700]);
    assert_eq!(moved.hits, [node]);
    input.contacts.clear();
    encoder.encode(&mut ui, &input.frame()).unwrap();
    input.contacts.push(contact(0, 73, 20., 30.));
    assert_ne!(
        encoder.encode(&mut ui, &input.frame()).unwrap().hits,
        [node]
    );
}
#[test]
fn cancellation_is_surface_scoped_and_axes_preserve_the_eight_argument_wire() {
    let mut ui = Ui::new();
    ui.create_auxiliary_surface(400., 240.);
    let mut encoder = InputEncoder::new();
    let mut input = InputFrameBuilder::new();
    input
        .contacts
        .extend([contact(0, 7, 1., 2.), contact(1, 7, 3., 4.)]);
    encoder.encode(&mut ui, &input.frame()).unwrap();
    input.cancelled.push(CancelledContact { surface: 1, id: 7 });
    input.axes.extend([
        AxisSample { id: 0, value: 0. },
        AxisSample { id: 1, value: 255. },
        AxisSample { id: 2, value: 11. },
        AxisSample { id: 3, value: 22. },
    ]);
    let frame = encoder.encode(&mut ui, &input.frame()).unwrap();
    assert_eq!(frame.touches, [7 << 18 | 2 << 9 | 1, 0x4000_0000 | 7 << 18]);
    assert_eq!(frame.surfaces, [0, 1]);
    assert_eq!(frame.hits[1], 0);
    assert_eq!(frame.analog, 0x00ff);
    assert_eq!(frame.right_analog, 11 << 8 | 22);
}
#[test]
fn rejects_duplicate_contacts_and_nonfinite_coordinates() {
    let mut ui = Ui::new();
    let mut encoder = InputEncoder::new();
    let mut input = InputFrameBuilder::new();
    input.contacts.extend([contact(0, 1, 1., 2.); 2]);
    assert!(encoder.encode(&mut ui, &input.frame()).is_err());
    input.contacts.pop();
    input.contacts[0].x = f32::NAN;
    assert!(encoder.encode(&mut ui, &input.frame()).is_err());
    input.contacts.clear();
    input.pointer = Some(Pointer {
        surface: 1,
        x: 1.,
        y: 2.,
        buttons: 0,
    });
    assert!(encoder.encode(&mut ui, &input.frame()).is_err());
    ui.create_auxiliary_surface(400., 240.);
    assert!(encoder.encode(&mut ui, &input.frame()).is_ok());
    input.pointer.as_mut().unwrap().surface = 2;
    assert!(encoder.encode(&mut ui, &input.frame()).is_err());
}

#[test]
fn mixed_wide_ids_reserve_native_ids_and_keep_existing_lifetimes() {
    let mut ui = Ui::new();
    let mut encoder = InputEncoder::new();
    let mut input = InputFrameBuilder::new();
    input
        .contacts
        .extend([contact(0, 256, 1., 2.), contact(0, 0, 3., 4.)]);
    let first = encoder.encode(&mut ui, &input.frame()).unwrap();
    assert_eq!((first.touches[1] >> 18) & 255, 0);
    assert_ne!((first.touches[0] >> 18) & 255, 0);
    input.contacts.reverse();
    let reversed = encoder.encode(&mut ui, &input.frame()).unwrap();
    assert_eq!(first.touches[0], reversed.touches[1]);
    assert_eq!(first.touches[1], reversed.touches[0]);
}

#[test]
fn invalid_axis_sample_does_not_create_a_down_edge_capture() {
    let mut ui = Ui::new();
    let node = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(node, spec::prop::WIDTH, 100.);
    ui.set_prop(node, spec::prop::HEIGHT, 100.);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.draw();
    let mut encoder = InputEncoder::new();
    let mut input = InputFrameBuilder::new();
    input.contacts.push(contact(0, 1, 10., 10.));
    input.axes.push(AxisSample {
        id: 0,
        value: f32::NAN,
    });
    assert!(encoder.encode(&mut ui, &input.frame()).is_err());
    ui.destroy_node(node);
    input.axes.clear();
    assert_ne!(
        encoder.encode(&mut ui, &input.frame()).unwrap().hits,
        [node]
    );
}
