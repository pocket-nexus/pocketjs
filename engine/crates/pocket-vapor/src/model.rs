//! Frame-boundary protocol shared by compiled models and native hosts.
use alloc::{string::String, vec::Vec};
use core::{cell::Cell, sync::atomic::{AtomicU32, Ordering}};
use crate::NodeId;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskId { pub region: u32, pub function: u32, pub call: u32 }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RequestId { pub task: TaskId, pub wait: u32, pub member: u32 }

static NEXT_REGION: AtomicU32 = AtomicU32::new(1);
/// Identity belongs to a mount, rather than the factory's source name.
pub fn next_region() -> u32 {
    let id = NEXT_REGION.fetch_add(1, Ordering::Relaxed);
    assert_ne!(id, 0, "model region identity exhausted");
    id
}

#[derive(Debug, Default)]
pub struct NodeSlot(Cell<Option<NodeId>>);
impl NodeSlot {
    pub fn get(&self) -> Option<NodeId> { self.0.get() }
    pub fn set(&self, node: NodeId) { self.0.set(Some(node)); }
    pub fn clear(&self) { self.0.set(None); }
}

/// Transport values are validated by the generated service contract adapter.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Unit, Bool(bool), I32(i32), Number(f64), String(String),
    Array(Vec<Value>), Object(Vec<(String, Value)>),
}
impl Default for Value { fn default() -> Self { Self::Unit } }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnimationResult { Ended, Replaced, Dropped }
#[derive(Clone, Debug, PartialEq)]
pub enum Completion { Value(Value), Animation(AnimationResult), Cancelled }
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery { pub request: RequestId, pub result: Completion }

/// Immutable snapshot for one resume phase. Hosts fill deliveries between frames.
#[derive(Clone, Debug, Default)]
pub struct Ready {
    pub frame: u64,
    pub now_ms: f64,
    pub deliveries: Vec<Delivery>,
}
impl Ready {
    pub fn delivery(&self, request: RequestId) -> Option<&Completion> {
        self.deliveries.iter().find(|entry| entry.request == request).map(|entry| &entry.result)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    Animate { node: Option<NodeId>, prop: u8, to: f32, dur: u32, easing: u8, delay: u32, request: Option<RequestId> },
    Jump { node: Option<NodeId>, prop: u8, value: f32 },
    Request { service: String, call: String, args: Vec<Value>, request: RequestId },
    Cancel { request: RequestId },
    Log(String),
}

/// Depth is local to an invocation tree, including calls into pure modules.
#[derive(Debug)]
pub struct Depth { current: Cell<u32>, limit: u32 }
impl Depth {
    pub fn new(limit: u32) -> Self { Self { current: Cell::new(0), limit } }
    pub fn enter(&self, function: &str) {
        if cfg!(debug_assertions) {
            let next = self.current.get().checked_add(1).expect("model call depth exhausted");
            assert!(next <= self.limit, "model recursion limit exceeded in {}", function);
            self.current.set(next);
        }
    }
    pub fn leave(&self) { if cfg!(debug_assertions) { self.current.set(self.current.get() - 1); } }
}

#[macro_export]
macro_rules! depth_enter { ($model:expr, $name:expr) => { $model.depth.enter($name) }; }
#[macro_export]
macro_rules! depth_leave { ($model:expr) => { $model.depth.leave() }; }

/// Capacity is measured in UTF-8 bytes on every execution class.
pub fn cap_string(mut value: String, capacity: usize, field: &str) -> String {
    let mut used = 0;
    let mut end = value.len();
    for (index, character) in value.char_indices() {
        used += character.len_utf8();
        if used > capacity { end = index; break; }
    }
    assert!(!cfg!(debug_assertions) || end == value.len(), "model capacity exceeded in {}", field);
    value.truncate(end);
    value
}
pub fn cap_array<T>(mut value: Vec<T>, capacity: usize, field: &str) -> Vec<T> {
    assert!(!cfg!(debug_assertions) || value.len() <= capacity, "model capacity exceeded in {}", field);
    value.truncate(capacity);
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn request_identity_includes_mount_function_call_wait_and_member() {
        let a = TaskId { region: next_region(), function: 1, call: 1 };
        let b = TaskId { region: next_region(), ..a };
        assert_ne!(a, b);
        let request = RequestId { task: a, wait: 1, member: 0 };
        let ready = Ready { deliveries: alloc::vec![Delivery { request, result: Completion::Value(Value::I32(7)) }], ..Ready::default() };
        assert!(ready.delivery(RequestId { wait: 2, ..request }).is_none());
        assert!(ready.delivery(RequestId { member: 1, ..request }).is_none());
        assert_eq!(ready.delivery(request), Some(&Completion::Value(Value::I32(7))));
    }
    #[test] fn slot_lifetime_is_explicit() {
        let slot = NodeSlot::default();
        assert_eq!(slot.get(), None);
        slot.set(NodeId(7)); assert_eq!(slot.get(), Some(NodeId(7)));
        slot.clear(); assert_eq!(slot.get(), None);
    }
    #[test] #[should_panic(expected = "model recursion limit exceeded in recurse")]
    fn recursion_has_named_limit() { let depth = Depth::new(1); depth.enter("recurse"); depth.enter("recurse"); }
}

