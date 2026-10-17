//! pocket-fs — the fs module's reference core.
//!
//! A per-app file tree behind the fs boundary pinned in
//! contracts/spec/fs.ts (`pocketjs_core::spec::fs` is the generated
//! mirror): read / write / remove / list / stat / mkdir / rename / usage /
//! lastError, plus the optional readText acceleration, mounted as
//! `globalThis.fs` through [`mount`]. Payloads cross as one JSON value (a
//! string for text, `{"$b": base64}` for bytes); results cross as one JSON
//! line except for readText's raw string.
//!
//! Storage policy is the host's: [`Storage::Memory`] for tests and
//! throwaway guests, [`Storage::Dir`] to bind the module to the app's own
//! data root on a real filesystem. Names are universal — any well-formed
//! Unicode, dot-prefixed included; nothing in the app's tree is reserved
//! to the host. Isolation is by construction and never depended on names:
//! every path is relative, `..`/absolute/`/`-in-segment are
//! unrepresentable, so the bound root is the sandbox boundary the way
//! db's ATTACH refusal keeps its data root one. The guest cannot create
//! symlinks through this API, but a host-side actor may have (on Pocket
//! Pi the device agent owns the whole workspace), so the Dir backend
//! lstat-checks every segment and treats any symlink as absent.
//!
//! Truncate writes are ATOMIC (temp + rename): after power loss a file
//! holds the old content or the new, never a torn middle. Temps land in
//! the module's own `tmp` directory — OUTSIDE the bound root, on the
//! same filesystem (cross-directory rename stays atomic) — so the app's
//! tree never shows host machinery, and a crash orphan cannot outlive
//! the next construction: the module OWNS `tmp` and clears it on
//! construction, which is provably safe precisely because nothing else
//! may live there. Porting note (the ESP32/LittleFS path): LittleFS's
//! rename is atomic, so a device host keeps the same contract by the
//! same moves.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use pocketjs_core::spec::fs as spec;
use serde_json::{json, Value as Json};

/// Where the app's file tree lives.
pub enum Storage {
    /// The whole tree in memory (tests, previews). Byte-exact names — the
    /// deterministic twin of the sim host.
    Memory,
    /// The tree under `root` — the app's own data root; the guest never
    /// sees the path. `tmp` is a host-private directory for atomic-write
    /// temps: same filesystem, outside `root` (Pocket Pi layout:
    /// `apps/<id>/data` and `apps/<id>/tmp`). The module OWNS `tmp` and
    /// clears it on construction.
    Dir { root: PathBuf, tmp: PathBuf },
}

enum Backend {
    Memory {
        files: BTreeMap<String, Vec<u8>>,
        dirs: BTreeSet<String>,
    },
    Dir {
        root: PathBuf,
        tmp: PathBuf,
        tmp_counter: u64,
    },
}

/// The fs module: every op as a method, [`mount`] to install the namespace.
pub struct FsModule {
    backend: Backend,
    /// Byte budget for the tree; 0 = unmetered. Enforced on write.
    quota_bytes: u64,
    last_error: String,
}

impl FsModule {
    pub fn new(storage: Storage) -> FsModule {
        FsModule::with_quota(storage, 0)
    }

    pub fn with_quota(storage: Storage, quota_bytes: u64) -> FsModule {
        FsModule {
            backend: match storage {
                Storage::Memory => Backend::Memory {
                    files: BTreeMap::new(),
                    dirs: BTreeSet::new(),
                },
                Storage::Dir { root, tmp } => {
                    // Best-effort sweep: any leftover temp is an orphan
                    // from a crash mid-write; nothing else lives here.
                    let _ = std::fs::remove_dir_all(&tmp);
                    Backend::Dir {
                        root,
                        tmp,
                        tmp_counter: 0,
                    }
                }
            },
            quota_bytes,
            last_error: String::new(),
        }
    }

    fn ok_line(&mut self, line: String) -> String {
        self.last_error.clear();
        line
    }

    fn err_line(&mut self, message: &str) -> String {
        self.last_error = message.to_owned();
        json!({ "error": message }).to_string()
    }

    fn err_text(&mut self, message: &str) -> String {
        self.last_error = message.to_owned();
        String::new()
    }

    fn status(&mut self, result: Result<(), String>) -> i32 {
        match result {
            Ok(()) => {
                self.last_error.clear();
                0
            }
            Err(message) => {
                self.last_error = message;
                1
            }
        }
    }

