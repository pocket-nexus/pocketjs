mod generated;
use generated::*;
use microts::{Host, Input, NodeId, Ui};
use serde_json::{json, Value};
use std::cell::RefCell;

thread_local! {
    static TRACE: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}
fn log(value: impl Into<String>) {
    TRACE.with(|trace| trace.borrow_mut().push(value.into()));
}
fn take_trace() -> Vec<String> {
    TRACE.with(|trace| std::mem::take(&mut *trace.borrow_mut()))
}

struct Model {
    live: bool,
    open: bool,
    held: i32,
}
#[allow(non_snake_case)]
impl AppViewModel for Model {
    fn delay(&self) -> i32 {
        90
    }
    fn live(&self) -> bool {
        self.live
    }
    fn open(&self) -> bool {
        self.open
    }
    fn held(&self) -> i32 {
        self.held
    }
    fn press(&mut self, pressed: i32, buttons: i32) {
        log(format!("press:{pressed}:{buttons}"));
        self.held += 1;
    }
    fn hold(&mut self, mask: i32, buttons: i32) {
        log(format!("hold:{mask}:{buttons}"));
    }
    fn release(&mut self, released: i32, buttons: i32) {
        log(format!("release:{released}:{buttons}"));
        self.held -= 1;
    }
    fn combo(&mut self, pressed: i32, buttons: i32) {
        log(format!("combo:{pressed}:{buttons}"));
    }
    fn record(&mut self, value: String) {
        log(value);
    }
    fn toggleLive(&mut self) {
        log(format!("live:{}", !self.live));
        self.live = !self.live;
    }
    fn toggleOpen(&mut self) {
        log(format!("open:{}", !self.open));
        self.open = !self.open;
    }
}

struct NativeHost(Ui);
impl Host for NativeHost {
    fn ui(&self) -> &Ui {
        &self.0
    }
    fn ui_mut(&mut self) -> &mut Ui {
        &mut self.0
    }
    fn into_ui(self) -> Ui {
        self.0
    }
}
impl<const BUTTON: u32> microts::HasButton<BUTTON> for NativeHost {}

fn tree(ui: &Ui, id: i32) -> Option<Value> {
    let style = ui.core().resolved_style(id)?;
    // The generated fragment/input anchors are hidden empty nodes.
    if style.display == microts::spec::Display::None as u8 {
        return None;
    }
    let kind = ui.core().node_type(id).unwrap();
    let text = ui.core().node_text(id).unwrap();
    let children: Vec<_> = if kind == 1 {
        vec![]
    } else {
        ui.core()
            .node_children(id)
            .iter()
            .filter_map(|child| tree(ui, *child))
            .collect()
    };
    Some(
        json!({ "type": kind, "text": text, "style": { "bgColor": style.bg_color, "textColor": style.text_color }, "children": children }),
    )
}
fn snapshot(ui: &Ui) -> Value {
    let children: Vec<_> = ui
        .core()
        .node_children(NodeId::ROOT.0)
        .iter()
        .filter_map(|id| tree(ui, *id))
        .collect();
    json!({ "tree": children, "trace": take_trace(), "focus": if ui.focused().is_none() { Value::Null } else { json!(ui.debug_name(ui.focused())) } })
}
fn main() {
    let paths: Vec<_> = std::env::args().collect();
    let tape: Value = serde_json::from_str(&std::fs::read_to_string(&paths[2]).unwrap()).unwrap();
    let styles = std::fs::read(&paths[3]).unwrap();
    let mut ui = Ui::new();
    assert!(ui.load_styles(&styles));
    let model = Model {
        live: true,
        open: false,
        held: 0,
    };
    let mut app = AppApp::new(NativeHost(ui), AppProps {}, model);
    let mut frames = vec![];
    for frame in tape.as_array().unwrap() {
        app.frame(&Input::buttons(frame["buttons"].as_u64().unwrap() as u32));
        frames.push(snapshot(app.ui()));
    }
    let ui = app.unmount();
    frames.push(snapshot(&ui));
    println!("{}", json!(frames));
}
