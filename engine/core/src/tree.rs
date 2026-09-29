//! Node arena: `Vec<Node>` + free list + generation-tagged ids.
//!
//! ids are `(generation << spec::ID_SLOT_BITS) | slot`; the generation of a
//! slot is bumped when the slot is freed, so a stale id from JS resolves to
//! `None` and the op becomes a silent no-op. Slot 0 is never allocated (id 0
//! means "no node"); slot 1 is the pre-created root (`spec::ROOT_ID`), a
//! full-screen flex column expressed through its dynamic overrides.

use alloc::string::String;
use alloc::vec::Vec;

use crate::spec;
use crate::tree;

/// Generations live in bits ID_SLOT_BITS..31 — bit 31 must stay 0 so ids are
/// always positive i32s. Generations wrap inside this mask (documented
/// aliasing hazard after 2^11 reuses of one slot; acceptable for UI churn).
pub const GEN_MASK: u32 = (1u32 << (31 - spec::ID_SLOT_BITS)) - 1;

/// Split a generation-tagged id into (generation, slot).
#[inline]
pub fn split_id(id: i32) -> (u32, u32) {
    let u = id as u32;
    (u >> spec::ID_SLOT_BITS, u & spec::ID_SLOT_MASK)
}

/// Build a generation-tagged id from (generation, slot).
#[inline]
pub fn make_id(generation: u32, slot: u32) -> i32 {
    (((generation & GEN_MASK) << spec::ID_SLOT_BITS) | (slot & spec::ID_SLOT_MASK)) as i32
}

/// Rounded layout output of the last relayout, relative to the parent node.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct LayoutRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// One retained UI node.
pub struct Node {
    /// spec::NodeType value (0 view, 1 text, 2 image, 3 compositor surface).
    pub node_type: u8,
    /// Current generation of this slot (already masked to GEN_MASK).
    pub generation: u32,
    pub alive: bool,
    /// Parent node id (0 = detached / root).
    pub parent: i32,
    /// Child node ids in document order.
    pub children: Vec<i32>,
    /// Style-table record id (spec::STYLE_ID_NONE = unstyled).
    pub style_id: i32,
    /// Whether set_style has established an initial computed style. The first
    /// style application snaps instead of transitioning from default values.
    pub style_initialized: bool,
    /// Dynamic `set_prop` overrides: (prop id, raw u32 payload), applied on
    /// top of the style variants. At most one entry per prop.
    pub overrides: Vec<(u8, u32)>,
    /// Live animation values, applied last (over `overrides`). Entries exist
    /// only while a track runs on (node, prop); completion/cancel migrates or
    /// removes them (see lib.rs).
    pub anim_values: Vec<(u8, u32)>,
    /// UTF-8 content (text nodes only).
    pub text: String,
    /// Uploaded texture handle (image nodes only; -1 = none). For an animated
    /// sprite this is the ATLAS texture; the drawn frame is a UV sub-rect of it.
    pub tex: i32,
    /// Pocket System package surface handle (surface nodes only; -1 = none).
    pub compositor_surface: i32,
    /// Shell focus fact carried by SURFACE_QUAD for native scheduling/input.
    pub compositor_focused: bool,
    /// Animated-sprite frame count over `tex` (0 = plain image, no animation).
    pub sprite_frames: u16,
    /// Atlas grid columns (frame i sits at col i%cols, row i/cols).
    pub sprite_cols: u16,
    /// Host frames (vblanks) each sprite frame stays on screen (>=1).
    pub sprite_step: u16,
    /// Global frame counter captured when the sprite was bound — the animation
    /// plays from frame 0 the moment the node is displayed, and is a pure
    /// function of (Ui.frame - sprite_start), so goldens stay byte-exact.
    pub sprite_start: u64,
    pub focused: bool,
    pub active: bool,
    /// taffy handle of the last layout build (None = excluded from layout).
    pub taffy: Option<taffy::NodeId>,
    /// Rounded layout output (position relative to parent).
    pub layout: LayoutRect,
    /// Text nodes: the measurement provider RECORDED at the last layout
    /// build — true = the host's native measurer sized this box, so paint
    /// MUST emit TEXT_RUN; false = baked atlas metrics, GLYPH_RUN. One
    /// provider per node per layout, never re-decided at paint time
    /// (docs/BACKENDS.md).
    pub text_native: bool,
}