pub use heapless;

pub fn append_display<T: crate::VaporDisplay + ?Sized>(out: &mut String, value: &T) {
    use core::fmt::Write;
    let _ = write!(out, "{}", crate::display(value));
}
pub fn to_string<T: crate::VaporDisplay + ?Sized>(value: &T) -> String {
    let mut out = String::new(); append_display(&mut out, value); out
}
pub fn concat<A: crate::VaporDisplay + ?Sized, B: crate::VaporDisplay + ?Sized>(a: &A, b: &B) -> String {
    let mut out = String::new(); append_display(&mut out, a); append_display(&mut out, b); out
}
impl<const N: usize> crate::VaporDisplay for heapless::String<N> {
    fn fmt_vapor(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { formatter.write_str(self.as_str()) }
}
impl<const N: usize> crate::builtins::Length for heapless::String<N> { fn scalar_len(&self) -> usize { self.chars().count() } }
impl<T, const N: usize> crate::builtins::Length for heapless::Vec<T, N> { fn scalar_len(&self) -> usize { self.len() } }

pub fn bounded_string<const N: usize>(value: &str, name: &str) -> heapless::String<N> {
    let mut out = heapless::String::new();
    for c in value.chars() {
        if out.push(c).is_err() { assert!(!cfg!(debug_assertions), "model capacity exceeded in {}", name); break; }
    }
    out
}
pub fn bounded_array<T, const N: usize>(value: impl IntoIterator<Item=T>, name: &str) -> heapless::Vec<T, N> {
    let mut out = heapless::Vec::new();
    for element in value { if out.push(element).is_err() { assert!(!cfg!(debug_assertions), "model capacity exceeded in {}", name); break; } }
    out
}
/// Formats into fixed storage and truncates at the first overflowing UTF-8 scalar.
pub fn append_bounded_display<const N: usize, T: crate::VaporDisplay + ?Sized>(out: &mut heapless::String<N>, value: &T, name: &str) {
    struct Writer<'a, const N: usize> { out: &'a mut heapless::String<N>, overflow: bool }
    impl<const N: usize> core::fmt::Write for Writer<'_, N> {
        fn write_str(&mut self, text: &str) -> core::fmt::Result {
            for c in text.chars() {
                if self.overflow || self.out.push(c).is_err() { self.overflow = true; break; }
            }
            Ok(())
        }
    }
    use core::fmt::Write;
    let mut writer = Writer { out, overflow: false };
    let _ = write!(&mut writer, "{}", crate::display(value));
    assert!(!cfg!(debug_assertions) || !writer.overflow, "model capacity exceeded in {}", name);
}
pub fn bounded_concat<const N: usize>(a: &impl crate::VaporDisplay, b: &impl crate::VaporDisplay, name: &str) -> heapless::String<N> {
    let mut out = heapless::String::new(); append_bounded_display(&mut out, a, name); append_bounded_display(&mut out, b, name); out
}

