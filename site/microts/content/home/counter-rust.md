## src/main.rs

```rust
#[path = "../gen/mod.rs"]
mod generated;

use generated::{CounterApp, CounterProps, CounterViewModel};
use microts::{Input, Ui};

#[derive(Default)]
struct Model { count: i32 }

impl CounterViewModel for Model {
    fn count(&self) -> i32 { self.count }
    fn set_count(&mut self, value: i32) { self.count = value; }
}

fn main() {
    let mut ui = Ui::new();
    assert!(ui.load_styles(include_bytes!("../gen/styles.bin")));
    ui.core_mut().set_viewport(480.0, 272.0);

    let mut app = CounterApp::new(ui, CounterProps {}, Model::default());
    app.frame(&Input::default());
}
```