impl Node {
    fn empty(generation: u32) -> Node {
        Node {
            node_type: 0,
            generation,
            alive: false,
            parent: 0,
            children: Vec::new(),
            style_id: spec::STYLE_ID_NONE,
            style_initialized: false,
            overrides: Vec::new(),
            anim_values: Vec::new(),
            text: String::new(),
            tex: -1,
            compositor_surface: -1,
            compositor_focused: false,
            sprite_frames: 0,
            sprite_cols: 0,
            sprite_step: 0,
            sprite_start: 0,
            focused: false,
            active: false,
            taffy: None,
            layout: LayoutRect::default(),
            text_native: false,
        }
    }

    /// This node's generation-tagged id (valid only while alive).
    #[inline]
    pub fn id(&self, slot: u32) -> i32 {
        make_id(self.generation, slot)
    }

    /// Find an override entry's value.
    #[inline]
    pub fn find_entry(list: &[(u8, u32)], prop: u8) -> Option<u32> {
        list.iter().find(|(p, _)| *p == prop).map(|(_, v)| *v)
    }

    /// Insert-or-replace an entry in an override list.
    pub fn put_entry(list: &mut Vec<(u8, u32)>, prop: u8, value: u32) {
        for e in list.iter_mut() {
            if e.0 == prop {
                e.1 = value;
                return;
            }
        }
        list.push((prop, value));
    }

    /// Remove an entry from an override list.
    pub fn remove_entry(list: &mut Vec<(u8, u32)>, prop: u8) {
        list.retain(|(p, _)| *p != prop);
    }
}

/// The node arena.
pub struct Tree {
    pub slots: Vec<Node>,
    free: Vec<u32>,
}

impl Tree {
    /// New arena with slot 0 reserved and the root pre-created at slot 1 as a
    /// full-screen flex column (via dynamic overrides so any user style still
    /// layers under them predictably).
    pub fn new() -> Tree {
        let mut t = Tree { slots: Vec::new(), free: Vec::new() };
        t.slots.push(Node::empty(0)); // slot 0: never allocated
        let mut root = Node::empty(0);
        root.node_type = spec::NodeType::View as u8;
        root.alive = true;
        root.overrides.push((spec::prop::WIDTH, (spec::SCREEN_W as f32).to_bits()));
        root.overrides.push((spec::prop::HEIGHT, (spec::SCREEN_H as f32).to_bits()));
        root.overrides.push((spec::prop::FLEX_DIR, spec::FlexDir::Col as u32));
        t.slots.push(root); // slot 1 == spec::ROOT_ID (gen 0)
        t
    }

    /// Resolve an id to its arena slot; `None` for 0, stale or dead ids.
    pub fn resolve(&self, id: i32) -> Option<u32> {
        if id <= 0 {
            return None;
        }
        let (generation, slot) = split_id(id);
        let node = self.slots.get(slot as usize)?;
        if node.alive && node.generation == generation && slot != 0 {
            Some(slot)
        } else {
            None
        }
    }

    #[inline]
    pub fn get(&self, id: i32) -> Option<&Node> {
        self.resolve(id).map(|s| &self.slots[s as usize])
    }

    #[inline]
    pub fn get_mut(&mut self, id: i32) -> Option<&mut Node> {
        let s = self.resolve(id)?;
        Some(&mut self.slots[s as usize])
    }

    /// Allocate a detached node; returns its id, or 0 when the arena is full.
    pub fn alloc(&mut self, node_type: u8) -> i32 {
        let slot = match self.free.pop() {
            Some(s) => s,
            None => {
                if self.slots.len() as u32 > spec::ID_SLOT_MASK {
                    return 0;
                }
                self.slots.push(Node::empty(0));
                (self.slots.len() - 1) as u32
            }
        };
        let generation = self.slots[slot as usize].generation;
        let node = &mut self.slots[slot as usize];
        *node = Node::empty(generation);
        node.node_type = node_type;
        node.alive = true;
        make_id(generation, slot)
    }

    /// Free one slot (bump generation so outstanding ids go stale).
    pub fn free_slot(&mut self, slot: u32) {
        let node = &mut self.slots[slot as usize];
        let next_gen = (node.generation + 1) & GEN_MASK;
        *node = Node::empty(next_gen);
        self.free.push(slot);
    }

