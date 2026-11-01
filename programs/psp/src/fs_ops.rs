//! `globalThis.fs` for the PSP host (contracts/spec/fs.ts, capability data.fs) over sceIo, rooted at
//! ms0:/PSP/SAVEDATA/POCKETJS/<app>/. Probe-grade: the nine ops and their JSON shapes follow the spec;
//! quotas are not enforced (usage reports quotaBytes 0). Two PSP facts bend the spec:
//!  - sceIoRename only renames inside one directory (the target's directory part is ignored), so the
//!    truncating write stages ".~<name>" next to the target instead of in a host temp directory, and
//!    rename() between directories copies the file and removes the source;
//!  - it does not replace an existing file, so the old file is removed right before the rename — a
//!    power cut in that window loses the file (the spec asks for an atomic replace).
use alloc::{format, string::String, vec::Vec};
use core::ffi::c_void;
use libquickjs_sys::*;
use psp::sys::{self, IoOpenFlags, IoStatMode, SceIoDirent, SceIoStat};

use crate::service_bindings::{add_fn, arg_f64, arg_i32};

extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, text: *const u8, length: usize) -> JSValue;
}

const ROOT: &str = concat!("ms0:/PSP/SAVEDATA/POCKETJS/", env!("POCKETJS_APP"));
const MAX_IO: usize = 64 * 1024;
const MAX_ENTRIES: usize = 256;
static mut LAST: String = String::new();

fn nul(s: &str) -> Vec<u8> { let mut v = Vec::with_capacity(s.len() + 1); v.extend_from_slice(s.as_bytes()); v.push(0); v }
unsafe fn ok() -> i32 { LAST.clear(); 0 }
unsafe fn fail(m: &str) -> i32 { LAST = String::from(m); 1 }
unsafe fn fail_line(m: &str) -> String { LAST = String::from(m); format!("{{\"error\":{}}}", json_str(m)) }

/// Spec path grammar: relative, '/'-separated, no empty / "." / ".." segments, <=8 segments of <=64 bytes.
fn valid(path: &str, allow_root: bool) -> bool {
    if path.is_empty() { return allow_root; }
    if path.len() > 160 || path.contains(':') || path.contains('\\') { return false; }
    let segs: Vec<&str> = path.split('/').collect();
    segs.len() <= 8 && segs.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && s.len() <= 64)
}
fn full(path: &str) -> String { if path.is_empty() { String::from(ROOT) } else { format!("{}/{}", ROOT, path) } }

