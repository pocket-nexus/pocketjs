//! Pocket Studio on the TrimUI Smart Pro. The room, the UI, the agent loop, voice
//! recognition and every game run on this console; the only network traffic is
//! the model's HTTPS.
// Off the device only `--agent-cli` and the unit tests run.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[cfg(target_os = "linux")]
mod audio;
#[cfg(target_os = "linux")]
mod cjk;
#[cfg(target_os = "linux")]
mod egl;
#[cfg(target_os = "linux")]
mod overlay;
#[cfg(target_os = "linux")]
mod pad;
#[cfg(target_os = "linux")]
mod room;
#[cfg(target_os = "linux")]
mod studio;

mod agent;
mod auth;
mod files;
mod library;
mod llm;
mod mic;

use std::path::PathBuf;

#[allow(dead_code)] // The export defines every fact; the program reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}

const DEFAULT_DATA: &str = "/mnt/UDISK/pocket-studio";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let data = PathBuf::from(value("--data").unwrap_or_else(|| DEFAULT_DATA.to_owned()));
    let outcome = if let Some(prompt) = value("--agent-cli") {
        let directory =
            PathBuf::from(value("--game").unwrap_or_else(|| "/tmp/pocket-studio-cli".to_owned()));
        agent::cli(&prompt, &data, &directory)
    } else {
        run(&args, data)
    };
    if let Err(error) = outcome {
        eprintln!("pocket-studio: {error:#}");
        std::process::exit(1);
    }
}

/// The engine's `log` records, on stderr with the program's own messages.
#[cfg(target_os = "linux")]
struct StderrLog;

#[cfg(target_os = "linux")]
impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("pocket-studio: {}: {}", record.level(), record.args());
        }
    }
    fn flush(&self) {}
}

#[cfg(target_os = "linux")]
fn run(args: &[String], data: PathBuf) -> anyhow::Result<()> {
    static LOG: StderrLog = StderrLog;
    let _ = log::set_logger(&LOG);
    log::set_max_level(log::LevelFilter::Warn);
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let profile = profile::profile()
        .ok_or_else(|| anyhow::anyhow!("no profile was exported for this build"))?;
    let options = studio::Options {
        package: PathBuf::from(
            value("--package").unwrap_or_else(|| format!("{}/studio.pocket", data.display())),
        ),
        font: value("--font").unwrap_or_else(|| "/usr/trimui/res/full.ttf".to_owned()),
        control: PathBuf::from(
            value("--control").unwrap_or_else(|| "/tmp/pocket-studio.ctl".to_owned()),
        ),
        play: value("--play"),
        data,
    };
    let mut studio = unsafe {
        studio::Studio::open(&options, profile, profile::HOST_ABI, profile::PROFILE_HASH)?
    };
    extern "C" fn stop(_: libc::c_int) {
        STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    unsafe {
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
    }
    while !studio.quit && !STOP.load(std::sync::atomic::Ordering::Relaxed) {
        studio.frame()?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(not(target_os = "linux"))]
fn run(_: &[String], _: PathBuf) -> anyhow::Result<()> {
    anyhow::bail!("the room needs the console's display: this build only runs --agent-cli")
}
