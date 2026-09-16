mod generated;
use generated::*;
use pocket_vapor::{Host, Input, NodeId, Ui};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

thread_local! {
    static TRACE: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static NEXT: Cell<i32> = const { Cell::new(0) };
    static LIVE: Cell<i32> = const { Cell::new(0) };
}
fn log(value: impl Into<String>) {
    TRACE.with(|trace| trace.borrow_mut().push(value.into()));
}
fn take_trace() -> Vec<String> {
    TRACE.with(|trace| std::mem::take(&mut *trace.borrow_mut()))
}

struct RowModel {
    id: i32,
    presses: i32,
}
impl Default for RowModel {
    fn default() -> Self {
        let id = NEXT.with(|next| {
            let id = next.get() + 1;
            next.set(id);
            id
        });
        LIVE.with(|live| live.set(live.get() + 1));
        log(format!("create:{id}"));
        Self { id, presses: 0 }
    }
}
impl RowViewModel for RowModel {
    fn presses(&self) -> i32 {
        self.presses
    }
    fn load(&mut self) {
        log(format!("mount:{}", self.id));
    }
    fn release(&mut self) {
        log(format!("unmount:{}", self.id));
        LIVE.with(|live| live.set(live.get() - 1));
    }
    fn press(&mut self) -> String {
        self.presses += 1;
        let value = format!("{}:{}", self.id, self.presses);
        log(format!("press:{value}"));
        value
    }
}

fn item(value: &Value) -> Item {
    Item {
        id: value["id"].as_str().unwrap().into(),
        label: value["label"].as_str().unwrap().into(),
        children: value["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|child| Nested {
                id: child["id"].as_str().unwrap().into(),
            })
            .collect(),
    }
}
struct Model {
    rows: Vec<Item>,
    original: Item,
    open: bool,
    late: bool,
    angle: i32,
    remove_next: bool,
}
impl Model {
    fn new(fixture: &Value) -> Self {
        Self {
            rows: fixture["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(item)
                .collect(),
            original: item(&fixture["rows"][0]),
            open: true,
            late: false,
            angle: 0,
            remove_next: false,
        }
    }
}
#[allow(non_snake_case)]
impl AppViewModel for Model {
    type Row = RowModel;
    fn rows(&self) -> &[Item] {
        &self.rows
    }
    fn open(&self) -> bool {
        self.open
    }
    fn set_open(&mut self, value: bool) {
        log(format!("set:open:{value}"));
        self.open = value;
    }
    fn late(&self) -> bool {
        self.late
    }
    fn live(&self) -> i32 {
        LIVE.with(Cell::get)
    }
    fn angle(&self) -> i32 {
        self.angle
    }
    fn removeNext(&self) -> bool {
        self.remove_next
    }
    fn load(&mut self) {
        log("parent mount");
        self.set_open(false);
        self.late = true;
    }
    fn release(&mut self) {
        log("parent unmount");
    }
    fn replace(&mut self) {
        log("replace");
        for row in &mut self.rows {
            row.label.push('+');
        }
    }
    fn reverse(&mut self) {
        log("reverse");
        self.rows.reverse();
    }
    fn rename(&mut self, id: String) {
        log(format!("rename:{id}"));
        if let Some(row) = self.rows.iter_mut().find(|row| row.id == id) {
            row.label.push('!');
        }
    }
    fn record(&mut self, value: String) {
        log(format!("record:{value}"));
    }
    fn event(&mut self, value: String) {
        log(format!("emit:saved:{value}"));
    }
    fn remove(&mut self) {
        log("remove:a");
        self.rows.retain(|row| row.id != "a");
        self.remove_next = false;
    }
    fn armRemoval(&mut self) {
        log("arm");
        self.remove_next = true;
    }
    fn restore(&mut self) {
        log("restore:a");
        self.rows.push(self.original.clone());
    }
    fn adjust(&mut self, delta: i32) {
        log(format!("axis:{delta}"));
        self.angle += delta;
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
impl<const BUTTON: u32> pocket_vapor::HasButton<BUTTON> for NativeHost {}
impl pocket_vapor::HasRelativeAxis<0> for NativeHost {}

fn tree(ui: &Ui, id: i32) -> Option<Value> {
    let style = ui.core().resolved_style(id)?;
    // The generated fragment/input anchors are hidden empty nodes.
    if style.display == pocket_vapor::spec::Display::None as u8 {
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
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(&paths[1]).unwrap()).unwrap();
    let tape: Value = serde_json::from_str(&std::fs::read_to_string(&paths[2]).unwrap()).unwrap();
    let styles = std::fs::read(&paths[3]).unwrap();
    let mut ui = Ui::new();
    assert!(ui.load_styles(&styles));
    let mut app = AppApp::new(NativeHost(ui), AppProps {}, Model::new(&fixture));
    let mut frames = vec![];
    for frame in tape.as_array().unwrap() {
        let input = Input::buttons(frame["buttons"].as_u64().unwrap() as u32)
            .with_axis(0, frame["axis"].as_i64().unwrap_or(0) as i32);
        app.frame(&input);
        frames.push(snapshot(app.ui()));
    }
    let ui = app.unmount();
    frames.push(snapshot(&ui));
    println!("{}", json!(frames));
}