    /// `read(path, offset, maxBytes) -> json line` (spec OP_READ).
    pub fn read(&mut self, path: &str, offset: i64, max_bytes: i64) -> String {
        if !valid_path(path) {
            return self.err_line("invalid path");
        }
        if max_bytes < 1 || max_bytes as usize > spec::MAX_IO_BYTES {
            return self.err_line("read maxBytes out of range");
        }
        if offset < 0 {
            return self.err_line("read offset out of range");
        }
        let result = match &mut self.backend {
            Backend::Memory { files, dirs } => {
                match files.get(path) {
                    Some(bytes) => {
                        let start = (offset as usize).min(bytes.len());
                        let end = (start + max_bytes as usize).min(bytes.len());
                        Ok((bytes[start..end].to_vec(), bytes.len() as u64, end >= bytes.len()))
                    }
                    None if dirs.contains(path) => Err("is a directory".to_owned()),
                    None => Err("not found".to_owned()),
                }
            }
            Backend::Dir { root, .. } => dir_read(root, path, offset as u64, max_bytes as usize),
        };
        match result {
            Ok((chunk, size, eof)) => self.ok_line(
                json!({
                    "data": { spec::BLOB_KEY: BASE64.encode(&chunk) },
                    "size": size,
                    "eof": eof,
                })
                .to_string(),
            ),
            Err(message) => self.err_line(&message),
        }
    }

