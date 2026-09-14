use alloc::{
    collections::{BTreeMap, BTreeSet},
    string::String,
};
use pocketjs_core::{
    Ui as CoreUi,
    spec::{Display, btn},
};

#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub i32);

impl NodeId {
    pub const NONE: Self = Self(0);
    pub const ROOT: Self = Self(pocketjs_core::spec::ROOT_ID);
    pub const fn is_none(self) -> bool {
        self.0 == 0
    }
}

#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StyleId(pub i32);

impl StyleId {
    pub const NONE: Self = Self(pocketjs_core::spec::STYLE_ID_NONE);
}

impl Default for StyleId {
    fn default() -> Self {
        Self::NONE
    }
}

/// A hardware-neutral button sample. `target` is a resolved press node.
#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub buttons: u32,
    pub pressed: u32,
    pub released: u32,
    pub target: NodeId,
}

impl Input {
    pub fn buttons(buttons: u32) -> Self {
        Self {
            buttons,
            ..Self::default()
        }
    }
    pub fn press(target: NodeId) -> Self {
        Self {
            target,
            buttons: btn::CIRCLE,
            pressed: btn::CIRCLE,
            ..Self::default()
        }
    }
    pub fn is_press(&self, node: NodeId) -> bool {
        node != NodeId::NONE && self.target == node
    }
}

/// Typed direct calls into `pocketjs_core::Ui`; no op stream or mirror tree.
pub struct Ui {
    core: CoreUi,
    focusable: BTreeSet<NodeId>,
    images: BTreeMap<String, i32>,
    debug_names: BTreeMap<NodeId, String>,
    previous_buttons: u32,
    active: NodeId,
}

impl Default for Ui {
    fn default() -> Self {
        Self::new()
    }
}

impl Ui {
    pub fn new() -> Self {
        Self::from_core(CoreUi::new())
    }
    pub fn from_core(core: CoreUi) -> Self {
        Self {
            core,
            focusable: BTreeSet::new(),
            images: BTreeMap::new(),
            debug_names: BTreeMap::new(),
            previous_buttons: 0,
            active: NodeId::NONE,
        }
    }
    pub fn core(&self) -> &CoreUi {
        &self.core
    }
    pub fn core_mut(&mut self) -> &mut CoreUi {
        &mut self.core
    }
    pub fn into_core(self) -> CoreUi {
        self.core
    }
    pub fn create_node(&mut self, kind: u8) -> NodeId {
        NodeId(self.core.create_node(kind))
    }
    pub fn insert_before(&mut self, parent: NodeId, child: NodeId, anchor: NodeId) {
        self.core.insert_before(parent.0, child.0, anchor.0);
    }
    pub fn remove_child(&mut self, parent: NodeId, child: NodeId) {
        if self.core.node_parent(child.0) == parent.0 {
            self.repair_focus(child);
        }
        self.core.remove_child(parent.0, child.0);
    }
    pub fn destroy_node(&mut self, node: NodeId) {
        if node == NodeId::ROOT || node.0 == self.core.auxiliary_surface_root() {
            return;
        }
        self.repair_focus(node);
        self.core.destroy_node(node.0);
        self.focusable.retain(|id| self.core.node_exists(id.0));
        self.debug_names.retain(|id, _| self.core.node_exists(id.0));
        if !self.core.node_exists(self.active.0) {
            self.active = NodeId::NONE;
        }
    }
    pub fn set_style(&mut self, node: NodeId, style: StyleId) {
        self.core.set_style(node.0, style.0);
    }
    pub fn set_prop(&mut self, node: NodeId, prop: u8, value: f64) {
        self.core.set_prop(node.0, prop, value);
    }
    pub fn set_text(&mut self, node: NodeId, text: &str) {
        self.core.set_text(node.0, text);
    }
    pub fn set_focus(&mut self, node: NodeId) {
        if self.active != node {
            self.core.set_active(self.active.0, false);
            self.active = NodeId::NONE;
        }
        self.core.set_focus(node.0);
    }
    pub fn focused(&self) -> NodeId {
        NodeId(self.core.focused())
    }
    pub fn set_focusable(&mut self, node: NodeId, enabled: bool) {
        if enabled && self.core.node_exists(node.0) {
            self.focusable.insert(node);
        } else {
            self.focusable.remove(&node);
        }
        if !enabled && self.focused() == node {
            self.set_focus(NodeId::NONE);
        }
    }
    pub fn set_debug_name(&mut self, node: NodeId, name: &str) {
        self.debug_names.insert(node, name.into());
    }
    pub fn debug_name(&self, node: NodeId) -> Option<&str> {
        self.debug_names.get(&node).map(String::as_str)
    }
    pub fn register_image(&mut self, name: &str, texture: i32) {
        self.images.insert(name.into(), texture);
    }
    pub fn set_image_asset(&mut self, node: NodeId, name: &str) {
        self.core
            .set_image(node.0, self.images.get(name).copied().unwrap_or(-1));
    }
    pub fn set_image(&mut self, node: NodeId, texture: i32) {
        self.core.set_image(node.0, texture);
    }
    pub fn load_styles(&mut self, bytes: &[u8]) -> bool {
        self.core.load_styles(bytes)
    }
    pub fn tick(&mut self) {
        self.core.tick();
    }