unsafe fn stat_of(p: &str) -> Option<(bool, u64)> {
    let mut st: SceIoStat = core::mem::zeroed();
    if sys::sceIoGetstat(nul(p).as_ptr(), &mut st) < 0 { return None; }
    Some((st.st_mode.contains(IoStatMode::IFDIR), st.st_size.max(0) as u64))
}
unsafe fn mkdirs(p: &str) -> bool {
    let mut at = 0;
    while let Some(i) = p[at..].find('/') {
        let prefix = &p[..at + i];
        at += i + 1;
        if prefix.ends_with(':') { continue; }
        if stat_of(prefix).is_none() { sys::sceIoMkdir(nul(prefix).as_ptr(), 0o777); }
    }
    match stat_of(p) { Some((true, _)) => true, Some((false, _)) => false, None => sys::sceIoMkdir(nul(p).as_ptr(), 0o777) >= 0 }
}
fn parent(p: &str) -> &str { p.rfind('/').map_or("", |i| &p[..i]) }

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
    }
    o.push('"'); o
}
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64_enc(b: &[u8]) -> String {
    let mut o = String::with_capacity(b.len() * 4 / 3 + 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 { o.push(if k <= c.len() { B64[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' }); }
    }
    o
}
fn b64_dec(s: &str) -> Option<Vec<u8>> {
    let mut o = Vec::new(); let (mut acc, mut bits) = (0u32, 0);
    for ch in s.bytes() {
        if ch == b'=' { break; }
        let v = B64.iter().position(|&x| x == ch)? as u32;
        acc = acc << 6 | v; bits += 6;
        if bits >= 8 { bits -= 8; o.push((acc >> bits) as u8); }
    }
    Some(o)
}
/// Payload encoding: a JSON string (stored as UTF-8) or {"$b":"<base64>"}.
fn decode_payload(t: &str) -> Option<Vec<u8>> {
    let t = t.trim();
    if let Some(rest) = t.strip_prefix('{') {
        let i = rest.find("\"$b\"")?; let r = &rest[i + 4..]; let q = r.find('"')?; let r = &r[q + 1..]; let e = r.find('"')?;
        return b64_dec(&r[..e]);
    }
    let body = t.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::new(); let mut it = body.chars();
    while let Some(c) = it.next() {
        if c != '\\' { out.push(c); continue; }
        match it.next()? {
            'n' => out.push('\n'), 't' => out.push('\t'), 'r' => out.push('\r'), 'b' => out.push('\u{8}'), 'f' => out.push('\u{c}'),
            'u' => {
                let hex: String = (&mut it).take(4).collect(); let mut cp = u32::from_str_radix(&hex, 16).ok()?;
                if (0xd800..0xdc00).contains(&cp) {
                    if it.next()? != '\\' || it.next()? != 'u' { return None; }
                    let lo: String = (&mut it).take(4).collect(); let lo = u32::from_str_radix(&lo, 16).ok()?;
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                }
                out.push(char::from_u32(cp)?);
            }
            o => out.push(o),
        }
    }
    Some(out.into_bytes())
}

unsafe fn write_file(p: &str, data: &[u8], append: bool) -> bool {
    let flags = IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | if append { IoOpenFlags::APPEND } else { IoOpenFlags::TRUNC };
    let fd = sys::sceIoOpen(nul(p).as_ptr(), flags, 0o777);
    if fd.0 < 0 { return false; }
    let n = sys::sceIoWrite(fd, data.as_ptr() as *const c_void, data.len());
    sys::sceIoClose(fd);
    n as usize == data.len()
}
unsafe fn op_write(path: &str, payload: &str, mode: i32) -> i32 {
    if !valid(path, false) { return fail("invalid path"); }
    let Some(bytes) = decode_payload(payload) else { return fail("invalid payload") };
    if bytes.len() > MAX_IO { return fail("payload too large"); }
    let target = full(path);
    if let Some((true, _)) = stat_of(&target) { return fail("is a directory"); }
    let dir = parent(&target);
    if !mkdirs(if dir.is_empty() { ROOT } else { dir }) { return fail("not a directory"); }
    if mode == 1 { return if write_file(&target, &bytes, true) { ok() } else { fail("io error") }; }
    let tmp = format!("{}/.~{}", parent(&target), &target[parent(&target).len() + 1..]);
    if !write_file(&tmp, &bytes, false) { return fail("io error"); }
    if stat_of(&target).is_some() { sys::sceIoRemove(nul(&target).as_ptr()); }
    if sys::sceIoRename(nul(&tmp).as_ptr(), nul(&target).as_ptr()) < 0 { return fail("rename failed"); }
    ok()
}
unsafe fn op_read(path: &str, offset: f64, max: f64) -> String {
    if !valid(path, false) { return fail_line("invalid path"); }
    if !(max >= 1.0 && max <= MAX_IO as f64) || offset < 0.0 { return fail_line("invalid range"); }
    let p = full(path);
    match stat_of(&p) { None => return fail_line("not found"), Some((true, _)) => return fail_line("is a directory"), _ => {} }
    let fd = sys::sceIoOpen(nul(&p).as_ptr(), IoOpenFlags::RD_ONLY, 0);
    if fd.0 < 0 { return fail_line("io error"); }
    let size = sys::sceIoLseek(fd, 0, sys::IoWhence::End).max(0) as u64;
    let off = (offset as u64).min(size);
    sys::sceIoLseek(fd, off as i64, sys::IoWhence::Set);
    let want = ((size - off) as usize).min(max as usize);
    let mut buf = alloc::vec![0u8; want];
    let got = if want > 0 { sys::sceIoRead(fd, buf.as_mut_ptr() as *mut c_void, want as u32).max(0) as usize } else { 0 };
    sys::sceIoClose(fd);
    buf.truncate(got); ok();
    format!("{{\"data\":{{\"$b\":\"{}\"}},\"size\":{},\"eof\":{}}}", b64_enc(&buf), size, off + got as u64 >= size)
}
unsafe fn entries(dir: &str) -> Option<Vec<(String, bool, u64)>> {
    let fd = sys::sceIoDopen(nul(dir).as_ptr());
    if fd.0 < 0 { return None; }
    let mut out = Vec::new(); let mut d: SceIoDirent = core::mem::zeroed();
    while sys::sceIoDread(fd, &mut d) > 0 {
        let len = d.d_name.iter().position(|&b| b == 0).unwrap_or(256);
        if let Ok(name) = core::str::from_utf8(&d.d_name[..len]) {
            if name != "." && name != ".." { out.push((String::from(name), d.d_stat.st_mode.contains(IoStatMode::IFDIR), d.d_stat.st_size.max(0) as u64)); }
        }
        d = core::mem::zeroed();
    }
    sys::sceIoDclose(fd);
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Some(out)
}
unsafe fn op_list(path: &str, offset: f64) -> String {
    if !valid(path, true) { return fail_line("invalid path"); }
    let p = full(path);
    if path.is_empty() { mkdirs(ROOT); }
    match stat_of(&p) { None => return fail_line("not found"), Some((false, _)) => return fail_line("not a directory"), _ => {} }
    let Some(all) = entries(&p) else { return fail_line("io error") };
    let start = (offset.max(0.0) as usize).min(all.len()); let end = (start + MAX_ENTRIES).min(all.len());
    let items: Vec<String> = all[start..end].iter().map(|(n, d, s)| format!("{{\"name\":{},\"kind\":\"{}\",\"size\":{}}}", json_str(n), if *d { "dir" } else { "file" }, if *d { 0 } else { *s })).collect();
    ok(); format!("{{\"entries\":[{}],\"eof\":{}}}", items.join(","), end == all.len())
}
unsafe fn op_stat(path: &str) -> String {
    if path.is_empty() { ok(); return String::from("{\"kind\":\"dir\",\"size\":0}"); }
    if !valid(path, false) { return fail_line("invalid path"); }
    match stat_of(&full(path)) {
        None => fail_line("not found"),
        Some((d, s)) => { ok(); format!("{{\"kind\":\"{}\",\"size\":{}}}", if d { "dir" } else { "file" }, if d { 0 } else { s }) }
    }
}
unsafe fn remove_tree(p: &str, depth: u32) -> bool {
    if depth > 8 { return false; }
    if let Some(list) = entries(p) { for (n, d, _) in list { let c = format!("{}/{}", p, n); if d { if !remove_tree(&c, depth + 1) { return false; } } else if sys::sceIoRemove(nul(&c).as_ptr()) < 0 { return false; } } }
    sys::sceIoRmdir(nul(p).as_ptr()) >= 0
}
unsafe fn op_remove(path: &str, recursive: i32) -> i32 {
    if path.is_empty() || !valid(path, false) { return fail("invalid path"); }
    let p = full(path);
    match stat_of(&p) {
        None => fail("not found"),
        Some((false, _)) => if sys::sceIoRemove(nul(&p).as_ptr()) >= 0 { ok() } else { fail("io error") },
        Some((true, _)) => if recursive != 0 { if remove_tree(&p, 0) { ok() } else { fail("io error") } }
            else if entries(&p).map_or(false, |e| e.is_empty()) && sys::sceIoRmdir(nul(&p).as_ptr()) >= 0 { ok() } else { fail("directory not empty") },
    }
}
unsafe fn op_mkdir(path: &str) -> i32 {
    if !valid(path, true) { return fail("invalid path"); }
    if mkdirs(&full(path)) { ok() } else { fail("not a directory") }
}
unsafe fn op_rename(from: &str, to: &str) -> i32 {
    if !valid(from, false) || !valid(to, false) { return fail("invalid path"); }
    if to.starts_with(&format!("{}/", from)) { return fail("into own subtree"); }
    let (f, t) = (full(from), full(to));
    let Some((fdir, _)) = stat_of(&f) else { return fail("not found") };
    if !matches!(stat_of(parent(&t)), Some((true, _))) { return fail("parent not found"); }
    match stat_of(&t) { Some((true, _)) => return fail("target is a directory"), Some((false, _)) if !fdir => { sys::sceIoRemove(nul(&t).as_ptr()); } _ => {} }
    if parent(&f) != parent(&t) { // PSP renames within one directory only: copy + remove for files
      if fdir { return fail("cross-directory directory rename unsupported on PSP"); }
      let fd = sys::sceIoOpen(nul(&f).as_ptr(), IoOpenFlags::RD_ONLY, 0);
      if fd.0 < 0 { return fail("io error"); }
      let size = sys::sceIoLseek(fd, 0, sys::IoWhence::End).max(0) as usize; sys::sceIoLseek(fd, 0, sys::IoWhence::Set);
      let mut buf = alloc::vec![0u8; size];
      let got = sys::sceIoRead(fd, buf.as_mut_ptr() as *mut c_void, size as u32); sys::sceIoClose(fd);
      if got as usize != size || !write_file(&t, &buf, false) { return fail("io error"); }
      sys::sceIoRemove(nul(&f).as_ptr());
      return ok();
    }
    if sys::sceIoRename(nul(&f).as_ptr(), nul(&t).as_ptr()) >= 0 { ok() } else { fail("io error") }
}
unsafe fn used(p: &str, depth: u32) -> u64 {
    if depth > 8 { return 0; }
    entries(p).map_or(0, |l| l.iter().map(|(n, d, s)| if *d { used(&format!("{}/{}", p, n), depth + 1) } else { *s }).sum())
}

// ---- QuickJS glue --------------------------------------------------------------------------------
unsafe fn arg_str(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> String {
    if (i as i32) >= argc { return String::new(); }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(i), 0);
    if s.is_null() { return String::new(); }
    let out = String::from_utf8_lossy(core::slice::from_raw_parts(s as *const u8, len)).into_owned();
    JS_FreeCString(ctx, s); out
}
unsafe fn ret(ctx: *mut JSContext, s: String) -> JSValue { JS_NewStringLen(ctx, s.as_ptr(), s.len()) }
unsafe extern "C" fn js_read(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { ret(c, op_read(&arg_str(c, n, a, 0), arg_f64(c, n, a, 1), arg_f64(c, n, a, 2))) }
unsafe extern "C" fn js_write(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { JS_NewInt32(c, op_write(&arg_str(c, n, a, 0), &arg_str(c, n, a, 1), arg_i32(c, n, a, 2))) }
unsafe extern "C" fn js_remove(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { JS_NewInt32(c, op_remove(&arg_str(c, n, a, 0), arg_i32(c, n, a, 1))) }
unsafe extern "C" fn js_list(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { ret(c, op_list(&arg_str(c, n, a, 0), arg_f64(c, n, a, 1))) }
unsafe extern "C" fn js_stat(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { ret(c, op_stat(&arg_str(c, n, a, 0))) }
unsafe extern "C" fn js_mkdir(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { JS_NewInt32(c, op_mkdir(&arg_str(c, n, a, 0))) }
unsafe extern "C" fn js_rename(c: *mut JSContext, _t: JSValue, n: i32, a: *mut JSValue) -> JSValue { JS_NewInt32(c, op_rename(&arg_str(c, n, a, 0), &arg_str(c, n, a, 1))) }
unsafe extern "C" fn js_usage(c: *mut JSContext, _t: JSValue, _n: i32, _a: *mut JSValue) -> JSValue { mkdirs(ROOT); ok(); ret(c, format!("{{\"usedBytes\":{},\"quotaBytes\":0}}", used(ROOT, 0))) }
unsafe extern "C" fn js_last(c: *mut JSContext, _t: JSValue, _n: i32, _a: *mut JSValue) -> JSValue { ret(c, LAST.clone()) }

/// Install `globalThis.fs`. # Safety: QuickJS context alive, worker thread.
pub unsafe fn register_fs(ctx: *mut JSContext, global: JSValue) {
    let fs = JS_NewObject(ctx);
    add_fn(ctx, fs, b"read\0", js_read, 3);
    add_fn(ctx, fs, b"write\0", js_write, 3);
    add_fn(ctx, fs, b"remove\0", js_remove, 2);
    add_fn(ctx, fs, b"list\0", js_list, 2);
    add_fn(ctx, fs, b"stat\0", js_stat, 1);
    add_fn(ctx, fs, b"mkdir\0", js_mkdir, 1);
    add_fn(ctx, fs, b"rename\0", js_rename, 2);
    add_fn(ctx, fs, b"usage\0", js_usage, 0);
    add_fn(ctx, fs, b"lastError\0", js_last, 0);
    JS_SetPropertyStr(ctx, global, b"fs\0".as_ptr() as *const _, fs);
}