#[derive(Clone, Debug)]
pub enum Wait {
    Frames { request: RequestId, until: u64 },
    After { request: RequestId, until: f64 },
    Until { request: RequestId, predicate: u32 },
    Delivery { request: RequestId },
    Join { request: RequestId, target: TaskId, wrapped: bool },
    All(Vec<Wait>), Any(Vec<Wait>),
    Resolved(Value),
}
#[derive(Clone, Debug)]
pub struct TaskOutcome { pub task: TaskId, pub result: Completion }
impl Wait {
    pub fn poll(&mut self, ready: &Ready, predicates: &[(u32, bool)], outcomes: &[TaskOutcome]) -> Option<Completion> {
        match self {
            Self::Frames { until, .. } if ready.frame >= *until => Some(Completion::Value(Value::Unit)),
            Self::After { until, .. } if ready.now_ms >= *until => Some(Completion::Value(Value::Unit)),
            Self::Until { predicate, .. } if predicates.iter().any(|(id, value)| id == predicate && *value) => Some(Completion::Value(Value::Unit)),
            Self::Delivery { request } => ready.delivery(*request).cloned(),
            Self::Join { target, wrapped, .. } => outcomes.iter().find(|outcome| outcome.task == *target).map(|outcome| {
                if !*wrapped { return outcome.result.clone(); }
                Completion::Value(match &outcome.result {
                    Completion::Cancelled => Value::Object(alloc::vec![(String::from("kind"), Value::String(String::from("cancelled")))]),
                    Completion::Value(value) => Value::Object(alloc::vec![(String::from("kind"), Value::String(String::from("done"))), (String::from("value"), value.clone())]),
                    Completion::Animation(value) => Value::Object(alloc::vec![(String::from("kind"), Value::String(String::from("done"))), (String::from("value"), value.model_value())]),
                })
            }),
            Self::All(members) => {
                for member in members.iter_mut() {
                    if matches!(member, Self::Resolved(_)) { continue; }
                    match member.poll(ready, predicates, outcomes) {
                        Some(Completion::Cancelled) => return Some(Completion::Cancelled),
                        Some(Completion::Value(value)) => *member = Self::Resolved(value),
                        Some(Completion::Animation(value)) => *member = Self::Resolved(value.model_value()),
                        None => {},
                    }
                }
                if members.iter().all(|member| matches!(member, Self::Resolved(_))) {
                    Some(Completion::Value(Value::Array(members.iter().map(|member| match member { Self::Resolved(value) => value.clone(), _ => unreachable!() }).collect())))
                } else { None }
            }
            Self::Any(members) => {
                // The traversal order is also the same-snapshot tie breaker.
                for member in members.iter_mut() {
                    if let Some(result) = member.poll(ready, predicates, outcomes) {
                        *member = Self::Resolved(Value::Unit);
                        return Some(result);
                    }
                }
                None
            }
            Self::Resolved(value) => Some(Completion::Value(value.clone())),
            _ => None,
        }
    }
    pub fn cancel(&self, commands: &mut Vec<Cmd>) {
        match self {
            Self::Frames { request, .. } | Self::After { request, .. } | Self::Until { request, .. } | Self::Delivery { request } | Self::Join { request, .. } => commands.push(Cmd::Cancel { request: *request }),
            Self::All(members) | Self::Any(members) => { for member in members { member.cancel(commands); } },
            Self::Resolved(_) => {},
        }
    }
    pub fn references(&self, id: TaskId) -> bool {
        match self { Self::Join { target, .. } => *target == id, Self::All(m) | Self::Any(m) => m.iter().any(|w| w.references(id)), _ => false }
    }
}
#[derive(Clone, Debug, Default)]
pub struct TaskState {
    pub task: TaskId, pub generation: u32, pub wait_generation: u32,
    pub state: u32, pub order: u64, pub live: bool, pub issued: u64,
    pub wait: Option<Wait>,
}
impl TaskState {
    pub fn start(&mut self, region: u32, function: u32, order: u64) -> TaskId {
        self.generation = self.generation.wrapping_add(1);
        self.task = TaskId { region, function, call: self.generation };
        self.wait_generation = 0; self.state = 0; self.order = order; self.live = true; self.wait = None;
        self.task
    }
    pub fn request(&self, member: u32) -> RequestId { RequestId { task: self.task, wait: self.wait_generation, member } }
    pub fn suspend(&mut self, state: u32, frame: u64, wait: Wait) { self.state = state; self.issued = frame; self.wait = Some(wait); }
    pub fn cancel(&mut self, commands: &mut Vec<Cmd>, outcomes: &mut Vec<TaskOutcome>) {
        if !self.live { return; }
        if let Some(wait) = self.wait.take() { wait.cancel(commands); }
        self.live = false; outcomes.push(TaskOutcome { task: self.task, result: Completion::Cancelled });
    }
    pub fn complete_wait(&mut self, commands: &mut Vec<Cmd>) {
        if let Some(wait) = self.wait.take() {
            if matches!(wait, Wait::Any(_)) { wait.cancel(commands); }
        }
    }
    pub fn finish(&mut self, value: Value, outcomes: &mut Vec<TaskOutcome>) {
        self.live = false; self.wait = None;
        outcomes.push(TaskOutcome { task: self.task, result: Completion::Value(value) });
    }
    pub fn poll(&mut self, ready: &Ready, predicates: &[(u32, bool)], outcomes: &[TaskOutcome]) -> Option<Completion> {
        if !self.live || ready.frame <= self.issued { return None; }
        self.wait.as_mut()?.poll(ready, predicates, outcomes)
    }
}