    fn next_node(&self, node: NodeId) -> NodeId {
        if let Some(&child) = self.core.node_children(node.0).first() {
            return NodeId(child);
        }
        let mut current = node;
        loop {
            let parent = self.core.node_parent(current.0);
            if parent == 0 {
                return NodeId::NONE;
            }
            let children = self.core.node_children(parent);
            if let Some(index) = children.iter().position(|&child| child == current.0) {
                if let Some(&next) = children.get(index + 1) {
                    return NodeId(next);
                }
            }
            current = NodeId(parent);
        }
    }

    fn is_within(&self, node: NodeId, ancestor: NodeId) -> bool {
        let mut current = node;
        while current != NodeId::NONE {
            if current == ancestor {
                return true;
            }
            current = NodeId(self.core.node_parent(current.0));
        }
        false
    }

    fn first_focusable(&self, root: NodeId) -> NodeId {
        let mut current = root;
        while current != NodeId::NONE && self.is_within(current, root) {
            if self.focusable.contains(&current) && self.visible(current) {
                return current;
            }
            current = self.next_node(current);
        }
        NodeId::NONE
    }

    fn repair_focus(&mut self, removed: NodeId) {
        if !self.is_within(self.focused(), removed) {
            return;
        }
        let parent = self.core.node_parent(removed.0);
        let siblings = self.core.node_children(parent);
        let mut target = NodeId::NONE;
        if let Some(index) = siblings.iter().position(|&node| node == removed.0) {
            for &sibling in siblings[index + 1..]
                .iter()
                .chain(siblings[..index].iter().rev())
            {
                target = self.first_focusable(NodeId(sibling));
                if target != NodeId::NONE {
                    break;
                }
            }
        }
        if target == NodeId::NONE {
            let mut ancestor = NodeId(parent);
            while ancestor != NodeId::NONE {
                if self.focusable.contains(&ancestor) && self.visible(ancestor) {
                    target = ancestor;
                    break;
                }
                ancestor = NodeId(self.core.node_parent(ancestor.0));
            }
        }
        self.set_focus(target);
    }

    fn visible(&self, node: NodeId) -> bool {
        let mut current = node;
        while current != NodeId::NONE {
            if self
                .core
                .resolved_style(current.0)
                .is_none_or(|style| style.display == Display::None as u8)
            {
                return false;
            }
            if current == NodeId::ROOT {
                return true;
            }
            current = NodeId(self.core.node_parent(current.0));
        }
        false
    }

    fn move_focus(&mut self, forward: bool) {
        let focused = self.focused();
        let mut current = NodeId::ROOT;
        let mut first = NodeId::NONE;
        let mut previous = NodeId::NONE;
        let mut next = NodeId::NONE;
        let mut before_focus = NodeId::NONE;
        let mut found = false;
        while current != NodeId::NONE {
            if self.focusable.contains(&current) && self.visible(current) {
                if first == NodeId::NONE {
                    first = current;
                }
                if found && next == NodeId::NONE {
                    next = current;
                }
                if current == focused {
                    before_focus = previous;
                    found = true;
                }
                previous = current;
            }
            current = self.next_node(current);
        }
        let target = if !found {
            if forward { first } else { previous }
        } else if forward {
            if next == NodeId::NONE { focused } else { next }
        } else if before_focus == NodeId::NONE {
            focused
        } else {
            before_focus
        };
        self.set_focus(target);
    }

    /// Resolve edges and focus against core's current document order.
    /// Calling this with an unchanged input does not evaluate view bindings.
    pub fn resolve_input(&mut self, input: &Input) -> Input {
        let pressed = input.pressed | (input.buttons & !self.previous_buttons);
        let released = input.released | (self.previous_buttons & !input.buttons);
        self.previous_buttons = input.buttons;
        if released & btn::CIRCLE != 0 {
            self.core.set_active(self.active.0, false);
            self.active = NodeId::NONE;
        }
        for (button, forward) in [
            (btn::DOWN, true),
            (btn::RIGHT, true),
            (btn::UP, false),
            (btn::LEFT, false),
        ] {
            if pressed & button != 0 {
                self.move_focus(forward);
            }
        }
        let mut target = input.target;
        if target == NodeId::NONE && pressed & btn::CIRCLE != 0 {
            target = self.focused();
        }
        if target != NodeId::NONE && (!self.focusable.contains(&target) || !self.visible(target)) {
            target = NodeId::NONE;
        }
        if target != NodeId::NONE {
            self.core.set_active(self.active.0, false);
            self.active = target;
            self.core.set_active(target.0, true);
        }
        Input {
            target,
            pressed,
            released,
            buttons: input.buttons,
        }
    }
}
