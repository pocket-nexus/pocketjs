//! DevTools mailbox transport for desktop hosts — the std twin of the PSP's
//! `programs/psp/src/dbg.rs` (docs/DEVTOOLS.md §3). The bridge (`bun run devtools
//! --dir <root>`) owns `<root>/pocketjs-dbg/{enable,in,out}.jsonl`; we read
//! panel commands from `in.jsonl` at a running offset and append replies to
//! `out.jsonl`. The file is the wire, exactly as on hardware — the same
//! bridge and panel drive both without knowing which one they got.
//!
//! Probed ONCE at mount: the root is `$POCKETJS_DBG_DIR` if set, else the
//! process working directory. Active only if `pocketjs-dbg/enable` exists —
//! a plain run costs one metadata stat and never touches IO again.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

/// Max bytes consumed per poll; longer backlogs drain over several polls
/// (same cap as the PSP transport).
const POLL_BUF: usize = 4096;

pub struct DbgMailbox {
    /// `<root>/pocketjs-dbg`.
    dir: PathBuf,
    /// Byte offset into `in.jsonl` of the first unconsumed byte.
    read_off: u64,
}

impl DbgMailbox {
    /// Probe for an armed mailbox. Skips any commands already in `in.jsonl`
    /// from a previous session (starts reading at the current EOF), matching
    /// the PSP boot behavior.
    pub fn probe() -> Option<DbgMailbox> {
        let root = std::env::var_os("POCKETJS_DBG_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())?;
        let dir = root.join("pocketjs-dbg");
        if !dir.join("enable").exists() {
            return None;
        }
        let read_off = std::fs::metadata(dir.join("in.jsonl"))
            .map(|m| m.len())
            .unwrap_or(0);
        log::info!("pocket-ui: DevTools mailbox attached at {}", dir.display());
        Some(DbgMailbox { dir, read_off })
    }

    /// New bytes from `in.jsonl` since the last poll, cut at the last
    /// complete line (a line the bridge is mid-writing stays for the next
    /// poll).
    pub fn poll(&mut self) -> Option<String> {
        let mut f = File::open(self.dir.join("in.jsonl")).ok()?;
        f.seek(SeekFrom::Start(self.read_off)).ok()?;
        let mut buf = vec![0u8; POLL_BUF];
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        let complete = buf[..n].iter().rposition(|&b| b == b'\n')? + 1;
        self.read_off += complete as u64;
        String::from_utf8(buf[..complete].to_vec()).ok()
    }

    /// Append one JSON line to `out.jsonl`.
    pub fn send(&self, line: &str) {
        let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("out.jsonl"))
        else {
            return;
        };
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed_box(tmp: &std::path::Path) -> DbgMailbox {
        std::fs::create_dir_all(tmp.join("pocketjs-dbg")).unwrap();
        std::fs::write(tmp.join("pocketjs-dbg/enable"), "").unwrap();
        std::fs::write(tmp.join("pocketjs-dbg/in.jsonl"), "").unwrap();
        DbgMailbox {
            dir: tmp.join("pocketjs-dbg"),
            read_off: 0,
        }
    }

    #[test]
    fn poll_cuts_at_last_complete_line() {
        let tmp = std::env::temp_dir().join(format!("pjs-dbg-{}", std::process::id()));
        let mut b = armed_box(&tmp);
        std::fs::write(b.dir.join("in.jsonl"), "{\"t\":\"a\"}\n{\"t\":\"b\"}\n{\"t\":").unwrap();
        assert_eq!(b.poll().unwrap(), "{\"t\":\"a\"}\n{\"t\":\"b\"}\n");
        // The partial third line stays for the next poll…
        assert!(b.poll().is_none());
        // …and arrives once the writer finishes it.
        let mut f = OpenOptions::new().append(true).open(b.dir.join("in.jsonl")).unwrap();
        f.write_all(b"\"c\"}\n").unwrap();
        assert_eq!(b.poll().unwrap(), "{\"t\":\"c\"}\n");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn send_appends_lines() {
        let tmp = std::env::temp_dir().join(format!("pjs-dbg-send-{}", std::process::id()));
        let b = armed_box(&tmp);
        b.send("{\"t\":\"hello\"}");
        b.send("{\"t\":\"stats\"}");
        let out = std::fs::read_to_string(b.dir.join("out.jsonl")).unwrap();
        assert_eq!(out, "{\"t\":\"hello\"}\n{\"t\":\"stats\"}\n");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
