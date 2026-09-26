//! Frame-boundary protocol shared by compiled models and native hosts.
use alloc::{string::String, vec::Vec};
use core::cell::Cell;
#[cfg(target_has_atomic = "32")]
use core::sync::atomic::{AtomicU32, Ordering};
#[cfg(not(target_has_atomic = "32"))]
use portable_atomic::{AtomicU32, Ordering};
use crate::NodeId;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskId { pub region: u32, pub function: u32, pub call: u32 }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RequestId { pub task: TaskId, pub wait: u32, pub member: u32 }

// Targets without native CAS use the atomic backend selected by the host.
static NEXT_REGION: AtomicU32 = AtomicU32::new(1);
/// Identity belongs to a mount, rather than the factory's source name.
pub fn next_region() -> u32 {
    let id = NEXT_REGION.fetch_add(1, Ordering::Relaxed);
    assert_ne!(id, 0, "model region identity exhausted");
    id
}

#[derive(Clone, Debug, Default)]
pub struct NodeSlot(alloc::rc::Rc<Cell<Option<NodeId>>>);
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
    /// Service contract module names declared by the host before dispatch.
    pub services: Vec<String>,
    pub deliveries: Vec<Delivery>,
}
impl Ready {
    pub fn delivery(&self, request: RequestId) -> Option<&Completion> {
        self.deliveries.iter().rev().find(|entry| entry.request == request).map(|entry| &entry.result)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    Animate { node: Option<NodeId>, prop: u8, to: f64, dur: u32, easing: u8, delay: u32, request: Option<RequestId> },
    Jump { node: Option<NodeId>, prop: u8, value: f64 },
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

pub fn append_display<T: crate::MicroTsDisplay + ?Sized>(out: &mut String, value: &T) {
    use core::fmt::Write;
    let _ = write!(out, "{}", crate::display(value));
}
pub fn to_string<T: crate::MicroTsDisplay + ?Sized>(value: &T) -> String {
    let mut out = String::new(); append_display(&mut out, value); out
}
pub fn concat<A: crate::MicroTsDisplay + ?Sized, B: crate::MicroTsDisplay + ?Sized>(a: &A, b: &B) -> String {
    let mut out = String::new(); append_display(&mut out, a); append_display(&mut out, b); out
}
pub fn animation_easing(name: &str) -> u8 {
    match name { "linear" => 0, "in" => 1, "out" => 2, "in-out" => 3, "out-back" => 4, "spring" => 5, "spring-bouncy" => 6, _ => panic!("unknown animation easing: {}", name) }
}
pub fn animation_easing_value(value: &Value) -> u8 {
    match value {
        Value::String(name) => animation_easing(name),
        Value::I32(value) if (0..=6).contains(value) => *value as u8,
        Value::Number(value) if (0.0..=6.0).contains(value) && libm::trunc(*value) == *value => *value as u8,
        Value::Unit => 2,
        _ => panic!("invalid animation easing"),
    }
}
pub fn animation_color(text: &str) -> f64 {
    parse_color(text).expect("invalid animation Color") as f64
}
pub fn decode_color(value: &Value) -> Option<u32> { parse_color(value_string(value)?) }
fn parse_color(text: &str) -> Option<u32> {
    let hex = text.strip_prefix('#')?;
    if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.as_bytes().iter().all(u8::is_ascii_hexdigit) { return None; }
    let rgba = if hex.len() <= 4 {
        let mut value = 0u32;
        for byte in hex.bytes() { let digit = (byte as char).to_digit(16)?; value = (value << 8) | digit * 17; }
        if hex.len() == 3 { (value << 8) | 255 } else { value }
    } else {
        let value = u32::from_str_radix(hex, 16).ok()?;
        if hex.len() == 6 { (value << 8) | 255 } else { value }
    };
    Some(rgba.swap_bytes())
}
impl<const N: usize> crate::MicroTsDisplay for heapless::String<N> {
    fn fmt_microts(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { formatter.write_str(self.as_str()) }
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
pub fn append_bounded_display<const N: usize, T: crate::MicroTsDisplay + ?Sized>(out: &mut heapless::String<N>, value: &T, name: &str) {
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
pub fn bounded_concat<const N: usize>(a: &impl crate::MicroTsDisplay, b: &impl crate::MicroTsDisplay, name: &str) -> heapless::String<N> {
    let mut out = heapless::String::new(); append_bounded_display(&mut out, a, name); append_bounded_display(&mut out, b, name); out
}

/// Generated task return values retain their concrete bounded storage.
pub trait TaskValue: Clone + core::fmt::Debug { fn task_value(&self) -> Value; }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskReady { Ready, Cancelled }
#[derive(Clone, Debug)]
pub enum TaskResult<T> { Host(Completion), Typed(T), Joined(Option<T>), Cancelled }
impl<T> TaskResult<T> {
    pub fn host(&self) -> &Completion { match self { Self::Host(value) => value, _ => panic!("expected host completion") } }
}
/// A pre-order wait tree stored inline in each generated task. `end` is the
/// exclusive end of a composite's subtree; leaf numbers remain RequestId members.
#[derive(Clone, Debug)]
pub enum WaitNode<T> {
    Frames { request: RequestId, until: u64 },
    After { request: RequestId, until: f64 },
    Until { request: RequestId, predicate: u32 },
    Delivery { request: RequestId },
    Service { request: RequestId, service: &'static str, validate: fn(&Value) -> bool },
    Join { request: RequestId, target: TaskId, wrapped: bool },
    All { end: usize }, Any { end: usize, winner: Option<usize> },
    Resolved(TaskResult<T>),
}
#[derive(Clone, Debug)]
pub struct Wait<const N: usize, T> { nodes: heapless::Vec<WaitNode<T>, N> }
#[derive(Clone, Debug)]
pub struct TaskOutcome<T> { pub task: TaskId, pub value: Option<T> }

/// Reservations are bounded by the compiler's number of live service leaves.
#[derive(Debug)]
pub struct ServiceRequests<const N: usize> { active: heapless::Vec<(RequestId, &'static str), N> }
impl<const N: usize> Default for ServiceRequests<N> { fn default() -> Self { Self { active: heapless::Vec::new() } } }
impl<const N: usize> ServiceRequests<N> {
    fn release(&mut self, request: RequestId) { self.active.retain(|(id, _)| *id != request); }
    pub fn wait<V: ModelValue, T>(&mut self, available: &[String], service: &'static str, call: &'static str, args: Vec<Value>, request: RequestId, capacity: usize, commands: &crate::CommandQueue) -> WaitNode<T> {
        if !available.iter().any(|name| name == service) { return WaitNode::Resolved(TaskResult::Host(Completion::Value(service_failure("unavailable")))); }
        if self.active.iter().filter(|(_, name)| *name == service).count() >= capacity { return WaitNode::Resolved(TaskResult::Host(Completion::Value(service_failure("busy")))); }
        self.active.push((request, service)).expect("compiler service reservation bound exceeded");
        if trace_enabled() { trace(ModelTrace { kind: "request", request: Some(request), module: service, call, value: Value::Array(args.clone()), ..ModelTrace::default() }); }
        commands.push(Cmd::Request { service: String::from(service), call: String::from(call), args, request });
        WaitNode::Service { request, service, validate: validate_model_value::<V> }
    }
}
fn validate_model_value<T: ModelValue>(value: &Value) -> bool { T::from_model_value(value).is_some() }
fn service_failure(kind: &str) -> Value { Value::Object(alloc::vec![(String::from("kind"), Value::String(String::from(kind)))]) }
fn service_result(service: &str, value: &Value, validate: fn(&Value) -> bool) -> bool {
    if !validate(value) { return false; }
    if service == "@pocketjs/framework/net/model" && value_tag(value, "kind") == Some("ok") {
        let status = match object_field(value, "status") { Some(Value::I32(n)) => *n as f64, Some(Value::Number(n)) => *n, _ => return false };
        return status.is_finite() && libm::trunc(status) == status && (100.0..=599.0).contains(&status);
    }
    true
}
impl<const N: usize, T: TaskValue> Wait<N, T> {
    pub fn new(nodes: impl IntoIterator<Item = WaitNode<T>>) -> Self {
        let mut storage = heapless::Vec::new();
        for node in nodes { storage.push(node).expect("compiler wait tree bound exceeded"); }
        assert!(!storage.is_empty(), "empty wait tree"); Self { nodes: storage }
    }
    fn end(&self, index: usize) -> usize { match self.nodes[index] { WaitNode::All { end } | WaitNode::Any { end, .. } => end, _ => index + 1 } }
    pub fn result(&self, index: usize) -> &TaskResult<T> { match &self.nodes[index] { WaitNode::Resolved(value) => value, _ => panic!("task result was not resolved") } }
    pub fn winner(&self, index: usize) -> usize { match self.nodes[index] { WaitNode::Any { winner: Some(winner), .. } => winner, _ => panic!("any result was not resolved") } }
    pub fn poll<const R: usize>(&mut self, ready: &Ready, predicates: &[(u32, bool)], outcomes: &[TaskOutcome<T>], requests: &mut ServiceRequests<R>, commands: &crate::CommandQueue) -> Option<TaskReady> {
        self.poll_node(0, ready, predicates, outcomes, requests, commands)
    }
    fn poll_node<const R: usize>(&mut self, index: usize, ready: &Ready, predicates: &[(u32, bool)], outcomes: &[TaskOutcome<T>], requests: &mut ServiceRequests<R>, commands: &crate::CommandQueue) -> Option<TaskReady> {
        if let WaitNode::All { end } = self.nodes[index] {
            let mut child = index + 1; let mut complete = true;
            while child < end {
                match self.poll_node(child, ready, predicates, outcomes, requests, commands) { Some(TaskReady::Cancelled) => return Some(TaskReady::Cancelled), None => complete = false, _ => {} }
                child = self.end(child);
            }
            return complete.then_some(TaskReady::Ready);
        }
        if let WaitNode::Any { end, winner } = self.nodes[index] {
            if let Some(winner) = winner { return self.poll_node(winner, ready, predicates, outcomes, requests, commands); }
            let mut child = index + 1; let mut selected = None;
            while child < end {
                let result = self.poll_node(child, ready, predicates, outcomes, requests, commands);
                if selected.is_none() { if let Some(result) = result { selected = Some((child, result)); } }
                child = self.end(child);
            }
            if let Some((winner, result)) = selected {
                self.nodes[index] = WaitNode::Any { end, winner: Some(winner) };
                let mut child = index + 1;
                while child < end { let next = self.end(child); if child != winner { self.cancel_range(child, next, &mut commands.borrow_mut(), requests, false); } child = next; }
                return Some(result);
            }
            return None;
        }
        let value = match &self.nodes[index] {
            WaitNode::Frames { until, .. } if ready.frame >= *until => Some(TaskResult::Host(Completion::Value(Value::Unit))),
            WaitNode::After { until, .. } if ready.now_ms >= *until => Some(TaskResult::Host(Completion::Value(Value::Unit))),
            WaitNode::Until { predicate, .. } if predicates.iter().any(|(id, value)| id == predicate && *value) => Some(TaskResult::Host(Completion::Value(Value::Unit))),
            WaitNode::Delivery { request } => ready.delivery(*request).map(|value| if matches!(value, Completion::Cancelled) { TaskResult::Cancelled } else { TaskResult::Host(value.clone()) }),
            WaitNode::Service { request, service, validate } => ready.delivery(*request).map(|result| {
                requests.release(*request);
                TaskResult::Host(match result { Completion::Value(value) if service_result(service, value, *validate) => result.clone(), _ => Completion::Value(service_failure("malformed")) })
            }),
            WaitNode::Join { target, wrapped, .. } => outcomes.iter().find(|outcome| outcome.task == *target).map(|outcome| {
                if *wrapped { TaskResult::Joined(outcome.value.clone()) } else { match &outcome.value { Some(value) => TaskResult::Typed(value.clone()), None => TaskResult::Cancelled } }
            }),
            WaitNode::Resolved(value) => return Some(if matches!(value, TaskResult::Cancelled) { TaskReady::Cancelled } else { TaskReady::Ready }),
            _ => None,
        };
        value.map(|value| { let ready = if matches!(value, TaskResult::Cancelled) { TaskReady::Cancelled } else { TaskReady::Ready }; self.nodes[index] = WaitNode::Resolved(value); ready })
    }
    pub fn cancel<const R: usize>(&mut self, commands: &mut Vec<Cmd>, requests: &mut ServiceRequests<R>, keep_results: bool) { self.cancel_range(0, self.nodes.len(), commands, requests, keep_results); }
    fn cancel_range<const R: usize>(&mut self, start: usize, end: usize, commands: &mut Vec<Cmd>, requests: &mut ServiceRequests<R>, keep_results: bool) {
        for node in &mut self.nodes[start..end] {
            match node {
                WaitNode::Service { request, service, .. } => {
                    requests.release(*request); commands.push(Cmd::Cancel { request: *request });
                    if trace_enabled() { trace(ModelTrace { kind: "request-cancel", request: Some(*request), module: service, ..ModelTrace::default() }); }
                }
                WaitNode::Delivery { request } => commands.push(Cmd::Cancel { request: *request }),
                WaitNode::All { .. } | WaitNode::Any { .. } => continue,
                WaitNode::Resolved(_) if keep_results => continue,
                _ => {},
            }
            *node = WaitNode::Resolved(TaskResult::Host(Completion::Value(Value::Unit)));
        }
    }
    pub fn references(&self, id: TaskId) -> bool { self.nodes.iter().any(|node| matches!(node, WaitNode::Join { target, .. } if *target == id)) }
    pub fn awaits_bare(&self, id: TaskId) -> bool { self.nodes.iter().any(|node| matches!(node, WaitNode::Join { target, wrapped: false, .. } if *target == id)) }
}
#[derive(Clone, Debug)]
pub struct TaskState<const N: usize, T> {
    pub task: TaskId, pub generation: u32, pub wait_generation: u32,
    pub state: u32, pub order: u64, pub live: bool, pub issued: u64,
    pub wait: Option<Wait<N, T>>,
}
impl<const N: usize, T> Default for TaskState<N, T> { fn default() -> Self { Self { task: TaskId::default(), generation: 0, wait_generation: 0, state: 0, order: 0, live: false, issued: 0, wait: None } } }
impl<const N: usize, T: TaskValue> TaskState<N, T> {
    pub fn start(&mut self, region: u32, function: u32, order: u64) -> TaskId {
        self.generation = self.generation.checked_add(1).expect("model task identity exhausted"); self.task = TaskId { region, function, call: self.generation };
        self.wait_generation = 0; self.state = 0; self.order = order; self.live = true; self.wait = None;
        if trace_enabled() { trace(ModelTrace { kind: "task-start", task: Some(self.task), ..ModelTrace::default() }); } self.task
    }
    pub fn request(&self, member: u32) -> RequestId { RequestId { task: self.task, wait: self.wait_generation, member } }
    pub fn suspend(&mut self, state: u32, frame: u64, wait: Wait<N, T>) { self.state = state; self.issued = frame; self.wait = Some(wait); }
    pub fn cancel<const O: usize, const R: usize>(&mut self, commands: &mut Vec<Cmd>, outcomes: &mut heapless::Vec<TaskOutcome<T>, O>, requests: &mut ServiceRequests<R>, reason: &'static str) {
        if !self.live { return; } if let Some(mut wait) = self.wait.take() { wait.cancel(commands, requests, false); }
        self.live = false; outcomes.push(TaskOutcome { task: self.task, value: None }).expect("compiler task outcome bound exceeded");
        if trace_enabled() { trace(ModelTrace { kind: "task-cancel", task: Some(self.task), reason, ..ModelTrace::default() }); }
    }
    pub fn complete_wait<const R: usize>(&mut self, commands: &mut Vec<Cmd>, requests: &mut ServiceRequests<R>) -> Option<Wait<N, T>> {
        let mut wait = self.wait.take()?; wait.cancel(commands, requests, true); Some(wait)
    }
    pub fn finish<const O: usize>(&mut self, value: T, outcomes: &mut heapless::Vec<TaskOutcome<T>, O>) {
        self.live = false; self.wait = None;
        if trace_enabled() { trace(ModelTrace { kind: "task-complete", task: Some(self.task), value: value.task_value(), ..ModelTrace::default() }); }
        outcomes.push(TaskOutcome { task: self.task, value: Some(value) }).expect("compiler task outcome bound exceeded");
    }
    pub fn poll<const R: usize>(&mut self, ready: &Ready, predicates: &[(u32, bool)], outcomes: &[TaskOutcome<T>], requests: &mut ServiceRequests<R>, commands: &crate::CommandQueue) -> Option<TaskReady> {
        if !self.live || ready.frame <= self.issued { return None; } self.wait.as_mut()?.poll(ready, predicates, outcomes, requests, commands)
    }
    pub fn references(&self, task: TaskId) -> bool { self.live && self.wait.as_ref().is_some_and(|wait| wait.references(task)) }
    pub fn awaits_bare(&self, task: TaskId) -> bool { self.live && self.wait.as_ref().is_some_and(|wait| wait.awaits_bare(task)) }
    pub fn has_cancelled_join(&self, outcomes: &[TaskOutcome<T>]) -> bool { outcomes.iter().any(|outcome| outcome.value.is_none() && self.awaits_bare(outcome.task)) }
    pub fn waits_for_predicate(&self, predicate: u32) -> bool { self.live && self.wait.as_ref().is_some_and(|wait| wait.nodes.iter().any(|node| matches!(node, WaitNode::Until { predicate: id, .. } if *id == predicate))) }
    pub fn trace_delivery(&self, delivery: &Delivery) {
        if !trace_enabled() { return; }
        let node = self.wait.as_ref().filter(|_| self.live).and_then(|wait| wait.nodes.iter().find(|node| match node { WaitNode::Service { request, .. } | WaitNode::Delivery { request } => *request == delivery.request, _ => false }));
        let Some(node) = node else { trace_delivery_drop(delivery); return; };
        let value = match (node, &delivery.result) {
            (WaitNode::Service { service, validate, .. }, Completion::Value(value)) if service_result(service, value, *validate) => value.clone(),
            (WaitNode::Service { .. }, _) => service_failure("malformed"), (_, Completion::Value(value)) => value.clone(),
            (_, Completion::Animation(value)) => value.model_value(), (_, Completion::Cancelled) => Value::Unit,
        };
        trace(ModelTrace { kind: "delivery", request: Some(delivery.request), value, ..ModelTrace::default() });
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
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::I32(v) => Some(*v), Value::Number(v) if v.is_finite() && libm::trunc(*v) == *v && *v >= i32::MIN as f64 && *v <= i32::MAX as f64 => Some(*v as i32), _ => None } }
}
impl ModelValue for f64 {
    fn model_value(&self) -> Value { Value::Number(*self) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::Number(v) => Some(*v), Value::I32(v) => Some(*v as f64), _ => None } }
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
pub fn completion_value(completion: &Completion) -> &Value {
    match completion { Completion::Value(value) => value, _ => panic!("expected task value completion") }
}
pub fn value_element(value: &Value, index: usize) -> &Value {
    match value { Value::Array(values) => values.get(index).expect("missing task tuple element"), _ => panic!("expected task tuple value") }
}

pub fn object_field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value { Value::Object(fields) => fields.iter().find(|(key, _)| key == name).map(|(_, value)| value), _ => None }
}
pub fn decode_field<T: ModelValue>(value: &Value, name: &str) -> Option<T> { T::from_model_value(object_field(value, name)?) }
pub fn value_string(value: &Value) -> Option<&str> { match value { Value::String(value) => Some(value), _ => None } }
pub fn value_tag<'a>(value: &'a Value, name: &str) -> Option<&'a str> { value_string(object_field(value, name)?) }
impl<T: ModelValue> ModelValue for Option<T> {
    fn model_value(&self) -> Value { match self { Some(value) => value.model_value(), None => Value::Unit } }
    fn from_model_value(value: &Value) -> Option<Self> { if matches!(value, Value::Unit) { Some(None) } else { T::from_model_value(value).map(Some) } }
}
macro_rules! integer_model_value {
    ($($type:ty),*) => { $(impl ModelValue for $type {
        fn model_value(&self) -> Value { Value::Number(*self as f64) }
        fn from_model_value(value: &Value) -> Option<Self> { match value {
            Value::Number(v) if v.is_finite() && libm::trunc(*v) == *v && *v >= Self::MIN as f64 && *v <= Self::MAX as f64 => Some(*v as Self),
            Value::I32(v) => Self::try_from(*v).ok(), _ => None,
        } }
    })* };
}
integer_model_value!(i8, i16, i64, u8, u16, u32, u64, usize);
impl ModelValue for f32 {
    fn model_value(&self) -> Value { Value::Number(*self as f64) }
    fn from_model_value(value: &Value) -> Option<Self> { match value { Value::Number(value) => Some(*value as f32), Value::I32(value) => Some(*value as f32), _ => None } }
}
impl<T: ModelValue, const N: usize> ModelValue for heapless::Vec<T, N> {
    fn model_value(&self) -> Value { Value::Array(self.iter().map(ModelValue::model_value).collect()) }
    fn from_model_value(value: &Value) -> Option<Self> {
        let Value::Array(items) = value else { return None; }; if items.len() > N { return None; }
        let mut result = Self::new(); for item in items { result.push(T::from_model_value(item)?).ok()?; } Some(result)
    }
}
impl<const N: usize> ModelValue for heapless::String<N> {
    fn model_value(&self) -> Value { Value::String(String::from(self.as_str())) }
    fn from_model_value(value: &Value) -> Option<Self> { Self::try_from(value_string(value)?).ok() }
}
macro_rules! tuple_model_value {
    ($length:expr; $($type:ident:$index:tt),+) => {
        impl<$($type: ModelValue),+> ModelValue for ($($type,)+) {
            fn model_value(&self) -> Value { Value::Array(alloc::vec![$(self.$index.model_value()),+]) }
            fn from_model_value(value: &Value) -> Option<Self> { match value {
                Value::Array(values) if values.len() == $length => Some(($($type::from_model_value(&values[$index])?,)+)),
                _ => None,
            } }
        }
    };
}
tuple_model_value!(1; A:0);
tuple_model_value!(2; A:0, B:1);
tuple_model_value!(3; A:0, B:1, C:2);
tuple_model_value!(4; A:0, B:1, C:2, D:3);
tuple_model_value!(5; A:0, B:1, C:2, D:3, E:4);
tuple_model_value!(6; A:0, B:1, C:2, D:3, E:4, F:5);
tuple_model_value!(7; A:0, B:1, C:2, D:3, E:4, F:5, G:6);
tuple_model_value!(8; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7);
tuple_model_value!(9; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8);
tuple_model_value!(10; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9);
tuple_model_value!(11; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9, K:10);
tuple_model_value!(12; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9, K:10, L:11);
#[derive(Clone, Debug, Default)]
pub struct ModelTrace {
    pub kind: &'static str, pub region: u32, pub id: u32, pub name: &'static str,
    pub mode: &'static str, pub value: Value, pub changed: bool, pub version: u32,
    pub initial: bool,
    pub task: Option<TaskId>, pub request: Option<RequestId>, pub state: u32,
    pub reason: &'static str, pub awaitable: &'static str,
    pub module: &'static str, pub call: &'static str,
}
pub fn trace_wait(request: RequestId, awaitable: &'static str) -> RequestId {
    if trace_enabled() { trace(ModelTrace { kind: "wait", request: Some(request), awaitable, ..ModelTrace::default() }); }
    request
}
pub fn trace_task_resume(task: TaskId, state: u32) {
    if trace_enabled() { trace(ModelTrace { kind: "task-resume", task: Some(task), state, ..ModelTrace::default() }); }
}
pub fn trace_delivery_drop(delivery: &Delivery) {
    if trace_enabled() { trace(ModelTrace { kind: "delivery-drop", request: Some(delivery.request), ..ModelTrace::default() }); }
}
pub const fn trace_enabled() -> bool { cfg!(feature = "model-trace") }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModelWorkCounts {
    pub scheduled_memos: u64,
    pub demand_memos: u64,
    pub effects: u64,
    pub task_segments: u64,
    pub loop_iterations: u64,
}
#[derive(Clone, Copy)]
pub enum ModelWork { ScheduledMemo, DemandMemo, Effect, TaskSegment, LoopIteration }
#[cfg(feature = "model-trace")]
extern crate std;
#[cfg(feature = "model-trace")]
std::thread_local! { static TRACE: core::cell::RefCell<Vec<ModelTrace>> = const { core::cell::RefCell::new(Vec::new()) }; }
#[cfg(feature = "model-trace")]
std::thread_local! { static WORK: Cell<ModelWorkCounts> = const { Cell::new(ModelWorkCounts { scheduled_memos: 0, demand_memos: 0, effects: 0, task_segments: 0, loop_iterations: 0 }) }; }
#[inline]
pub fn count_work(kind: ModelWork) {
    #[cfg(feature = "model-trace")]
    WORK.with(|cell| {
        let mut counts = cell.get();
        let counter = match kind { ModelWork::ScheduledMemo => &mut counts.scheduled_memos, ModelWork::DemandMemo => &mut counts.demand_memos, ModelWork::Effect => &mut counts.effects, ModelWork::TaskSegment => &mut counts.task_segments, ModelWork::LoopIteration => &mut counts.loop_iterations };
        *counter += 1; cell.set(counts);
    });
    #[cfg(not(feature = "model-trace"))]
    let _ = kind;
}
pub fn take_counts() -> ModelWorkCounts {
    #[cfg(feature = "model-trace")]
    { return WORK.with(|cell| cell.replace(ModelWorkCounts::default())); }
    #[cfg(not(feature = "model-trace"))]
    ModelWorkCounts::default()
}
pub fn reset_counts() { let _ = take_counts(); }
pub fn trace(event: ModelTrace) {
    #[cfg(feature = "model-trace")]
    TRACE.with(|trace| trace.borrow_mut().push(event));
    #[cfg(not(feature = "model-trace"))]
    let _ = event;
}
pub fn take_trace() -> Vec<ModelTrace> {
    #[cfg(feature = "model-trace")]
    { return TRACE.with(|trace| core::mem::take(&mut *trace.borrow_mut())); }
    #[cfg(not(feature = "model-trace"))]
    Vec::new()
}
#[cfg(feature = "model-trace")]
pub fn reset_trace() { TRACE.with(|trace| trace.borrow_mut().clear()); reset_counts(); NEXT_REGION.store(1, Ordering::Relaxed); }
