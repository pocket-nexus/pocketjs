//! Driver-owned textures retained by the submissions that read them.
//!
//! Handles include the host's generation; revisions identify in-place edits.
//! Upload/free callbacks own native API calls. A successful upload commits a
//! replacement; an upload error leaves every old entry and reference intact.
//! Limits bound resident entries after commit. One staging upload can coexist
//! with those entries; drivers that cannot afford that allocation may reject
//! the upload. Pinned entries are never eviction candidates.
#![no_std]
extern crate alloc;

use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureKey {
    pub handle: i32,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheError<E> {
    Capacity,
    Upload(E),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InUse;

struct Entry<T> {
    key: TextureKey,
    texture: T,
    bytes: usize,
    submissions: Vec<u64>,
    invalidated: bool,
    used: u64,
}

/// A renderer must keep this cache alive until its submissions finish, and
/// call `clear` while its native device is valid. Submission ids are unique
/// across all displays sharing the cache until retirement.
pub struct TextureCache<T> {
    entries: Vec<Entry<T>>,
    max_entries: usize,
    max_bytes: usize,
    clock: u64,
}

impl<T> TextureCache<T> {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: Vec::new(),
            max_entries,
            max_bytes,
            clock: 0,
        }
    }
    pub fn unbounded() -> Self {
        Self::new(usize::MAX, usize::MAX)
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn resident_bytes(&self) -> usize {
        self.entries.iter().map(|entry| entry.bytes).sum()
    }

    pub fn get(&self, key: TextureKey) -> Option<&T> {
        self.entries
            .iter()
            .find(|entry| entry.key == key && !entry.invalidated)
            .map(|entry| &entry.texture)
    }

    /// Add a submission reference before native commands use this texture.
    pub fn retain(&mut self, key: TextureKey, submission: u64) -> Option<&T> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.key == key && !entry.invalidated)?;
        if !entry.submissions.contains(&submission) {
            entry.submissions.push(submission);
        }
        self.clock = self.clock.saturating_add(1);
        entry.used = self.clock;
        Some(&entry.texture)
    }

    /// `None` is appropriate only when the native API itself retains queued
    /// texture reads after the release callback (for example GL deletion).
    pub fn get_or_upload<E>(
        &mut self,
        key: TextureKey,
        bytes: usize,
        submission: Option<u64>,
        upload: impl FnOnce() -> Result<T, E>,
        mut release: impl FnMut(T),
    ) -> Result<&T, CacheError<E>> {
        self.clock = self.clock.saturating_add(1);
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.key == key && !entry.invalidated)
        {
            let entry = &mut self.entries[index];
            if let Some(id) = submission {
                if !entry.submissions.contains(&id) {
                    entry.submissions.push(id);
                }
            }
            entry.used = self.clock;
            return Ok(&entry.texture);
        }
        if self.max_entries == 0 || bytes > self.max_bytes {
            return Err(CacheError::Capacity);
        }
        // Plan before uploading. No mutation/free occurs until upload succeeds.
        let mut candidates: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.submissions.is_empty())
            .map(|(index, _)| index)
            .collect();
        candidates.sort_by_key(|index| {
            let entry = &self.entries[*index];
            (
                !(entry.invalidated || entry.key.handle == key.handle),
                entry.used,
            )
        });
        let mut count = self.entries.len();
        let mut resident = self.resident_bytes();
        let mut remove = Vec::new();
        for index in candidates {
            if count < self.max_entries && resident <= self.max_bytes - bytes {
                break;
            }
            count -= 1;
            resident -= self.entries[index].bytes;
            remove.push(index);
        }
        if count >= self.max_entries || resident > self.max_bytes - bytes {
            return Err(CacheError::Capacity);
        }
        let texture = upload().map_err(CacheError::Upload)?;
        remove.sort_unstable();
        for index in remove.into_iter().rev() {
            release(self.entries.remove(index).texture);
        }
        // All older renditions survive until their own submissions retire.
        for entry in &mut self.entries {
            if entry.key.handle == key.handle {
                entry.invalidated = true;
            }
        }
        self.collect(&mut release);
        let mut submissions = Vec::new();
        if let Some(id) = submission {
            submissions.push(id);
        }
        self.entries.push(Entry {
            key,
            texture,
            bytes,
            submissions,
            invalidated: false,
            used: self.clock,
        });
        Ok(&self.entries.last().unwrap().texture)
    }

    /// Mark stale without invoking a native API; useful when no context is current.
    pub fn invalidate(&mut self, key: TextureKey) {
        for entry in &mut self.entries {
            if entry.key == key {
                entry.invalidated = true;
            }
        }
    }
    pub fn invalidate_all(&mut self) {
        for entry in &mut self.entries {
            entry.invalidated = true;
        }
    }

    /// Call after the submission has stopped reading resources. Renderer and
    /// DisplayOutput contract waits are terminal on both Ok and Err, so either
    /// result permits retirement. A native nonterminal poll/timeout does not;
    /// keep its references until the driver establishes terminal completion.
    pub fn retire(&mut self, submission: u64, release: impl FnMut(T)) {
        for entry in &mut self.entries {
            entry.submissions.retain(|id| *id != submission);
        }
        self.collect(release);
    }

    pub fn collect(&mut self, mut release: impl FnMut(T)) {
        let mut index = 0;
        while index < self.entries.len() {
            let entry = &self.entries[index];
            if entry.invalidated && entry.submissions.is_empty() {
                release(self.entries.remove(index).texture);
            } else {
                index += 1;
            }
        }
    }

    /// All-or-nothing teardown. A busy cache remains usable without releases.
    pub fn clear(&mut self, mut release: impl FnMut(T)) -> Result<(), InUse> {
        if self
            .entries
            .iter()
            .any(|entry| !entry.submissions.is_empty())
        {
            return Err(InUse);
        }
        for entry in self.entries.drain(..) {
            release(entry.texture);
        }
        Ok(())
    }
}
