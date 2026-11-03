use crate::{NodeId, Ui};
use alloc::{
    collections::BTreeMap,
    rc::{Rc, Weak},
    vec::Vec,
};
use core::cell::RefCell;

/// A marker-free contiguous range of nodes owned by generated code.
pub trait Block {
    fn first_node(&self) -> NodeId;
    fn move_before(&mut self, ui: &mut Ui, parent: NodeId, anchor: NodeId);
    fn unmount(self, ui: &mut Ui)
    where
        Self: Sized;
}

/// The child controls slot lifetime; the parent evaluates slot bindings.
pub trait SlotBlock {
    fn mount(&mut self, ui: &mut Ui, parent: NodeId, anchor: NodeId);
    fn unmount(&mut self, ui: &mut Ui);
    fn first_node(&self) -> NodeId;
    fn move_before(&mut self, ui: &mut Ui, parent: NodeId, anchor: NodeId);
    fn pending(&self, _input: &crate::Input) -> bool {
        false
    }
    fn pending_after(&self, input: &crate::Input, skip: usize) -> bool {
        skip == 0 && self.pending(input)
    }
    fn sample_idle(&mut self, _input: &crate::Input) {}
    fn handler_count(&self) -> usize {
        0
    }
    fn refresh_slot_placement(&mut self, _ui: &mut Ui, _parent: NodeId, _anchor: NodeId) {}
}

/// A child controls slot placement through this handle. The parent retains its
/// typed `Rc<RefCell<S>>` and updates the slot with the parent's borrowed props
/// and view model; the handle stores no application context.
#[derive(Clone)]
pub struct SlotHandle(SlotHandleKind);

#[derive(Clone)]
enum SlotHandleKind {
    Instance(Rc<RefCell<dyn SlotBlock>>),
    Factory(Rc<dyn Fn() -> SlotHandle>),
}

impl SlotHandle {
    pub fn new<S: SlotBlock + 'static>(slot: Rc<RefCell<S>>) -> Self {
        Self(SlotHandleKind::Instance(slot))
    }
    pub fn instantiate(&self) -> Self {
        match &self.0 {
            SlotHandleKind::Instance(_) => self.clone(),
            SlotHandleKind::Factory(factory) => factory(),
        }
    }
    fn instance(&self) -> &Rc<RefCell<dyn SlotBlock>> {
        match &self.0 {
            SlotHandleKind::Instance(slot) => slot,
            SlotHandleKind::Factory(_) => panic!("instantiate a slot factory before using it"),
        }
    }
    pub fn instance_id(&self) -> usize {
        Rc::as_ptr(self.instance()) as *const () as usize
    }
    pub fn mount(&self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        self.instance().borrow_mut().mount(ui, parent, anchor);
    }
    pub fn unmount(&self, ui: &mut Ui) {
        self.instance().borrow_mut().unmount(ui);
    }
    pub fn first_node(&self) -> NodeId {
        self.instance().borrow().first_node()
    }
    pub fn move_before(&self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        self.instance().borrow_mut().move_before(ui, parent, anchor);
    }
    pub fn pending(&self, input: &crate::Input) -> bool {
        self.instance().borrow().pending(input)
    }
    pub fn pending_after(&self, input: &crate::Input, skip: usize) -> bool {
        self.instance().borrow().pending_after(input, skip)
    }
    pub fn sample_idle(&self, input: &crate::Input) {
        self.instance().borrow_mut().sample_idle(input);
    }
    pub fn handler_count(&self) -> usize {
        self.instance().borrow().handler_count()
    }
    pub fn refresh_slot_placement(&self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        self.instance()
            .borrow_mut()
            .refresh_slot_placement(ui, parent, anchor);
    }
}

/// Every outlet receives a separate block, while the parent can update and
/// dispatch its live instances with the parent's current borrowed context.
pub struct SlotRegistry<S> {
    instances: Rc<RefCell<Vec<Weak<RefCell<S>>>>>,
    handle: SlotHandle,
}
impl<S: SlotBlock + 'static> SlotRegistry<S> {
    pub fn new(factory: impl Fn() -> S + 'static) -> Self {
        let instances = Rc::new(RefCell::new(Vec::new()));
        let registered = instances.clone();
        let handle = SlotHandle(SlotHandleKind::Factory(Rc::new(move || {
            let instance = Rc::new(RefCell::new(factory()));
            registered.borrow_mut().push(Rc::downgrade(&instance));
            SlotHandle::new(instance)
        })));
        Self { instances, handle }
    }
    pub fn handle(&self) -> SlotHandle {
        self.handle.clone()
    }
    pub fn for_each(&self, mut callback: impl FnMut(&S)) {
        let count = self.instances.borrow().len();
        for index in 0..count {
            let instance = self.instances.borrow().get(index).and_then(Weak::upgrade);
            if let Some(instance) = instance {
                callback(&instance.borrow());
            }
        }
    }
    pub fn for_each_mut(&mut self, mut callback: impl FnMut(&mut S)) {
        self.instances
            .borrow_mut()
            .retain(|instance| instance.strong_count() > 0);
        let count = self.instances.borrow().len();
        for index in 0..count {
            let instance = self.instances.borrow().get(index).and_then(Weak::upgrade);
            if let Some(instance) = instance {
                callback(&mut instance.borrow_mut());
            }
        }
    }
    pub fn with_instance<R>(&self, id: usize, callback: impl FnOnce(&mut S) -> R) -> Option<R> {
        let instance = self
            .instances
            .borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .find(|instance| Rc::as_ptr(instance) as usize == id);
        instance.map(|instance| callback(&mut instance.borrow_mut()))
    }
}