    /// `readText(path) -> string` (spec OP_READ_TEXT). The raw return avoids
    /// a JSON/base64 round trip; lastError distinguishes an empty file from
    /// failure. This optional op reads the complete file up to
    /// FS_MAX_TEXT_BYTES and validates UTF-8.
    pub fn read_text(&mut self, path: &str) -> String {
        if !valid_path(path) {
            return self.err_text("invalid path");
        }
        let result = match &mut self.backend {
            Backend::Memory { files, dirs } => match files.get(path) {
                Some(bytes) if bytes.len() <= spec::MAX_TEXT_BYTES => Ok(bytes.clone()),
                Some(_) => Err(spec::READ_TEXT_TOO_LARGE.to_owned()),
                None if dirs.contains(path) => Err("is a directory".to_owned()),
                None => Err("not found".to_owned()),
            },
            Backend::Dir { root, .. } => dir_read_all(root, path),
        };
        match result.and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "invalid UTF-8".to_owned())
        }) {
            Ok(text) => self.ok_line(text),
            Err(message) => self.err_text(&message),
        }
    }

    /// `write(path, data, mode) -> 0 | 1` (spec OP_WRITE).
    pub fn write(&mut self, path: &str, data: &str, mode: u32) -> i32 {
        let result = self.write_inner(path, data, mode);
        self.status(result)
    }

    fn write_inner(&mut self, path: &str, data: &str, mode: u32) -> Result<(), String> {
        if !valid_path(path) {
            return Err("invalid path".to_owned());
        }
        if mode != spec::WRITE_TRUNCATE && mode != spec::WRITE_APPEND {
            return Err("invalid write mode".to_owned());
        }
        let payload = decode_payload(data)?;
        if payload.len() > spec::MAX_IO_BYTES {
            return Err("write exceeds FS_MAX_IO_BYTES".to_owned());
        }
        let quota = self.quota_bytes;
        match &mut self.backend {
            Backend::Memory { files, dirs } => {
                if dirs.contains(path) {
                    return Err("is a directory".to_owned());
                }
                for ancestor in ancestors_of(path) {
                    if files.contains_key(&ancestor) {
                        return Err(format!("not a directory: {ancestor}"));
                    }
                    dirs.insert(ancestor);
                }
                let existing = files.get(path).map(Vec::len).unwrap_or(0) as u64;
                let next = if mode == spec::WRITE_APPEND {
                    existing + payload.len() as u64
                } else {
                    payload.len() as u64
                };
                let used: u64 = files.values().map(|b| b.len() as u64).sum();
                if quota > 0 && used - existing + next > quota {
                    return Err("quota exceeded".to_owned());
                }
                if mode == spec::WRITE_APPEND {
                    files.entry(path.to_owned()).or_default().extend_from_slice(&payload);
                } else {
                    files.insert(path.to_owned(), payload);
                }
                Ok(())
            }
            Backend::Dir {
                root,
                tmp,
                tmp_counter,
            } => {
                *tmp_counter += 1;
                dir_write(root, tmp, path, &payload, mode, quota, *tmp_counter)
            }
        }
    }

    /// `remove(path, recursive) -> 0 | 1` (spec OP_REMOVE).
    pub fn remove(&mut self, path: &str, recursive: u32) -> i32 {
        let result = (|| {
            if !valid_path(path) {
                return Err("invalid path".to_owned());
            }
            match &mut self.backend {
                Backend::Memory { files, dirs } => {
                    if files.remove(path).is_some() {
                        return Ok(());
                    }
                    if !dirs.contains(path) {
                        return Err("not found".to_owned());
                    }
                    let prefix = format!("{path}/");
                    let occupied = files.keys().any(|k| k.starts_with(&prefix))
                        || dirs.iter().any(|k| k.starts_with(&prefix));
                    if occupied && recursive != 1 {
                        return Err("directory not empty".to_owned());
                    }
                    files.retain(|k, _| !k.starts_with(&prefix));
                    dirs.retain(|k| !k.starts_with(&prefix));
                    dirs.remove(path);
                    Ok(())
                }
                Backend::Dir { root, .. } => dir_remove(root, path, recursive == 1),
            }
        })();
        self.status(result)
    }

    /// `list(path, offset) -> json line` (spec OP_LIST).
    pub fn list(&mut self, path: &str, offset: i64) -> String {
        if !path.is_empty() && !valid_path(path) {
            return self.err_line("invalid path");
        }
        let offset = offset.max(0) as usize;
        let result = match &mut self.backend {
            Backend::Memory { files, dirs } => {
                if files.contains_key(path) {
                    Err("not a directory".to_owned())
                } else if !path.is_empty() && !dirs.contains(path) {
                    Err("not found".to_owned())
                } else {
                    let mut names: BTreeSet<String> = BTreeSet::new();
                    let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
                    for key in files.keys().chain(dirs.iter()) {
                        if let Some(rest) = key.strip_prefix(&prefix) {
                            if key == path || rest.is_empty() {
                                continue;
                            }
                            names.insert(rest.split('/').next().unwrap().to_owned());
                        }
                    }
                    Ok(names
                        .into_iter()
                        .map(|name| {
                            let full =
                                if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                            match files.get(&full) {
                                Some(bytes) => (name, "file", bytes.len() as u64),
                                None => (name, "dir", 0),
                            }
                        })
                        .collect::<Vec<_>>())
                }
            }
            Backend::Dir { root, .. } => dir_list(root, path),
        };
        match result {
            Ok(all) => {
                let page: Vec<Json> = all
                    .iter()
                    .skip(offset)
                    .take(spec::MAX_DIR_ENTRIES)
                    .map(|(name, kind, size)| json!({ "name": name, "kind": kind, "size": size }))
                    .collect();
                let eof = offset + page.len() >= all.len();
                self.ok_line(json!({ "entries": page, "eof": eof }).to_string())
            }
            Err(message) => self.err_line(&message),
        }
    }

    /// `stat(path) -> json line` (spec OP_STAT).
    pub fn stat(&mut self, path: &str) -> String {
        if path.is_empty() {
            return self.ok_line(json!({ "kind": "dir", "size": 0 }).to_string());
        }
        if !valid_path(path) {
            return self.err_line("invalid path");
        }
        let result = match &mut self.backend {
            Backend::Memory { files, dirs } => match files.get(path) {
                Some(bytes) => Some(("file", bytes.len() as u64)),
                None if dirs.contains(path) => Some(("dir", 0)),
                None => None,
            },
            Backend::Dir { root, .. } => dir_stat(root, path),
        };
        match result {
            Some((kind, size)) => self.ok_line(json!({ "kind": kind, "size": size }).to_string()),
            None => self.err_line("not found"),
        }
    }

    /// `mkdir(path) -> 0 | 1` (spec OP_MKDIR) — recursive, idempotent.
    pub fn mkdir(&mut self, path: &str) -> i32 {
        let result = (|| {
            if !valid_path(path) {
                return Err("invalid path".to_owned());
            }
            match &mut self.backend {
                Backend::Memory { files, dirs } => {
                    if files.contains_key(path) {
                        return Err(format!("not a directory: {path}"));
                    }
                    for ancestor in ancestors_of(path) {
                        if files.contains_key(&ancestor) {
                            return Err(format!("not a directory: {ancestor}"));
                        }
                        dirs.insert(ancestor);
                    }
                    dirs.insert(path.to_owned());
                    Ok(())
                }
                Backend::Dir { root, .. } => dir_mkdir(root, path),
            }
        })();
        self.status(result)
    }

    /// `rename(from, to) -> 0 | 1` (spec OP_RENAME).
    pub fn rename(&mut self, from: &str, to: &str) -> i32 {
        let result = (|| {
            if !valid_path(from) || !valid_path(to) {
                return Err("invalid path".to_owned());
            }
            if from == to {
                return Ok(());
            }
            if to.starts_with(&format!("{from}/")) {
                return Err("cannot rename into own subtree".to_owned());
            }
            match &mut self.backend {
                Backend::Memory { files, dirs } => {
                    let to_parent = parent_of(to);
                    if !to_parent.is_empty() && !dirs.contains(to_parent) {
                        return Err("not found".to_owned());
                    }
                    if dirs.contains(to) {
                        return Err("destination exists".to_owned());
                    }
                    if let Some(bytes) = files.remove(from) {
                        files.insert(to.to_owned(), bytes);
                        return Ok(());
                    }
                    if !dirs.contains(from) {
                        return Err("not found".to_owned());
                    }
                    if files.contains_key(to) {
                        return Err("destination exists".to_owned());
                    }
                    let prefix = format!("{from}/");
                    let moved_files: Vec<(String, Vec<u8>)> = files
                        .iter()
                        .filter(|(k, _)| k.starts_with(&prefix))
                        .map(|(k, v)| (format!("{to}/{}", &k[prefix.len()..]), v.clone()))
                        .collect();
                    files.retain(|k, _| !k.starts_with(&prefix));
                    files.extend(moved_files);
                    let moved_dirs: Vec<String> = dirs
                        .iter()
                        .filter(|k| k.starts_with(&prefix))
                        .map(|k| format!("{to}/{}", &k[prefix.len()..]))
                        .collect();
                    dirs.retain(|k| !k.starts_with(&prefix));
                    dirs.extend(moved_dirs);
                    dirs.remove(from);
                    dirs.insert(to.to_owned());
                    Ok(())
                }
                Backend::Dir { root, .. } => dir_rename(root, from, to),
            }
        })();
        self.status(result)
    }

    /// `usage() -> json line` (spec OP_USAGE).
    pub fn usage(&mut self) -> String {
        let used: u64 = match &self.backend {
            Backend::Memory { files, .. } => files.values().map(|b| b.len() as u64).sum(),
            Backend::Dir { root, .. } => dir_used_bytes(root),
        };
        let quota = self.quota_bytes;
        self.ok_line(json!({ "usedBytes": used, "quotaBytes": quota }).to_string())
    }

    /// `lastError() -> string` (spec OP_LAST_ERROR) — module-scoped.
    pub fn last_error(&self) -> String {
        self.last_error.clone()
    }
}

