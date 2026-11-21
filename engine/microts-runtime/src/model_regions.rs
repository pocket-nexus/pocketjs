//! Region callbacks retain creation order while views own the model instances.
use alloc::{boxed::Box, rc::Rc, vec::Vec};
use core::cell::{RefCell, RefMut};
use crate::{Cmd, Ready};

pub trait New<Args> { fn new(args: Args) -> Self; }

#[derive(Clone, Default)]
pub struct CommandQueue(Rc<RefCell<Vec<Cmd>>>);
impl CommandQueue {
    pub fn push(&self, command: Cmd) { self.0.borrow_mut().push(command); }
    pub fn borrow_mut(&self) -> RefMut<'_, Vec<Cmd>> { self.0.borrow_mut() }
    pub fn is_empty(&self) -> bool { self.0.borrow().is_empty() }
    pub fn drain_to(&self, output: &mut Vec<Cmd>) { output.append(&mut self.0.borrow_mut()); }
    pub fn extend(&self, commands: Vec<Cmd>) { self.0.borrow_mut().extend(commands); }
}
#[derive(Clone, Copy)]
pub enum ModelPhase { Prepare, Resume, React, Settle, Dispose }
type Callback = Box<dyn FnMut(ModelPhase, &Ready, &mut Vec<Cmd>) -> bool>;
#[derive(Clone, Default)]
pub struct ModelRegions {
    entries: Rc<RefCell<Vec<(usize, Callback)>>>,
    ready: Rc<RefCell<Ready>>,
    pub commands: CommandQueue,
}
impl ModelRegions {
    pub fn register(&self, sequence: usize, callback: Callback) {
        let mut entries = self.entries.borrow_mut();
        entries.push((sequence, callback));
        entries.sort_by_key(|entry| entry.0);
    }
    pub fn run(&self, phase: ModelPhase, ready: &Ready, commands: &mut Vec<Cmd>) -> bool {
        if matches!(phase, ModelPhase::Prepare) { self.ready.borrow_mut().clone_from(ready); }
        let mut changed = false;
        for (_, callback) in self.entries.borrow_mut().iter_mut() { changed |= callback(phase, ready, commands); }
        changed
    }
    pub fn ready(&self) -> Ready { self.ready.borrow().clone() }
    pub fn remove(&self, sequence: usize) {
        let mut entries = self.entries.borrow_mut();
        if let Some(index) = entries.iter().position(|entry| entry.0 == sequence) {
            let (_, mut callback) = entries.remove(index);
            let mut commands = Vec::new();
            callback(ModelPhase::Dispose, &Ready::default(), &mut commands);
            self.commands.extend(commands);
        }
    }
}
