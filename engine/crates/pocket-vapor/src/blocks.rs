use crate::{NodeId, Ui};
use alloc::{collections::BTreeMap, rc::Rc, vec::Vec};
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
}

/// A child controls slot placement through this handle. The parent retains its
/// typed `Rc<RefCell<S>>` and updates the slot with the parent's borrowed props
/// and view model; the handle stores no application context.
#[derive(Clone)]
pub struct SlotHandle(Rc<RefCell<dyn SlotBlock>>);

impl SlotHandle {
    pub fn new<S: SlotBlock + 'static>(slot: Rc<RefCell<S>>) -> Self {
        Self(slot)
    }
    pub fn mount(&self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        self.0.borrow_mut().mount(ui, parent, anchor);
    }
    pub fn unmount(&self, ui: &mut Ui) {
        self.0.borrow_mut().unmount(ui);
    }
    pub fn first_node(&self) -> NodeId {
        self.0.borrow().first_node()
    }
    pub fn move_before(&self, ui: &mut Ui, parent: NodeId, anchor: NodeId) {
        self.0.borrow_mut().move_before(ui, parent, anchor);
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
