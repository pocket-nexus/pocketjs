#![allow(dead_code)]
#[derive(Default)] pub struct Feature;
pub struct RowProps<'a> { pub title: &'a str, pub value: i32 }
pub trait CounterViewModel {
    fn label(&self) -> &str;
    fn features(&self) -> &[Feature];
    fn double(&self) -> i32;
    fn enabled_count(&self) -> i32;
    fn double_now(&mut self) -> i32 { self.double() }
    fn enabled_count_now(&mut self) -> i32 { self.enabled_count() }
    fn set_count(&mut self, value: i32);
    fn record(&mut self, value: i32);
    fn react(&mut self, _initial: bool) {}
    fn settle(&mut self) {}
}
pub fn dispatch<M: CounterViewModel>(m: &mut M) {
    m.set_count(1);
    let arg = m.double_now();
    m.record(arg);
    let active = m.double_now() > 0;
    let value = m.enabled_count_now();
    let props = RowProps { title: m.label(), value };
    let _ = (active, props);
}
pub fn view<M: CounterViewModel>(m: &M) -> (String, RowProps<'_>, usize) {
    let label = m.label();
    let text = format!("{} {} {}", label, m.double(), m.enabled_count());
    let props = RowProps { title: m.label(), value: m.double() };
    (text, props, m.features().len())
}
#[derive(Default)] struct HandWritten { count: i32, recorded: i32 }
impl CounterViewModel for HandWritten {
    fn label(&self) -> &str { "counter" }
    fn features(&self) -> &[Feature] { &[] }
    fn double(&self) -> i32 { self.count * 2 }
    fn enabled_count(&self) -> i32 { 0 }
    fn set_count(&mut self, value: i32) { self.count = value; }
    fn record(&mut self, value: i32) { self.recorded = value; }
}
#[test] fn legacy_model_and_dispatch_companions() {
    let mut model = HandWritten::default();
    dispatch(&mut model);
    model.react(false); model.settle();
    assert_eq!(model.recorded, 2);
    assert_eq!(view(&model).0, "counter 2 0");
}
