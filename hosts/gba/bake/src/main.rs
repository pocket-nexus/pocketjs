//! Compile the generated Hero view to reusable GBA image layers on the host.
//! Every pixel comes from the retained core's normal layout and RGBA rasterizer.
//! The cartridge still runs the generated model, view updates and animations.

extern crate alloc;

use microts::{Input, NodeId, Ui};
use pocketjs_core::spec::{self, prop};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

include!(concat!(env!("GBA_GENERATED"), "/include.rs"));
use generated::AppViewModel;

const WIDTH: usize = 240;
const HEIGHT: usize = 160;
const SPINNER: [usize; 4] = [200, 56, 32, 48];
const UNDERLINE: [usize; 4] = [0, 80, 160, 16];
const BUTTON: [usize; 4] = [0, 112, 96, 48];
const MESSAGE: [usize; 4] = [8, 144, 224, 16];
const DIGITS: [usize; 4] = [100, 120, 16, 32];

type App = generated::AppApp<generated::AppModel>;

fn find_node(ui: &Ui, root: NodeId, name: &str) -> Option<NodeId> {
    if ui.debug_name(root) == Some(name) {
        return Some(root);
    }
    ui.core()
        .node_children(root.0)
        .iter()
        .find_map(|&id| find_node(ui, NodeId(id), name))
}

fn find_text(ui: &Ui, root: NodeId) -> Option<NodeId> {
    if ui.core().node_type(root.0) == Some(spec::NodeType::Text as u8) {
        return Some(root);
    }
    ui.core()
        .node_children(root.0)
        .iter()
        .find_map(|&id| find_text(ui, NodeId(id)))
}

fn named(ui: &Ui, name: &str) -> NodeId {
    find_node(ui, NodeId::ROOT, name).unwrap_or_else(|| panic!("Missing baked layer {name}"))
}

fn rgba(app: &mut App) -> Vec<u8> {
    let core = app.ui_mut().core_mut();
    core.draw();
    let mut pixels = vec![0; WIDTH * HEIGHT * 4];
    pocketjs_core::raster::render(core, &core.current_draw_list().words, &mut pixels);
    pixels
}

fn rgb555(pixels: &[u8]) -> Vec<u16> {
    pixels
        .chunks_exact(4)
        .map(|pixel| {
            (pixel[0] as u16 >> 3) | ((pixel[1] as u16 >> 3) << 5) | ((pixel[2] as u16 >> 3) << 10)
        })
        .collect()
}

fn write_pixels(out: &Path, name: &str, pixels: &[u16]) {
    let bytes: Vec<u8> = pixels
        .iter()
        .flat_map(|pixel| pixel.to_le_bytes())
        .collect();
    fs::write(out.join(name), bytes).unwrap();
}

fn capture(app: &mut App, out: &Path, name: &str) -> Vec<u16> {
    let pixels = rgb555(&rgba(app));
    write_pixels(out, name, &pixels);
    pixels
}

fn patch(app: &mut App, out: &Path, name: &str, background: &[u16], crop: [usize; 4]) {
    let pixels = capture(app, out, name);
    let [x, y, width, height] = crop;
    for (index, (&actual, &base)) in pixels.iter().zip(background).enumerate() {
        let px = index % WIDTH;
        let py = index / WIDTH;
        assert!(
            actual == base || (px >= x && px < x + width && py >= y && py < y + height),
            "{name} changes pixel ({px}, {py}) outside crop {crop:?}"
        );
    }
}

fn set_visible(app: &mut App, nodes: &[NodeId], visible: Option<NodeId>) {
    for &node in nodes {
        app.ui_mut().set_prop(
            node,
            prop::OPACITY,
            if Some(node) == visible { 1.0 } else { 0.0 },
        );
    }
}

fn advance_to_phase(app: &mut App, phase: i32) {
    for _ in 0..64 {
        if app.model.phase() == phase {
            return;
        }
        app.frame(&Input::default());
    }
    panic!("Generated spinner task did not reach phase {phase}");
}

fn reference(app: &mut App, out: &Path, count: usize) {
    // Exercise generated handlers and view updates to produce the reference.
    app.model.reset();
    for _ in 0..count {
        app.model.press();
    }
    app.invalidate();
    app.frame(&Input::default());
    advance_to_phase(app, 0);
    let pixels = rgba(app);
    fs::write(out.join(format!("reference-{count}.rgba")), &pixels).unwrap();
    write_pixels(out, &format!("reference-{count}.rgb555"), &rgb555(&pixels));
}

