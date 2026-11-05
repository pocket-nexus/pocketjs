//! Opt-in layout work counters. Totals accumulate until reset; `taffy_nodes`
//! describes the current tree. Reading or resetting counters never changes
//! layout.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutCounters {
    /// Fresh Taffy trees: the first solve and validation resets.
    pub structure_rebuilds: u64,
    /// Reconciliations of the retained tree after structural changes.
    pub structure_syncs: u64,
    /// Root layout computations after changed inputs.
    pub layout_passes: u64,
    /// Leaf measurement callbacks Taffy requested during those computations.
    pub measure_callbacks: u64,
    /// Nodes whose normalized Taffy style changed.
    pub style_updates: u64,
    pub shaping_calls: u64,
    pub taffy_nodes_created: u64,
    /// Live nodes in the retained Taffy trees; kept across reset.
    pub taffy_nodes: u64,
}

impl LayoutCounters {
    pub(crate) fn add(&mut self, other: Self) {
        self.structure_rebuilds = self.structure_rebuilds.saturating_add(other.structure_rebuilds);
        self.structure_syncs = self.structure_syncs.saturating_add(other.structure_syncs);
        self.layout_passes = self.layout_passes.saturating_add(other.layout_passes);
        self.measure_callbacks = self.measure_callbacks.saturating_add(other.measure_callbacks);
        self.style_updates = self.style_updates.saturating_add(other.style_updates);
        self.shaping_calls = self.shaping_calls.saturating_add(other.shaping_calls);
        self.taffy_nodes_created = self.taffy_nodes_created.saturating_add(other.taffy_nodes_created);
        self.taffy_nodes = self.taffy_nodes.saturating_add(other.taffy_nodes);
    }

    /// Clears the totals and keeps the live-node count.
    pub(crate) fn reset(&mut self) {
        *self = Self { taffy_nodes: self.taffy_nodes, ..Self::default() };
    }
}
