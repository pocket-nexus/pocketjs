//! The classic d-pad focus model, native. Document order is a compile-time
//! key: the compiler numbers every focusable element in template pre-order,
//! so conditional blocks register and unregister without a tree walk.

use alloc::vec::Vec;

use crate::NodeId;

#[derive(Clone, Copy, Debug)]
struct Entry {
    node: NodeId,
    order: u32,
    handler: Option<u16>,
}

pub enum Move {
    Clear,
    Stay,
    To(NodeId),
}

pub struct Focus {
    list: Vec<Entry>,
    focused: NodeId,
    pressed: NodeId,
}

impl Focus {
    pub fn new() -> Self {
        Focus {
            list: Vec::new(),
            focused: NodeId::NONE,
            pressed: NodeId::NONE,
        }
    }

    pub fn focused(&self) -> NodeId {
        self.focused
    }

    pub fn pressed(&self) -> NodeId {
        self.pressed
    }

    pub fn set_focused(&mut self, node: NodeId) {
        self.focused = node;
    }

    pub fn set_pressed(&mut self, node: NodeId) {
        self.pressed = node;
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn register(&mut self, node: NodeId, order: u32, handler: Option<u16>) {
        if let Some(existing) = self.list.iter_mut().find(|e| e.node == node) {
            existing.order = order;
            existing.handler = handler;
            self.list.sort_by_key(|e| e.order);
            return;
        }
        let at = self.list.partition_point(|e| e.order <= order);
        self.list.insert(
            at,
            Entry {
                node,
                order,
                handler,
            },
        );
    }

    /// Remove `node`. When it was focused, returns the node focus should move
    /// to (next in order, else previous, else `NONE`).
    pub fn unregister(&mut self, node: NodeId) -> Option<NodeId> {
        let Some(index) = self.list.iter().position(|e| e.node == node) else {
            return None;
        };
        self.list.remove(index);
        if self.pressed == node {
            self.pressed = NodeId::NONE;
        }
        if self.focused != node {
            return None;
        }
        Some(
            self.list
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| self.list.get(i)))
                .map_or(NodeId::NONE, |e| e.node),
        )
    }

    pub fn handler_of(&self, node: NodeId) -> Option<u16> {
        self.list
            .iter()
            .find(|e| e.node == node)
            .and_then(|e| e.handler)
    }

    /// framework/src/input.ts `moveLinearFocus`: nothing focused enters from
    /// the direction's end; otherwise step and clamp at the ends.
    pub fn linear_target(&self, dir: i32) -> Move {
        if self.list.is_empty() {
            return Move::Clear;
        }
        let current = self.list.iter().position(|e| e.node == self.focused);
        match current {
            None => Move::To(if dir > 0 {
                self.list[0].node
            } else {
                self.list[self.list.len() - 1].node
            }),
            Some(i) => {
                let j = i as i32 + dir;
                if j < 0 || j as usize >= self.list.len() {
                    Move::Stay
                } else {
                    Move::To(self.list[j as usize].node)
                }
            }
        }
    }
}

impl Default for Focus {
    fn default() -> Self {
        Self::new()
    }
}