// ---------------------------------------------------------------------------
// The path grammar (contracts/spec/fs.ts, spelled out — no regex dependency)
// ---------------------------------------------------------------------------

/// Universal names: any well-formed Unicode (a Rust `&str` already is)
/// except the escape hatches ("." and ".."), control characters, and
/// oversize segments. "/" inside a name is unrepresentable — the caller
/// split on it.
fn valid_segment(segment: &str) -> bool {
    if segment.is_empty() || segment.len() > spec::MAX_SEGMENT_BYTES {
        return false;
    }
    if segment == "." || segment == ".." {
        return false;
    }
    !segment.bytes().any(|b| b < 0x20 || b == 0x7f)
}

/// fsValidSegment / FS_MAX_DEPTH / FS_MAX_PATH_BYTES, one predicate.
fn valid_path(path: &str) -> bool {
    if path.is_empty() || path.len() > spec::MAX_PATH_BYTES {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    segments.len() <= spec::MAX_DEPTH && segments.iter().all(|s| valid_segment(s))
}

/// Ancestor paths of a valid path, nearest last ("a/b/c" -> ["a", "a/b"]).
fn ancestors_of(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, b) in path.bytes().enumerate() {
        if b == b'/' {
            out.push(path[..i].to_owned());
        }
    }
    out
}

fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// JSON payload -> bytes (a string stores as UTF-8; {"$b": base64} as-is).
fn decode_payload(data: &str) -> Result<Vec<u8>, String> {
    let parsed: Json =
        serde_json::from_str(data).map_err(|e| format!("malformed payload: {e}"))?;
    match parsed {
        Json::String(text) => Ok(text.into_bytes()),
        Json::Object(map) => match map.get(spec::BLOB_KEY) {
            Some(Json::String(b64)) => {
                BASE64.decode(b64).map_err(|e| format!("malformed payload: {e}"))
            }
            _ => Err("malformed payload: a JSON string or {\"$b\": base64}".to_owned()),
        },
        _ => Err("malformed payload: a JSON string or {\"$b\": base64}".to_owned()),
    }
}

// ---------------------------------------------------------------------------
// The Dir backend — std::fs under the app root, symlinks treated as absent
// ---------------------------------------------------------------------------

/// Resolve `path` under `root`, refusing any symlink component. The grammar
/// already forbids `..`/absolute paths; this guards against a HOST-side
/// actor having planted a link inside the root.
fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for segment in path.split('/') {
        current.push(segment);
        if std::fs::symlink_metadata(&current).is_ok_and(|md| md.file_type().is_symlink()) {
            return Err("not found".to_owned());
        }
    }
    Ok(current)
}

