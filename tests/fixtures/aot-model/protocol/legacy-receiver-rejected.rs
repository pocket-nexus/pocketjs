trait CounterViewModel { fn double(&mut self) -> i32; }
struct HandWritten;
impl CounterViewModel for HandWritten { fn double(&self) -> i32 { 0 } }
