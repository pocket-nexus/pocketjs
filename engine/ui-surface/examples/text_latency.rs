//! Real QuickJS -> bounded native offload worker -> frame-boundary delivery.
//! The JS driver and package paths are supplied by tools/text-latency.ts.
use anyhow::{Result, anyhow};
use pocket_mod::Guest;
use pocket_ui_surface::offload::OffloadWorker;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let source = std::fs::read_to_string(args.get(1).ok_or_else(|| anyhow!("driver required"))?)?;
    let pak = std::fs::read(args.get(2).ok_or_else(|| anyhow!("pak required"))?)?;
    let compute = Arc::new(AtomicU64::new(0));
    let requests = Arc::new(AtomicU64::new(0));
    let c = compute.clone();
    let r = requests.clone();
    let worker = OffloadWorker::spawn(move || {
        let mut engine = pocket_text::Engine::new();
        engine.load_pak(&pak);
        move |record: &str| {
            let started = Instant::now();
            let result = engine.reply(record);
            c.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
            r.fetch_add(1, Ordering::Relaxed);
            result
        }
    });
    let guest = Guest::new()?;
    worker.mount(&guest)?;
    guest.eval("driver", &source)?;
    // Font loading precedes measurements; the guest still observes readiness.
    for _ in 0..600 {
        let ready: bool = guest.with(|ctx| ctx.eval("offload.session()>0").unwrap());
        if ready {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let count: usize = guest.with(|ctx| ctx.globals().get("caseCount").unwrap());
    for index in 0..count {
        let before_compute = compute.load(Ordering::Relaxed);
        let before_requests = requests.load(Ordering::Relaxed);
        guest.eval("start", &format!("startCase({index})"))?;
        let started = Instant::now();
        let mut frames = 0;
        loop {
            let deadline = started + Duration::from_nanos(1_000_000_000 / 60) * (frames + 1);
            if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            worker.begin_frame();
            guest.frame(0)?;
            frames += 1;
            let status: String = guest.with(|ctx| ctx.globals().get("layoutStatus").unwrap());
            if status == "error" {
                return Err(anyhow!("layout failed"));
            }
            if status == "ready" {
                break;
            }
            if frames >= 600 {
                return Err(anyhow!("layout timeout"));
            }
        }
        let label: String = guest.with(|ctx| ctx.globals().get("caseLabel").unwrap());
        println!(
            "{}",
            serde_json::json!({"case":label,"frames":frames,"ms":started.elapsed().as_secs_f64()*1000.0,
            "requests":requests.load(Ordering::Relaxed)-before_requests,
            "workerMs":(compute.load(Ordering::Relaxed)-before_compute) as f64/1_000_000.0})
        );
    }
    Ok(())
}