impl Block for NodeId {
    fn first_node(&self) -> NodeId {
        *self
    }
    fn move_before(&mut self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        ui.insert_before(parent, *self, anchor);
    }
    fn unmount(self, ui: &mut Ui) {
        ui.destroy_node(self);
    }
}

pub struct KeyedRow<K, B> {
    pub key: K,
    pub block: B,
}

pub struct KeyedList<K, B> {
    pub rows: Vec<KeyedRow<K, B>>,
}

impl<K, B> Default for KeyedList<K, B> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K, B> KeyedList<K, B> {
    pub const fn new() -> Self {
        Self { rows: Vec::new() }
    }
}

impl<K: Eq + Ord + Clone, B: Block> KeyedList<K, B> {
    /// The unchanged key path compares keys by reference; the owned-key callback
    /// runs only when the sequence changed, so string keys allocate no fast-path buffers.
    pub fn reconcile<T>(
        &mut self,
        ui: &mut Ui,
        parent: NodeId,
        anchor: NodeId,
        items: &[T],
        same_key: impl Fn(&K, &T, i32) -> bool,
        key: impl Fn(&T, i32) -> K,
        mut mount: impl FnMut(&mut Ui, NodeId, NodeId, &T, i32) -> B,
        mut update: impl FnMut(&mut B, &mut Ui, &T, i32, NodeId),
    ) {
        if self.rows.len() == items.len()
            && self
                .rows
                .iter()
                .zip(items)
                .enumerate()
                .all(|(i, (row, item))| same_key(&row.key, item, i as i32))
        {
            let mut next = anchor;
            for (i, (row, item)) in self.rows.iter_mut().zip(items).enumerate().rev() {
                update(&mut row.block, ui, item, i as i32, next);
                let first = row.block.first_node();
                if first != NodeId::NONE {
                    next = first;
                }
            }
            return;
        }
        let mut by_key = BTreeMap::new();
        let mut old: Vec<_> = core::mem::take(&mut self.rows)
            .into_iter()
            .map(Some)
            .collect();
        for (index, row) in old.iter().enumerate() {
            if let Some(row) = row {
                by_key.entry(row.key.clone()).or_insert(index);
            }
        }
        let mut rows = Vec::with_capacity(items.len());
        let mut seen = BTreeMap::new();
        // Mount in source order, then update/move roots from the end so every
        // insertion's anchor is an existing node, including empty blocks.
        for (index, item) in items.iter().enumerate() {
            let owned = key(item, index as i32);
            let duplicate = seen.insert(owned.clone(), ()).is_some();
            debug_assert!(!duplicate, "duplicate v-for key");
            let reused = if duplicate {
                None
            } else {
                by_key.remove(&owned).and_then(|index| old[index].take())
            };
            let row = reused.unwrap_or_else(|| KeyedRow {
                key: owned,
                block: mount(ui, parent, anchor, item, index as i32),
            });
            rows.push(row);
        }
        for row in old.into_iter().flatten() {
            row.block.unmount(ui);
        }
        let mut next = anchor;
        for (index, row) in rows.iter_mut().enumerate().rev() {
            update(&mut row.block, ui, &items[index], index as i32, next);
            row.block.move_before(ui, parent, next);
            let first = row.block.first_node();
            if first != NodeId::NONE {
                next = first;
            }
        }
        self.rows = rows;
    }
}

impl<K, B: Block> Block for KeyedList<K, B> {
    fn first_node(&self) -> NodeId {
        self.rows
            .iter()
            .map(|row| row.block.first_node())
            .find(|id| *id != NodeId::NONE)
            .unwrap_or(NodeId::NONE)
    }
    fn move_before(&mut self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        for row in &mut self.rows {
            row.block.move_before(ui, parent, anchor);
        }
    }
    fn unmount(self, ui: &mut Ui) {
        for row in self.rows {
            row.block.unmount(ui);
        }
    }
}
