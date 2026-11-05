//! Retain one completed USB operation across interrupted filesystem writes.
pub struct PendingReply {
    pub id: String,
    pub receipt: Vec<u8>,
    pub pixels: Option<Vec<u8>>,
}

impl PendingReply {
    /// Publish pixels before their receipt. A failed write keeps its bytes for
    /// the next exchange; the completed guest operation must not run again.
    pub fn deliver(
        &mut self,
        root: &str,
        mut write: impl FnMut(&str, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(pixels) = self.pixels.as_ref() {
            write(&format!("{root}/{}.rgba", self.id), pixels)?;
            self.pixels = None;
        }
        write(&format!("{root}/{}.json", self.id), &self.receipt)
    }
}
