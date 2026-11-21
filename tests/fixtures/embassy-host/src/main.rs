use embassy_executor::{Executor, Spawner};
use embassy_time::Timer;
use pocket_embassy::{
    display::{Frame, Transport},
    runner::Ticker,
};
use static_cell::StaticCell;
use std::sync::atomic::{AtomicU32, Ordering};
static HEARTBEATS: AtomicU32 = AtomicU32::new(0);
struct Screen {
    frames: usize,
}
impl Transport for Screen {
    type Error = ();
    async fn write(&mut self, frame: Frame<'_>) -> Result<(), ()> {
        assert_eq!(frame.descriptor.width, 24);
        assert_eq!(frame.pixels.len(), 24 * 16 * 2);
        Timer::after_millis(2).await;
        self.frames += 1;
        Ok(())
    }
}
#[embassy_executor::task]
async fn heartbeat() {
    loop {
        HEARTBEATS.fetch_add(1, Ordering::Relaxed);
        Timer::after_millis(1).await;
    }
}
#[embassy_executor::task]
async fn application() {
    let (mut runtime, mut presenter) = pocket_embassy_host_check::fixture::program(
        pocket_embassy_host_check::fixture::SCRIPT,
        pocket_drivers::spec::BINDING_GENERATION,
    );
    runtime.boot().unwrap();
    let timing = runtime.timing().unwrap();
    assert_eq!(timing.cadence_hz, 30);
    let mut ticker = Ticker::new(timing, 100_000).unwrap();
    let mut screen = Screen { frames: 0 };
    presenter.present(&mut screen).await.unwrap();
    for _ in 0..8 {
        ticker.next().await.unwrap();
        runtime.tick().unwrap();
        presenter.present(&mut screen).await.unwrap();
    }
    let context = runtime.op_context();
    assert_eq!(context.core().unwrap().ui.node_text(3), Some("5:8"));
    runtime.shutdown().unwrap();
    let beats = HEARTBEATS.load(Ordering::Relaxed);
    assert!(beats > 20 && screen.frames >= 2);
    println!(
        "PASS: canonical boot/tick/shutdown, selected cadence=30, display frames={}, heartbeat={beats}",
        screen.frames
    );
    std::process::exit(0);
}
fn main() {
    static EXECUTOR: StaticCell<Executor> = StaticCell::new();
    EXECUTOR.init(Executor::new()).run(|spawner: Spawner| {
        spawner.spawn(heartbeat().unwrap());
        spawner.spawn(application().unwrap());
    });
}