fn dir_read(root: &Path, path: &str, offset: u64, max_bytes: usize) -> Result<(Vec<u8>, u64, bool), String> {
    let full = resolve(root, path)?;
    let md = std::fs::metadata(&full).map_err(|_| "not found".to_owned())?;
    if md.is_dir() {
        return Err("is a directory".to_owned());
    }
    let size = md.len();
    let mut file = std::fs::File::open(&full).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset.min(size))).map_err(|e| e.to_string())?;
    let mut chunk = vec![0u8; max_bytes];
    let mut filled = 0;
    while filled < max_bytes {
        let n = file.read(&mut chunk[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    chunk.truncate(filled);
    let eof = offset.min(size) + filled as u64 >= size;
    Ok((chunk, size, eof))
}

fn dir_read_all(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let full = resolve(root, path)?;
    let md = std::fs::metadata(&full).map_err(|_| "not found".to_owned())?;
    if md.is_dir() {
        return Err("is a directory".to_owned());
    }
    if md.len() > spec::MAX_TEXT_BYTES as u64 {
        return Err(spec::READ_TEXT_TOO_LARGE.to_owned());
    }
    std::fs::read(&full).map_err(|e| e.to_string())
}

fn dir_write(
    root: &Path,
    tmp_dir: &Path,
    path: &str,
    payload: &[u8],
    mode: u32,
    quota: u64,
    tmp_counter: u64,
) -> Result<(), String> {
    let full = resolve(root, path)?;
    if full.is_dir() {
        return Err("is a directory".to_owned());
    }
    // Refuse a file on the ancestor chain with the memory backend's message.
    for ancestor in ancestors_of(path) {
        let p = resolve(root, &ancestor)?;
        if p.is_file() {
            return Err(format!("not a directory: {ancestor}"));
        }
    }
    let parent = full.parent().expect("resolved path always has a parent");
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if quota > 0 {
        let existing = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
        let next = if mode == spec::WRITE_APPEND {
            existing + payload.len() as u64
        } else {
            payload.len() as u64
        };
        if dir_used_bytes(root) - existing + next > quota {
            return Err("quota exceeded".to_owned());
        }
    }
    if mode == spec::WRITE_APPEND {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full)
            .map_err(|e| e.to_string())?;
        file.write_all(payload).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // The atomicity contract: land the payload in the host-owned temp
    // directory, sync, then rename over the target (same filesystem —
    // cross-directory rename is atomic).
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let mut suffix = tmp_counter;
    let (tmp, mut file) = loop {
        let candidate = tmp_dir.join(suffix.to_string());
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => suffix += 1,
            Err(e) => return Err(e.to_string()),
        }
    };
    let landed = file
        .write_all(payload)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string());
    drop(file);
    landed
        .and_then(|()| std::fs::rename(&tmp, &full).map_err(|e| e.to_string()))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

fn dir_remove(root: &Path, path: &str, recursive: bool) -> Result<(), String> {
    let full = resolve(root, path)?;
    let md = std::fs::symlink_metadata(&full).map_err(|_| "not found".to_owned())?;
    if md.is_file() {
        return std::fs::remove_file(&full).map_err(|e| e.to_string());
    }
    if !recursive {
        return match std::fs::remove_dir(&full) {
            Ok(()) => Ok(()),
            Err(_) if std::fs::read_dir(&full).map(|mut d| d.next().is_some()).unwrap_or(false) => {
                Err("directory not empty".to_owned())
            }
            Err(e) => Err(e.to_string()),
        };
    }
    std::fs::remove_dir_all(&full).map_err(|e| e.to_string())
}

fn dir_list(root: &Path, path: &str) -> Result<Vec<(String, &'static str, u64)>, String> {
    let full = if path.is_empty() { root.to_path_buf() } else { resolve(root, path)? };
    let md = std::fs::metadata(&full).map_err(|_| "not found".to_owned())?;
    if md.is_file() {
        return Err("not a directory".to_owned());
    }
    let mut out: Vec<(String, &'static str, u64)> = Vec::new();
    for entry in std::fs::read_dir(&full).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        // A name the vocabulary cannot address (control chars, oversize)
        // does not exist to the guest — it could be listed but never read.
        if !valid_segment(&name) {
            continue;
        }
        let emd = entry.metadata().map_err(|e| e.to_string())?;
        if emd.file_type().is_symlink() {
            continue;
        }
        if emd.is_dir() {
            out.push((name, "dir", 0));
        } else {
            out.push((name, "file", emd.len()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn dir_stat(root: &Path, path: &str) -> Option<(&'static str, u64)> {
    let full = resolve(root, path).ok()?;
    let md = std::fs::symlink_metadata(&full).ok()?;
    if md.file_type().is_symlink() {
        return None;
    }
    if md.is_dir() {
        Some(("dir", 0))
    } else {
        Some(("file", md.len()))
    }
}

fn dir_mkdir(root: &Path, path: &str) -> Result<(), String> {
    for ancestor in ancestors_of(path).into_iter().chain([path.to_owned()]) {
        let p = resolve(root, &ancestor)?;
        if p.is_file() {
            return Err(format!("not a directory: {ancestor}"));
        }
    }
    let full = resolve(root, path)?;
    std::fs::create_dir_all(&full).map_err(|e| e.to_string())
}

fn dir_rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let from_full = resolve(root, from)?;
    let from_md = std::fs::symlink_metadata(&from_full).map_err(|_| "not found".to_owned())?;
    let to_full = resolve(root, to)?;
    let to_parent = to_full.parent().expect("resolved path always has a parent");
    if !to_parent.is_dir() {
        return Err("not found".to_owned());
    }
    if std::fs::symlink_metadata(&to_full).is_ok_and(|to_md| to_md.is_dir() || from_md.is_dir()) {
        return Err("destination exists".to_owned());
    }
    std::fs::rename(&from_full, &to_full).map_err(|e| e.to_string())
}

fn dir_used_bytes(root: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        let mut total = 0;
        for entry in entries.flatten() {
            let Ok(md) = entry.metadata() else { continue };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                total += walk(&entry.path());
            } else {
                total += md.len();
            }
        }
        total
    }
    walk(root)
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

#[cfg(feature = "mount")]
use std::cell::RefCell;
#[cfg(feature = "mount")]
use std::rc::Rc;

/// Mount the module as `globalThis.fs` on a pocket-mod [`Guest`] — one JS
/// function per spec op, marshaled as (String, f64) -> i32/String.
/// Feature `mount` (default); a host with its own QuickJS wiring turns it
/// off and spells the required functions itself. This reference mount also
/// exposes the optional readText acceleration.
#[cfg(feature = "mount")]
pub fn mount(guest: &pocket_mod::Guest, module: Rc<RefCell<FsModule>>) -> anyhow::Result<()> {
    use pocket_mod::qjs::Function;
    guest.mount("fs", |ctx, ns| {
        let m = module.clone();
        ns.set(
            "read",
            Function::new(
                ctx.clone(),
                move |path: String, offset: f64, max_bytes: f64| -> String {
                    m.borrow_mut().read(&path, offset as i64, max_bytes as i64)
                },
            )?,
        )?;
        let m = module.clone();
        ns.set(
            "readText",
            Function::new(ctx.clone(), move |path: String| -> String {
                m.borrow_mut().read_text(&path)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "write",
            Function::new(
                ctx.clone(),
                move |path: String, data: String, mode: f64| -> i32 {
                    m.borrow_mut().write(&path, &data, mode as u32)
                },
            )?,
        )?;
        let m = module.clone();
        ns.set(
            "remove",
            Function::new(ctx.clone(), move |path: String, recursive: f64| -> i32 {
                m.borrow_mut().remove(&path, recursive as u32)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "list",
            Function::new(ctx.clone(), move |path: String, offset: f64| -> String {
                m.borrow_mut().list(&path, offset as i64)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "stat",
            Function::new(ctx.clone(), move |path: String| -> String {
                m.borrow_mut().stat(&path)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "mkdir",
            Function::new(ctx.clone(), move |path: String| -> i32 {
                m.borrow_mut().mkdir(&path)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "rename",
            Function::new(ctx.clone(), move |from: String, to: String| -> i32 {
                m.borrow_mut().rename(&from, &to)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "usage",
            Function::new(ctx.clone(), move || -> String { m.borrow_mut().usage() })?,
        )?;
        let m = module.clone();
        ns.set(
            "lastError",
            Function::new(ctx.clone(), move || -> String { m.borrow().last_error() })?,
        )?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn module() -> FsModule {
        FsModule::new(Storage::Memory)
    }

    fn line(s: &str) -> Json {
        serde_json::from_str(s).unwrap()
    }

    fn text(s: &str) -> String {
        json!(s).to_string()
    }

    #[test]
    fn path_grammar_refuses_escapes_and_nothing_else() {
        // The security rule: escapes and malformed shapes.
        for bad in ["", "/abs", "a//b", "a/", "../up", "a/../b", "a/.", "a\x07b"] {
            assert!(!valid_path(bad), "{bad:?} should be invalid");
        }
        assert!(valid_path(&vec!["a"; spec::MAX_DEPTH].join("/")));
        assert!(!valid_path(&vec!["a"; spec::MAX_DEPTH + 1].join("/")));
        assert!(!valid_path(&format!("{}x", "a".repeat(spec::MAX_PATH_BYTES))));
        assert!(!valid_path(&"名".repeat(22)), "22 CJK chars = 66 bytes > segment cap");
        // Universal names: anything an app wants to call its own files.
        for good in [
            "a",
            "notes/today.md",
            "A1._-x",
            ".config",
            "notes/.drafts/今日笔记.md",
            "-lead",
            "a\\b",
            "space in name.txt",
        ] {
            assert!(valid_path(good), "{good:?} should be valid");
        }
    }

    #[test]
    fn universal_names_round_trip() {
        let mut m = module();
        assert_eq!(m.write("笔记/今天.md", &text("你好"), spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.write(".config", &text("k=v"), spec::WRITE_TRUNCATE), 0);
        assert_eq!(line(&m.stat("笔记/今天.md"))["size"], 6);
        let listing = line(&m.list("", 0));
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        // Code point order: "." (U+002E) < "笔" (U+7B14).
        assert_eq!(names, [".config", "笔记"]);
    }

    #[test]
    fn write_read_round_trip_text_and_bytes() {
        let mut m = module();
        assert_eq!(m.write("notes/today.md", &text("# 今天"), spec::WRITE_TRUNCATE), 0);
        let read = line(&m.read("notes/today.md", 0, spec::MAX_IO_BYTES as i64));
        let bytes = BASE64.decode(read["data"][spec::BLOB_KEY].as_str().unwrap()).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "# 今天");
        assert_eq!(read["eof"], true);

        let payload = json!({ spec::BLOB_KEY: BASE64.encode([0u8, 1, 255]) }).to_string();
        assert_eq!(m.write("raw.bin", &payload, spec::WRITE_TRUNCATE), 0);
        assert_eq!(line(&m.stat("raw.bin"))["size"], 3);
    }

    #[test]
    fn read_text_is_whole_file_strict_utf8_with_last_error_status() {
        let mut m = module();
        let chunk = "x".repeat(spec::MAX_IO_BYTES);
        assert_eq!(m.write("big.txt", &text(&chunk), spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.write("big.txt", &text("终"), spec::WRITE_APPEND), 0);
        assert_eq!(m.read_text("big.txt"), format!("{chunk}终"));
        assert_eq!(m.last_error(), "");

        assert_eq!(m.write("empty.txt", &text(""), spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.read_text("missing.txt"), "");
        assert_eq!(m.last_error(), "not found");
        assert_eq!(m.read_text("empty.txt"), "");
        assert_eq!(m.last_error(), "");

        let invalid = json!({ spec::BLOB_KEY: BASE64.encode([0xff]) }).to_string();
        assert_eq!(m.write("bad.bin", &invalid, spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.read_text("bad.bin"), "");
        assert_eq!(m.last_error(), "invalid UTF-8");

        assert_eq!(m.write("too-big.txt", &text(&chunk), spec::WRITE_TRUNCATE), 0);
        for _ in 0..(spec::MAX_TEXT_BYTES / spec::MAX_IO_BYTES) {
            assert_eq!(m.write("too-big.txt", &text(&chunk), spec::WRITE_APPEND), 0);
        }
        assert_eq!(m.read_text("too-big.txt"), "");
        assert_eq!(m.last_error(), spec::READ_TEXT_TOO_LARGE);
    }

    #[test]
    fn append_and_chunked_read() {
        let mut m = module();
        assert_eq!(m.write("log.txt", &text("aaa"), spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.write("log.txt", &text("bbb"), spec::WRITE_APPEND), 0);
        let first = line(&m.read("log.txt", 0, 4));
        assert_eq!(first["size"], 6);
        assert_eq!(first["eof"], false);
        let rest = line(&m.read("log.txt", 4, 4));
        assert_eq!(rest["eof"], true);
        let bytes = BASE64.decode(rest["data"][spec::BLOB_KEY].as_str().unwrap()).unwrap();
        assert_eq!(bytes, b"bb");
    }

    #[test]
    fn write_creates_parents_and_refuses_file_ancestors() {
        let mut m = module();
        assert_eq!(m.write("a/b/c.txt", &text("x"), spec::WRITE_TRUNCATE), 0);
        assert_eq!(line(&m.stat("a/b"))["kind"], "dir");
        assert_eq!(m.write("a/b/c.txt/d.txt", &text("x"), spec::WRITE_TRUNCATE), 1);
        assert!(m.last_error().contains("not a directory"));
    }

    #[test]
    fn remove_semantics() {
        let mut m = module();
        m.write("dir/f.txt", &text("x"), spec::WRITE_TRUNCATE);
        assert_eq!(m.remove("missing.txt", 0), 1);
        assert_eq!(m.last_error(), "not found");
        assert_eq!(m.remove("dir", 0), 1);
        assert_eq!(m.last_error(), "directory not empty");
        assert_eq!(m.remove("dir", 1), 0);
        assert!(line(&m.stat("dir"))["error"].as_str().is_some());
    }

    #[test]
    fn list_is_sorted_and_pages() {
        let mut m = module();
        for i in 0..(spec::MAX_DIR_ENTRIES + 3) {
            m.write(&format!("d/f{i:04}.txt"), &text("x"), spec::WRITE_TRUNCATE);
        }
        let first = line(&m.list("d", 0));
        assert_eq!(first["entries"].as_array().unwrap().len(), spec::MAX_DIR_ENTRIES);
        assert_eq!(first["eof"], false);
        assert_eq!(first["entries"][0]["name"], "f0000.txt");
        let second = line(&m.list("d", spec::MAX_DIR_ENTRIES as i64));
        assert_eq!(second["entries"].as_array().unwrap().len(), 3);
        assert_eq!(second["eof"], true);
    }

    #[test]
    fn rename_semantics() {
        let mut m = module();
        m.write("a.txt", &text("A"), spec::WRITE_TRUNCATE);
        m.write("b.txt", &text("B"), spec::WRITE_TRUNCATE);
        assert_eq!(m.rename("a.txt", "b.txt"), 0, "file over file replaces");
        assert_eq!(line(&m.stat("a.txt"))["error"], "not found");

        m.mkdir("sub");
        assert_eq!(m.rename("b.txt", "sub"), 1);
        assert_eq!(m.last_error(), "destination exists");
        assert_eq!(m.rename("b.txt", "ghost/x.txt"), 1, "missing parent fails");
        assert_eq!(m.rename("sub", "sub/inner"), 1);
        assert_eq!(m.last_error(), "cannot rename into own subtree");

        m.write("sub/deep/f.txt", &text("x"), spec::WRITE_TRUNCATE);
        assert_eq!(m.rename("sub", "moved"), 0);
        assert_eq!(line(&m.stat("moved/deep/f.txt"))["kind"], "file");
    }

    #[test]
    fn quota_is_enforced_and_usage_reports() {
        let mut m = FsModule::with_quota(Storage::Memory, 10);
        assert_eq!(m.write("a.txt", &text("12345678"), spec::WRITE_TRUNCATE), 0);
        assert_eq!(m.write("b.txt", &text("123"), spec::WRITE_TRUNCATE), 1);
        assert_eq!(m.last_error(), "quota exceeded");
        assert_eq!(m.write("a.txt", &text("1"), spec::WRITE_TRUNCATE), 0, "shrink fits");
        let usage = line(&m.usage());
        assert_eq!(usage["usedBytes"], 1);
        assert_eq!(usage["quotaBytes"], 10);
    }

    #[test]
    fn io_ceiling_fails_loudly() {
        let mut m = module();
        let too_big = "x".repeat(spec::MAX_IO_BYTES + 1);
        assert_eq!(m.write("big.txt", &text(&too_big), spec::WRITE_TRUNCATE), 1);
        assert!(m.last_error().contains("FS_MAX_IO_BYTES"));
        m.write("ok.txt", &text("x"), spec::WRITE_TRUNCATE);
        let over = line(&m.read("ok.txt", 0, spec::MAX_IO_BYTES as i64 + 1));
        assert!(over["error"].as_str().unwrap().contains("maxBytes"));
    }

    #[test]
    fn dir_storage_round_trip_atomicity_and_symlink_refusal() {
        let base = std::env::temp_dir().join(format!("pocket-fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("data");
        let tmp = base.join("tmp");
        let dir = || Storage::Dir { root: root.clone(), tmp: tmp.clone() };
        std::fs::create_dir_all(&root).unwrap();
        // A leftover orphan from a "crash" is swept on construction.
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("7"), b"orphan").unwrap();
        {
            let mut m = FsModule::new(dir());
            assert!(!tmp.join("7").exists(), "orphan swept on construction");
            assert_eq!(m.write("notes/a.md", &text("hello"), spec::WRITE_TRUNCATE), 0);
            assert_eq!(m.write("notes/a.md", &text(" world"), spec::WRITE_APPEND), 0);
            std::fs::write(root.join("notes/bom.txt"), b"\xef\xbb\xbfline\n\0").unwrap();
            assert_eq!(m.read_text("notes/bom.txt"), "\u{feff}line\n\0");
            std::fs::write(root.join("notes/bad.bin"), [0xff]).unwrap();
            assert_eq!(m.read_text("notes/bad.bin"), "");
            assert_eq!(m.last_error(), "invalid UTF-8");
            std::fs::write(
                root.join("notes/too-big.txt"),
                vec![b'x'; spec::MAX_TEXT_BYTES + 1],
            )
            .unwrap();
            assert_eq!(m.read_text("notes/too-big.txt"), "");
            assert_eq!(m.last_error(), spec::READ_TEXT_TOO_LARGE);
            m.mkdir("empty");
            let listing = line(&m.list("", 0));
            let names: Vec<&str> = listing["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, ["empty", "notes"]);
        }
        {
            // A fresh module over the same root sees the persisted tree.
            let mut m = FsModule::new(dir());
            let read = line(&m.read("notes/a.md", 0, 64));
            let bytes = BASE64.decode(read["data"][spec::BLOB_KEY].as_str().unwrap()).unwrap();
            assert_eq!(bytes, b"hello world");
            // The app tree holds ONLY app names — temps live in `tmp`,
            // outside the bound root.
            let names: Vec<String> = std::fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert!(names.iter().all(|n| n == "notes" || n == "empty"), "{names:?}");
        }
        #[cfg(unix)]
        {
            let outside = root.parent().unwrap().join("pocket-fs-outside.txt");
            std::fs::write(&outside, b"secret").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
            let mut m = FsModule::new(dir());
            let read = line(&m.read("link.txt", 0, 64));
            assert_eq!(read["error"], "not found", "a symlink is invisible");
            assert_eq!(line(&m.stat("link.txt"))["error"], "not found");
            let listing = line(&m.list("", 0));
            assert!(!listing["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == "link.txt"));
            std::fs::remove_file(&outside).unwrap();
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(feature = "mount")]
    #[test]
    fn mounted_namespace_serves_a_quickjs_guest() {
        let guest = pocket_mod::Guest::new().unwrap();
        let module = Rc::new(RefCell::new(module()));
        mount(&guest, module).unwrap();
        guest
            .eval(
                "boot",
                r#"
                if (fs.write("notes/hi.txt", JSON.stringify("from-guest"), 0) !== 0) {
                    throw new Error(fs.lastError());
                }
                const stat = JSON.parse(fs.stat("notes/hi.txt"));
                if (stat.kind !== "file" || stat.size !== 10) throw new Error("bad stat");
                const read = JSON.parse(fs.read("notes/hi.txt", 0, 64));
                if (!read.eof) throw new Error("expected eof");
                if (fs.readText("notes/hi.txt") !== "from-guest") {
                    throw new Error("bad text read");
                }
                const sample = "\uFEFF行🚀\n\"quoted\"\0tail";
                if (fs.write("notes/unicode.txt", JSON.stringify(sample), 0) !== 0 ||
                    fs.readText("notes/unicode.txt") !== sample) {
                    throw new Error("raw text bridge changed Unicode");
                }
                const escape = JSON.parse(fs.read("../../etc/passwd", 0, 64));
                if (escape.error !== "invalid path") throw new Error("traversal not refused");
                globalThis.result = read.data["$b"];
                "#,
            )
            .unwrap();
        let result: String = guest.with(|ctx| ctx.globals().get("result").unwrap());
        assert_eq!(BASE64.decode(result).unwrap(), b"from-guest");
    }
}
