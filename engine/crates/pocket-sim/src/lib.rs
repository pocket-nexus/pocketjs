//! Simulation history, independent of rendering, transport and a guest heap.
//! A reducer must depend only on its state, input and immutable configuration.
//! Deliver network data before predicting a turn. Emit external effects outside
//! the reducer; reconciliation calls the same reducer without repeating IO.
#![no_std]
extern crate alloc;
use alloc::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Full,
    Future,
    Stale,
    Gap,
    Exhausted,
}

#[derive(Clone, Debug)]
pub struct Turn<S, I> {
    pub tick: u64,
    pub input: I,
    pub state: S,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reconciliation {
    pub corrected: bool,
    pub replayed: usize,
}

/// N is both the storage ceiling and the maximum work in one reconciliation.
/// Full history refuses prediction without changing state. The caller can wait
/// for an acknowledgement or start a new session from a full snapshot.
pub struct Predictor<S, I, const N: usize> {
    state: S,
    confirmed: u64,
    tick: u64,
    turns: VecDeque<Turn<S, I>>,
}
impl<S: Clone + PartialEq, I: Clone, const N: usize> Predictor<S, I, N> {
    pub fn new(tick: u64, state: S) -> Self {
        assert!(N > 0);
        Self {
            state,
            confirmed: tick,
            tick,
            turns: VecDeque::with_capacity(N),
        }
    }
    pub fn state(&self) -> &S {
        &self.state
    }
    pub fn tick(&self) -> u64 {
        self.tick
    }
    pub fn confirmed(&self) -> u64 {
        self.confirmed
    }
    pub fn pending(&self) -> impl ExactSizeIterator<Item = &Turn<S, I>> {
        self.turns.iter()
    }
    pub fn predict(&mut self, input: I, step: impl FnOnce(&mut S, &I)) -> Result<u64, Error> {
        if self.turns.len() == N {
            return Err(Error::Full);
        }
        let tick = self.tick.checked_add(1).ok_or(Error::Exhausted)?;
        step(&mut self.state, &input);
        self.tick = tick;
        self.turns.push_back(Turn {
            tick,
            input,
            state: self.state.clone(),
        });
        Ok(tick)
    }
    /// `state` is the authority's state after consuming input `tick`.
    /// Equality avoids resampling already-correct history. All rejection paths
    /// leave the current prediction and the confirmation cursor unchanged.
    pub fn reconcile(
        &mut self,
        tick: u64,
        state: S,
        step: impl Fn(&mut S, &I),
    ) -> Result<Reconciliation, Error> {
        if tick <= self.confirmed {
            return Err(Error::Stale);
        }
        if tick > self.tick {
            return Err(Error::Future);
        }
        let index = self
            .turns
            .iter()
            .position(|t| t.tick == tick)
            .ok_or(Error::Stale)?;
        let corrected = self.turns[index].state != state;
        self.turns.drain(..=index);
        self.confirmed = tick;
        let mut replayed = 0;
        if corrected {
            self.state = state;
            for turn in &mut self.turns {
                step(&mut self.state, &turn.input);
                turn.state = self.state.clone();
                replayed += 1;
            }
        }
        Ok(Reconciliation {
            corrected,
            replayed,
        })
    }
}

/// In-order commands from one authenticated session. Retransmissions cannot
/// repeat edge actions. Gaps and overload require retry or a new session.
pub struct CommandQueue<I, const N: usize> {
    accepted: u64,
    queue: VecDeque<(u64, I)>,
}
impl<I, const N: usize> CommandQueue<I, N> {
    pub fn new(tick: u64) -> Self {
        assert!(N > 0);
        Self {
            accepted: tick,
            queue: VecDeque::with_capacity(N),
        }
    }
    pub fn push(&mut self, tick: u64, input: I) -> Result<bool, Error> {
        if tick <= self.accepted {
            return Ok(false);
        }
        if tick != self.accepted.checked_add(1).ok_or(Error::Exhausted)? {
            return Err(Error::Gap);
        }
        if self.queue.len() == N {
            return Err(Error::Full);
        }
        self.accepted = tick;
        self.queue.push_back((tick, input));
        Ok(true)
    }
    pub fn pop(&mut self) -> Option<(u64, I)> {
        self.queue.pop_front()
    }
    pub fn len(&self) -> usize {
        self.queue.len()
    }
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

pub struct Sample<'a, S> {
    pub from: &'a S,
    pub to: &'a S,
    pub alpha: f32,
}
/// Remote presentation history. Never predicts beyond the newest snapshot.
/// The owner supplies a delayed server clock; sampling never changes simulation.
pub struct Timeline<S, const N: usize> {
    snapshots: VecDeque<(u64, S)>,
}
impl<S, const N: usize> Default for Timeline<S, N> {
    fn default() -> Self {
        Self::new()
    }
}
impl<S, const N: usize> Timeline<S, N> {
    pub fn new() -> Self {
        assert!(N >= 2);
        Self {
            snapshots: VecDeque::with_capacity(N),
        }
    }
    pub fn push(&mut self, tick: u64, state: S) -> bool {
        if self.snapshots.back().is_some_and(|s| s.0 >= tick) {
            return false;
        }
        if self.snapshots.len() == N {
            self.snapshots.pop_front();
        }
        self.snapshots.push_back((tick, state));
        true
    }
    pub fn latest_tick(&self) -> Option<u64> {
        self.snapshots.back().map(|s| s.0)
    }
    pub fn sample(&self, tick: f64) -> Option<Sample<'_, S>> {
        if !tick.is_finite() {
            return None;
        }
        let mut previous = self.snapshots.front()?;
        for next in &self.snapshots {
            if next.0 as f64 >= tick {
                let span = (next.0 - previous.0) as f64;
                let alpha = if span > 0.0 {
                    ((tick - previous.0 as f64) / span).clamp(0.0, 1.0) as f32
                } else {
                    0.0
                };
                return Some(Sample {
                    from: &previous.1,
                    to: &next.1,
                    alpha,
                });
            }
            previous = next;
        }
        Some(Sample {
            from: &previous.1,
            to: &previous.1,
            alpha: 0.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Debug, PartialEq)]
    struct Body {
        x: i32,
        velocity: i32,
        edges: u32,
    }
    fn reducer(s: &mut Body, i: &(i32, bool)) {
        s.velocity = (s.velocity + i.0).clamp(-4, 4);
        s.x = (s.x + s.velocity).clamp(-40, 40);
        s.edges += u32::from(i.1);
    }
    #[test]
    fn correction_replays_only_unconfirmed_simulation_for_distinct_states() {
        for start in [-32, 11] {
            let initial = Body {
                x: start,
                velocity: 0,
                edges: 0,
            };
            let mut p = Predictor::<_, _, 16>::new(0, initial.clone());
            let inputs: alloc::vec::Vec<_> = (0..10)
                .map(|i| (if i < 4 { 1 } else { -1 }, i == 6))
                .collect();
            for i in &inputs {
                p.predict(*i, reducer).unwrap();
            }
            let mut authority = initial;
            for i in &inputs[..4] {
                reducer(&mut authority, i);
            }
            authority.x -= 2; // e.g. an authoritative collision response
            let mut expected = authority.clone();
            for i in &inputs[4..] {
                reducer(&mut expected, i);
            }
            assert_eq!(
                p.reconcile(4, authority, reducer),
                Ok(Reconciliation {
                    corrected: true,
                    replayed: 6
                })
            );
            assert_eq!(p.state(), &expected);
            assert_eq!(p.state().edges, 1);
            assert_eq!(p.pending().len(), 6);
        }
    }
    #[test]
    fn matching_ack_does_no_work_and_invalid_ack_is_atomic() {
        let mut p = Predictor::<_, _, 2>::new(7, 0);
        p.predict(2, |s, i| *s += i).unwrap();
        p.predict(3, |s, i| *s += i).unwrap();
        assert_eq!(p.predict(1, |_, _| panic!()), Err(Error::Full));
        assert_eq!(p.reconcile(10, 99, |_, _| panic!()), Err(Error::Future));
        assert_eq!(
            p.reconcile(8, 2, |_, _| panic!()),
            Ok(Reconciliation::default())
        );
        assert_eq!(p.reconcile(8, 99, |_, _| panic!()), Err(Error::Stale));
        assert_eq!(*p.state(), 5);
        p.predict(4, |s, i| *s += i).unwrap();
        assert_eq!(p.reconcile(10, 42, |_, _| panic!()).unwrap().replayed, 0);
        assert_eq!(*p.state(), 42);
        assert_eq!(p.pending().len(), 0);
    }
    #[test]
    fn delayed_lossy_ack_stream_matches_authority_and_bounds_history() {
        let mut p = Predictor::<_, _, 32>::new(0, 0i64);
        let mut authority = 0;
        for tick in 1..=4000 {
            let input = tick % 9 - 4;
            p.predict(input, |s, i| *s += i).unwrap();
            authority += input;
            if tick % 13 == 0 {
                p.reconcile(tick as u64, authority, |_, _| panic!())
                    .unwrap();
            }
            assert_eq!(*p.state(), authority);
            assert!(p.pending().len() < 14);
        }
    }
    #[test]
    fn ordered_commands_do_not_repeat_edges_or_accept_gaps() {
        let mut q = CommandQueue::<_, 2>::new(0);
        assert_eq!(q.push(2, true), Err(Error::Gap));
        assert_eq!(q.push(1, true), Ok(true));
        assert_eq!(q.push(1, true), Ok(false));
        assert_eq!(q.push(2, false), Ok(true));
        assert_eq!(q.push(3, true), Err(Error::Full));
        assert_eq!(q.pop(), Some((1, true)));
        assert_eq!(q.push(3, true), Ok(true));
    }
    #[test]
    fn timeline_brackets_jitter_and_holds_at_loss() {
        let mut t = Timeline::<_, 3>::new();
        assert!(t.sample(0.0).is_none());
        for n in [10, 12, 18, 20] {
            assert!(t.push(n, n * 10));
        }
        assert!(!t.push(18, 999));
        let s = t.sample(15.0).unwrap();
        assert_eq!((*s.from, *s.to, s.alpha), (120, 180, 0.5));
        assert_eq!(*t.sample(999.0).unwrap().to, 200);
        assert_eq!(*t.sample(0.0).unwrap().from, 120);
        assert!(t.sample(f64::NAN).is_none());
    }
}