fn main() {
    let out = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("Usage: pocketjs-gba-bake OUTPUT_DIRECTORY"),
    );
    fs::create_dir_all(&out).unwrap();
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(WIDTH as f32, HEIGHT as f32);
    assert!(ui.core_mut().set_tick_rate(30));
    assert!(ui.load_styles(include_bytes!(concat!(
        env!("GBA_GENERATED"),
        "/styles.bin"
    ))));
    load_fonts(&mut ui);
    load_images(&mut ui);
    let mut app = App::new(ui, generated::AppProps {}, generated::AppModel::default());
    let spinner = named(app.ui(), "Spinner");
    let underline = named(app.ui(), "Underline");
    let button = named(app.ui(), "HeroAction");
    let message = named(app.ui(), "ReactiveMessage");
    let counter = named(app.ui(), "Counter");
    let counter_text = find_text(app.ui(), counter).expect("Counter must contain its text node");
    let layers = [spinner, underline, button, message];
    app.ui_mut().set_focus(button);
    // Complete the mount reveal and focus transition before overriding fixture
    // properties. This leaves the original animation path intact on cartridge.
    for _ in 0..40 {
        app.frame(&Input::default());
    }
    reference(&mut app, &out, 0);
    reference(&mut app, &out, 6);

    let counter_style = app.ui().core().resolved_style(counter_text.0).unwrap();
    assert_eq!(
        counter_style.tracking, 0.0,
        "The digit pack requires zero tracking"
    );
    let font_slot = counter_style.font_slot as u8;
    let prefix_advance = app.ui().core().measure_text("Count: ", font_slot);
    set_visible(&mut app, &layers, None);
    app.ui_mut().set_text(counter_text, "Count: ");
    let background = capture(&mut app, &out, "background.rgb555");

    let mut spinner_frames = Vec::new();
    for phase in 0..8 {
        advance_to_phase(&mut app, phase);
        set_visible(&mut app, &layers, Some(spinner));
        app.ui_mut().set_text(counter_text, "Count: ");
        let file = format!("spinner-{phase:02}.rgb555");
        patch(&mut app, &out, &file, &background, SPINNER);
        spinner_frames.push(json!({ "file": file }));
    }

    set_visible(&mut app, &layers, Some(underline));
    app.ui_mut().set_prop(underline, prop::TRANSLATE_X, 0.0);
    let mut underline_frames = Vec::new();
    for width in 0..=144 {
        app.ui_mut().set_prop(underline, prop::WIDTH, width as f64);
        let file = format!("underline-{width:03}.rgb555");
        patch(&mut app, &out, &file, &background, UNDERLINE);
        underline_frames.push(json!({ "file": file, "width": width }));
    }

    set_visible(&mut app, &layers, Some(button));
    // Read the endpoint colors from the actual focus and active variants, then
    // sample their color interval for the hardware palette/patch selector.
    app.ui_mut().core_mut().set_active(button.0, true);
    for _ in 0..8 {
        app.ui_mut().tick();
    }
    let active_color = app.ui().core().resolved_style(button.0).unwrap().bg_color;
    app.ui_mut().core_mut().set_active(button.0, false);
    for _ in 0..8 {
        app.ui_mut().tick();
    }
    let idle_color = app.ui().core().resolved_style(button.0).unwrap().bg_color;
    let mut button_frames = Vec::new();
    for step in 0..=20 {
        let color = pocketjs_core::anim::interp(active_color, idle_color, step as f32 / 20.0, true);
        app.ui_mut().set_prop(button, prop::BG_COLOR, color as f64);
        let file = format!("button-{step:02}.rgb555");
        patch(&mut app, &out, &file, &background, BUTTON);
        button_frames.push(json!({ "file": file, "color": color }));
    }

    set_visible(&mut app, &layers, Some(message));
    patch(&mut app, &out, "message.rgb555", &background, MESSAGE);

    set_visible(&mut app, &layers, None);
    app.ui_mut().set_text(counter_text, "");
    let digits_background = capture(&mut app, &out, "digits-background.rgb555");
    let mut digits = Vec::new();
    for character in "0123456789-".chars() {
        let label = if character == '-' {
            "minus".to_owned()
        } else {
            character.to_string()
        };
        let text = character.to_string();
        let advance = app.ui().core().measure_text(&text, font_slot);
        app.ui_mut().set_text(counter_text, &text);
        let file = format!("digit-{label}.rgb555");
        patch(&mut app, &out, &file, &digits_background, DIGITS);
        digits.push(json!({ "file": file, "advance": advance, "char": text }));
    }

    let manifest = json!({
        "width": WIDTH, "height": HEIGHT, "format": "rgb555le",
        "background": "background.rgb555", "spinner": spinner_frames,
        "underline": underline_frames, "button": button_frames,
        "digits": digits, "digitsBackground": "digits-background.rgb555",
        "prefixAdvance": prefix_advance, "message": "message.rgb555",
        "crops": { "spinner": SPINNER, "underline": UNDERLINE,
            "button": BUTTON, "message": MESSAGE, "digits": DIGITS }
    });
    fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    )
    .unwrap();
    println!(
        "Baked native Hero layers into {} (digit prefix advance {prefix_advance}px)",
        out.display()
    );
}
