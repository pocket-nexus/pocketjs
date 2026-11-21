trait CounterViewModel { fn label(&self) -> &str; fn double(&mut self) -> i32; }
fn view<M: CounterViewModel>(m: &mut M) -> String {
    let label = m.label();
    format!("{} {}", label, m.double())
}
