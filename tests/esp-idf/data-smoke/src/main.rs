//! data-smoke — on-device conformance check for the data modules.
//!
//! Runs pocket-fs and pocket-db (no `mount` feature — the module cores
//! directly, the way a device host with its own guest wiring drives them)
//! against a LittleFS partition on real hardware, and reports over UART:
//!
//!   DATA-SMOKE: PASS boot=<n>
//!
//! A boot counter persists across runs, so flashing once and power-cycling
//! twice proves both modules keep data through real power loss. The
//! contract semantics themselves are verified host-side (tests/*.test.ts,
//! the crates' unit tests); this binary only asks the questions hardware
//! can answer: does it compile here, does LittleFS behave, what does it
//! cost.

use std::time::Instant;

use esp_idf_svc::fs::littlefs::Littlefs;
use esp_idf_svc::io::vfs::MountedLittlefs;
use pocket_db::{DbModule, Storage as DbStorage};
use pocket_fs::{FsModule, Storage as FsStorage};
use serde_json::Value as Json;

const WORKSPACE_ROOT: &str = "/workspace";
const DATA_ROOT: &str = "/workspace/apps/smoke/data";
const TMP_DIR: &str = "/workspace/apps/smoke/tmp";

fn main() {
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();
    match run() {
        Ok(boot) => log::info!("DATA-SMOKE: PASS boot={boot}"),
        Err(error) => log::error!("DATA-SMOKE: FAIL: {error:#}"),
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(10));
        log::info!("DATA-SMOKE: idle");
    }
}

fn run() -> anyhow::Result<i64> {
    let _mount = mount_workspace()?;
    std::fs::create_dir_all(DATA_ROOT)?;
    let heap_before = unsafe { esp_idf_svc::sys::esp_get_free_heap_size() };

    let boot = fs_smoke()?;
    db_smoke()?;

    let heap_after = unsafe { esp_idf_svc::sys::esp_get_free_heap_size() };
    log::info!(
        "DATA-SMOKE: heap before {heap_before} after {heap_after} (delta {})",
        heap_before as i64 - heap_after as i64
    );
    Ok(boot)
}

fn expect(condition: bool, what: &str) -> anyhow::Result<()> {
    anyhow::ensure!(condition, "expectation failed: {what}");
    Ok(())
}

// --- fs: the nine-op contract against real LittleFS ------------------------

fn fs_smoke() -> anyhow::Result<i64> {
    let started = Instant::now();
    let mut fs = FsModule::new(FsStorage::Dir {
        root: DATA_ROOT.into(),
        tmp: TMP_DIR.into(),
    });

    // Boot counter: truncate-write on every boot; its value is the proof
    // that atomic writes and LittleFS persistence survive power cycling.
    let boot = match parse(&fs.read("boot.txt", 0, 64)) {
        Ok(line) => {
            let b64 = line["data"]["$b"].as_str().unwrap_or_default();
            String::from_utf8(base64_decode(b64))?.trim().parse::<i64>()? + 1
        }
        Err(_) => 0, // first boot on a fresh partition
    };
    let write = fs.write("boot.txt", &format!("{:?}", boot.to_string()), 0);
    expect(write == 0, "boot counter write")?;

    // Text + append round-trip.
    expect(fs.write("notes/hello.md", "\"# hi\"", 0) == 0, "write text")?;
    expect(fs.write("notes/hello.md", "\" there\"", 1) == 0, "append text")?;
    let read = parse(&fs.read("notes/hello.md", 0, 64))?;
    expect(read["size"].as_i64() == Some(10), "size after append")?;
    expect(read["eof"].as_bool() == Some(true), "eof")?;

    // Bytes round-trip via the {"$b": base64} spelling.
    expect(
        fs.write("raw.bin", r#"{"$b":"AAEC/w=="}"#, 0) == 0,
        "write bytes",
    )?;
    let stat = parse(&fs.stat("raw.bin"))?;
    expect(stat["size"].as_i64() == Some(4), "bytes size")?;

    // list is name-sorted; mkdir/rename/remove behave. (Listing a fresh
    // subdirectory, not the root — the root also holds the db module's
    // ordinary files, main.sqlite and a transient journal.)
    expect(fs.mkdir("assets/img") == 0, "mkdir -p")?;
    expect(fs.rename("raw.bin", "assets/raw.bin") == 0, "rename")?;
    let listing = parse(&fs.list("assets", 0))?;
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .map(|entries| entries.iter().filter_map(|e| e["name"].as_str()).collect())
        .unwrap_or_default();
    anyhow::ensure!(names == ["img", "raw.bin"], "listing sorted: got {names:?}");
    expect(fs.remove("assets", 0) == 1, "non-recursive remove of full dir refused")?;
    expect(fs.remove("assets", 1) == 0, "recursive remove")?;

    // The sandbox refusal holds on-device exactly as in the goldens, and
    // universal names (dot-prefixed, CJK) round-trip on real LittleFS.
    expect(
        parse(&fs.read("../../etc/passwd", 0, 16)).is_err(),
        "traversal refused",
    )?;
    expect(fs.write(".config", "\"k=v\"", 0) == 0, "dot name allowed")?;
    expect(fs.write("笔记/今天.md", "\"你好\"", 0) == 0, "CJK name allowed")?;
    expect(fs.remove("笔记", 1) == 0 && fs.remove(".config", 0) == 0, "cleanup")?;

    let usage = parse(&fs.usage())?;
    log::info!(
        "DATA-SMOKE: fs ok in {:?}; boot {boot}; usedBytes {}",
        started.elapsed(),
        usage["usedBytes"]
    );
    Ok(boot)
}

// --- db: SQLite through the module core over the same data root ------------

fn db_smoke() -> anyhow::Result<()> {
    let started = Instant::now();
    let mut db = DbModule::new(DbStorage::Dir(DATA_ROOT.into()));
    let handle = db.open("main");
    anyhow::ensure!(handle > 0, "db open failed");

    expect(
        db.exec(
            handle,
            "CREATE TABLE IF NOT EXISTS samples (
                 captured_at   INTEGER PRIMARY KEY,
                 total_cents   INTEGER NOT NULL
             );",
        ) == 0,
        "ddl",
    )?;

    // Prior completed runs' rows must still be there, and ONLY whole
    // transactions: a run interrupted mid-transaction (reset, power loss)
    // contributes exactly zero rows. The %288 invariant is SQLite's
    // atomicity witnessed across power cycles, through the module.
    let prior = parse(&db.query(handle, "SELECT COUNT(*) FROM samples", "[]"))?;
    let prior_rows = prior["rows"][0][0].as_i64().unwrap_or(-1);
    expect(prior_rows >= 0 && prior_rows % 288 == 0, "whole transactions only")?;

    // One day of 5-minute samples in one transaction — the flash-wear shape.
    let tx_started = Instant::now();
    expect(db.exec(handle, "BEGIN") == 0, "begin")?;
    for i in 0..288i64 {
        let at = (prior_rows + i) * 300;
        let cents = 1_500_000 + (i % 97) * 137;
        let line = db.query(
            handle,
            "INSERT INTO samples (captured_at, total_cents) VALUES (?, ?)",
            &format!("[{at}, {cents}]"),
        );
        parse(&line)?;
    }
    expect(db.exec(handle, "COMMIT") == 0, "commit")?;
    let tx_elapsed = tx_started.elapsed();

    let agg = parse(&db.query(handle, "SELECT COUNT(*) FROM samples", "[]"))?;
    expect(
        agg["rows"][0][0].as_i64() == Some(prior_rows + 288),
        "aggregate row count",
    )?;

    // The ATTACH refusal holds on-device; the database is an ordinary
    // file in the app's data root.
    expect(
        db.exec(handle, "ATTACH DATABASE '/workspace/x' AS other") == 1,
        "attach refused",
    )?;
    expect(
        std::path::Path::new(DATA_ROOT).join("main.sqlite").is_file(),
        "db is an ordinary file in the data root",
    )?;

    log::info!(
        "DATA-SMOKE: db ok in {:?} (288-row tx {tx_elapsed:?})",
        started.elapsed()
    );
    Ok(())
}