pub trait ModelValue: Sized {
    fn model_value(&self) -> Value;
    fn from_model_value(value: &Value) -> Option<Self>;
}
impl ModelValue for () {
    fn model_value(&self) -> Value { Value::Unit }
    fn from_model_value(value: &Value) -> Option<Self> { matches!(value, Value::Unit).then_some(()) }
}
impl ModelValue for bool {
    fn model_value(&self) -> Value { Value::Bool(*self) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::Bool(v) => Some(*v), _ => None } }
}
impl ModelValue for String {
    fn model_value(&self) -> Value { Value::String(self.clone()) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::String(v) => Some(v.clone()), _ => None } }
}
impl ModelValue for i32 {
    fn model_value(&self) -> Value { Value::I32(*self) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::I32(v) => Some(*v), _ => None } }
}
impl ModelValue for f64 {
    fn model_value(&self) -> Value { Value::Number(*self) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::Number(v) => Some(*v), _ => None } }
}
impl ModelValue for AnimationResult {
    fn model_value(&self) -> Value { Value::String(String::from(match self { Self::Ended => "ended", Self::Replaced => "replaced", Self::Dropped => "dropped" })) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::String(v) => match v.as_str() { "ended" => Some(Self::Ended), "replaced" => Some(Self::Replaced), "dropped" => Some(Self::Dropped), _ => None }, _ => None } }
}
impl<T: ModelValue> ModelValue for Vec<T> {
    fn model_value(&self) -> Value { Value::Array(self.iter().map(ModelValue::model_value).collect()) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::Array(v) => v.iter().map(T::from_model_value).collect(), _ => None } }
}
pub fn decode<T: ModelValue>(value: &Completion) -> T {
    let value = match value { Completion::Value(value) => value.clone(), Completion::Animation(value) => value.model_value(), Completion::Cancelled => panic!("cancelled task cannot resume") };
    T::from_model_value(&value).expect("malformed model completion")
}