    /// Unlink `child_id` from its parent (if attached). Does not free it.
    pub fn detach(&mut self, child_id: i32) {
        let Some(cslot) = self.resolve(child_id) else { return };
        let parent_id = self.slots[cslot as usize].parent;
        if parent_id != 0 {
            if let Some(pslot) = self.resolve(parent_id) {
                self.slots[pslot as usize].children.retain(|&c| c != child_id);
            }
            self.slots[cslot as usize].parent = 0;
        }
    }

    /// True if `maybe_ancestor_id` is `id` itself or one of its ancestors.
    pub fn is_in_subtree(&self, maybe_ancestor_id: i32, id: i32) -> bool {
        let mut cur = id;
        let mut hops = 0u32;
        while cur != 0 && hops <= spec::ID_SLOT_MASK {
            if cur == maybe_ancestor_id {
                return true;
            }
            cur = match self.get(cur) {
                Some(n) => n.parent,
                None => 0,
            };
            hops += 1;
        }
        false
    }

    /// DOM-move-semantics insert: unlink `child` from wherever it is, then
    /// insert it under `parent` before `anchor` (0 or unknown anchor =
    /// append). No-ops on stale ids, self-insertion, cycles, root-as-child
    /// and inserts past spec::MAX_TREE_DEPTH.
    pub fn insert_before(&mut self, parent_id: i32, child_id: i32, anchor_id: i32) -> bool {
        let (Some(pslot), Some(_cslot)) = (self.resolve(parent_id), self.resolve(child_id)) else {
            return false;
        };
        // The root must never acquire a parent: a detached parent would pass
        // the cycle guard below, and destroying it would free slot 1 forever.
        if parent_id == child_id || child_id == anchor_id || child_id == spec::ROOT_ID {
            return false;
        }
        // Cycle guard: parent may not be inside child's subtree.
        if self.is_in_subtree(child_id, parent_id) {
            return false;
        }
        // Depth cap (spec::MAX_TREE_DEPTH): every recursive walk (layout
        // build/readback, paint, subtree destroy) recurses per level, so
        // unbounded depth would overflow the small PSP thread stacks.
        let mut depth = 1u32; // the child's depth if the parent were the root
        let mut cur = parent_id;
        while cur != spec::ROOT_ID && cur != 0 {
            depth += 1;
            if depth > spec::MAX_TREE_DEPTH {
                return false;
            }
            cur = match self.get(cur) {
                Some(n) => n.parent,
                None => 0,
            };
        }
        self.detach(child_id);
        let children = &mut self.slots[pslot as usize].children;
        let idx = if anchor_id != 0 {
            children.iter().position(|&c| c == anchor_id)
        } else {
            None
        };
        match idx {
            Some(i) => children.insert(i, child_id),
            None => children.push(child_id),
        }
        if let Some(cslot) = self.resolve(child_id) {
            self.slots[cslot as usize].parent = parent_id;
        }
        true
    }

    /// Detach `child` from `parent` (keeps the node alive for re-insert).
    pub fn remove_child(&mut self, parent_id: i32, child_id: i32) -> bool {
        let Some(cslot) = self.resolve(child_id) else { return false };
        if self.slots[cslot as usize].parent != parent_id || self.resolve(parent_id).is_none() {
            return false;
        }
        self.detach(child_id);
        true
    }

    /// Collect the slots of `id`'s whole subtree (including `id`), DFS order.
    pub fn collect_subtree(&self, id: i32, out: &mut Vec<u32>) {
        let Some(slot) = self.resolve(id) else { return };
        out.push(slot);
        for &c in &self.slots[slot as usize].children {
            self.collect_subtree(c, out);
        }
    }

    /// Concatenate the inline text run of a text element: its own text plus
    /// the text of all text-type descendants reachable through text nodes.
    pub fn collect_run(&self, slot: u32, out: &mut String) {
        let node = &self.slots[slot as usize];
        out.push_str(&node.text);
        for &c in &node.children {
            if let Some(cs) = self.resolve(c) {
                if self.slots[cs as usize].node_type == spec::NodeType::Text as u8 {
                    self.collect_run(cs, out);
                }
            }
        }
    }
}

impl Default for tree::Tree {
    fn default() -> Self {
        Self::new()
    }
}