// --- small helpers ----------------------------------------------------------

/// Parse one op result line; an {"error": ...} shape becomes an Err.
fn parse(line: &str) -> anyhow::Result<Json> {
    let value: Json = serde_json::from_str(line)?;
    match value.get("error").and_then(Json::as_str) {
        Some(error) => anyhow::bail!("op error: {error}"),
        None => Ok(value),
    }
}

/// Minimal base64 decode (standard alphabet, padded) — enough for the boot
/// counter without pulling a crate into the example.
fn base64_decode(s: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let value = |c: u8| ALPHABET.iter().position(|&a| a == c).unwrap_or(0) as u32;
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c) << (18 - 6 * i);
        }
        for i in 0..chunk.len().saturating_sub(1) {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

// --- LittleFS mount (the pocket-pi firmware's semantics: format only a
// blank partition, never a corrupted one) -----------------------------------

type WorkspaceMount = MountedLittlefs<Littlefs<()>>;

fn mount_workspace() -> anyhow::Result<WorkspaceMount> {
    let fs = unsafe { Littlefs::<()>::new_partition("workspace")? };
    match MountedLittlefs::mount(fs, WORKSPACE_ROOT) {
        Ok(mounted) => Ok(mounted),
        Err(_mount_error) if partition_is_blank()? => {
            let mut fs = unsafe { Littlefs::<()>::new_partition("workspace")? };
            fs.format()?;
            MountedLittlefs::mount(fs, WORKSPACE_ROOT).map_err(Into::into)
        }
        Err(mount_error) => Err(anyhow::anyhow!(
            "LittleFS workspace mount failed; preserving non-blank partition: {mount_error}"
        )),
    }
}

fn partition_is_blank() -> anyhow::Result<bool> {
    let partition = unsafe {
        esp_idf_svc::sys::esp_partition_find_first(
            esp_idf_svc::sys::esp_partition_type_t_ESP_PARTITION_TYPE_DATA,
            esp_idf_svc::sys::esp_partition_subtype_t_ESP_PARTITION_SUBTYPE_DATA_LITTLEFS,
            c"workspace".as_ptr(),
        )
    };
    if partition.is_null() {
        anyhow::bail!("LittleFS workspace partition is missing");
    }
    let mut prefix = [0u8; 4096];
    let status = unsafe {
        esp_idf_svc::sys::esp_partition_read(partition, 0, prefix.as_mut_ptr().cast(), prefix.len())
    };
    if status != esp_idf_svc::sys::ESP_OK {
        anyhow::bail!("read LittleFS workspace partition: ESP error {status}");
    }
    Ok(prefix.iter().all(|byte| *byte == 0xff))
}
