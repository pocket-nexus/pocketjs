use pocketjs_core::spec;
use pocketjs_vita::{graphics, input, switch, vita_log, Runtime};

#[cfg(feature = "bench")]
mod bench;

#[cfg(feature = "capture")]
static CAPTURE_INPUT: &str = env!("POCKETJS_CAPTURE_INPUT");
#[cfg(feature = "capture")]
static CAPTURE_TOUCH: &str = env!("POCKETJS_CAPTURE_TOUCH");
#[cfg(feature = "capture")]
static CAPTURE_FRAMES: &str = env!("POCKETJS_CAPTURE_FRAMES");
#[cfg(feature = "capture")]
static CAPTURE_DIR: &str = env!("POCKETJS_CAPTURE_DIR");

#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 2 * 1024 * 1024;

/// Process-global frame identity. Guest relaunches must not restart capture
/// input or overwrite files from the previous app.
static mut GLOBAL_FRAME: u32 = 0;

#[cfg(feature = "capture")]
fn scripted_buttons(frame: u32) -> i32 {
    let mut buttons = 0;
    let mut latest = None;
    for item in CAPTURE_INPUT.split(',') {
        let Some((at, mask)) = item.split_once(':') else {
            continue;
        };
        let Some(at) = at.parse::<u32>().ok().filter(|at| *at <= frame) else {
            continue;
        };
        if latest.is_none_or(|previous| at >= previous) {
            latest = Some(at);
            buttons = if let Some(hex) = mask.strip_prefix("0x") {
                i32::from_str_radix(hex, 16).unwrap_or(0)
            } else {
                mask.parse::<i32>().unwrap_or(0)
            };
        }
    }
    buttons
}

/// Level-triggered touch script, the threshold convention of
/// `scripted_buttons`: entries `frame:id,x,y[+id,x,y…]` joined by `;`,
/// `frame:-` releases (tests/golden-specs.ts `encodeTouchInput`).
#[cfg(feature = "capture")]
fn scripted_touches(frame: u32) -> pocketjs_vita::input::TouchSnapshot {
    let mut latest: Option<(u32, &str)> = None;
    for item in CAPTURE_TOUCH.split(';') {
        let Some((at, spec)) = item.split_once(':') else {
            continue;
        };
        let Some(at) = at.parse::<u32>().ok().filter(|at| *at <= frame) else {
            continue;
        };
        if latest.is_none_or(|(previous, _)| at >= previous) {
            latest = Some((at, spec));
        }
    }
    let Some((_, spec)) = latest else {
        return pocketjs_vita::input::TouchSnapshot::EMPTY;
    };
    if spec == "-" {
        return pocketjs_vita::input::TouchSnapshot::EMPTY;
    }
    let mut contacts: Vec<(u8, u16, u16)> = Vec::new();
    for triple in spec.split('+') {
        let mut parts = triple.split(',');
        let (Some(id), Some(x), Some(y)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(id), Ok(x), Ok(y)) = (id.parse::<u8>(), x.parse::<u16>(), y.parse::<u16>()) else {
            continue;
        };
        contacts.push((id, x, y));
    }
    pocketjs_vita::input::TouchSnapshot::from_logical(&contacts, [graphics::LOGICAL_W,graphics::LOGICAL_H])
}

#[cfg(feature = "capture")]
fn capture_frames() -> Vec<u32> {
    CAPTURE_FRAMES
        .split(',')
        .filter_map(|value| value.parse::<u32>().ok())
        .collect()
}

fn fail(message: &str) -> ! {
    vita_log(format_args!("[PocketJS Vita] {message}"));
    #[cfg(feature = "capture")]
    {
        let _ = std::fs::create_dir_all(CAPTURE_DIR);
        let _ = std::fs::write(format!("{CAPTURE_DIR}/error.txt"), message);
    }
    loop {
        std::thread::yield_now();
    }
}

/// Boot one embedded guest, or app0:app.pkb in the generic runtime.
unsafe fn boot_guest(app_index: usize) -> Result<Runtime, String> {
    let mut runtime = Runtime::new()?;
    let started = match switch::guest(app_index) {
        Ok(switch::GuestBytes::Package(bytes)) => runtime.eval_package(bytes),
        #[cfg(feature="runtime")]
        // A missing app.pkb must still reach the shutdown below: a `?` here would drop
        // the runtime with its guest still marked active.
        Ok(switch::GuestBytes::File) => pocketjs_vita::package_file::source().and_then(|source| runtime.eval_source(source)),
        Err(error) => Err(error),
    };
    if let Err(error) = started {
        runtime.shutdown();
        return Err(error);
    }
    Ok(runtime)
}

/// Drive one guest until an app switch is requested, then retire it at a
/// closed-scene boundary and return the next table index. A guest that fails
/// to boot or to run leaves its error on screen.
unsafe fn run_guest(app_index: usize) -> usize {
    switch::set_current(app_index);
    let mut error = String::new();
    let mut runtime = boot_guest(app_index).map_err(|e| error = e).ok();

    // A newly booted guest starts latched. If SELECT is still held from the
    // launcher action that booted it, require a release before it can summon.
    let mut previous_select = true;
    #[cfg(feature = "bench")]
    let mut benchmark = bench::Bench::new();
    #[cfg(feature = "capture")]
    let wanted = capture_frames();
    #[cfg(feature = "capture")]
    let last_capture = wanted.iter().copied().max().unwrap_or(0);

    loop {
        #[cfg(feature = "bench")]
        benchmark.begin();
        #[cfg(feature = "capture")]
        let (mut buttons, analog, touches) = (
            scripted_buttons(GLOBAL_FRAME),
            spec::ANALOG_CENTER as i32,
            scripted_touches(GLOBAL_FRAME),
        );
        #[cfg(not(feature = "capture"))]
        let (mut buttons, analog, touches) = {
            let pad = input::read();
            (pad.buttons as i32, pad.left_analog(), input::read_touches([graphics::LOGICAL_W, graphics::LOGICAL_H]))
        };

        // SELECT is a host-owned summon chord only in non-launcher guests.
        // Strip it from their guest ABI and schedule the swap on its press edge.
        if switch::multi() && app_index != 0 {
            let select_now = buttons & spec::btn::SELECT as i32 != 0;
            if select_now && !previous_select {
                switch::request_summon();
            }
            previous_select = select_now;
            buttons &= !(spec::btn::SELECT as i32);
        }

        if let Some(guest) = runtime.as_mut() {
            if let Err(failure) = guest.frame_with_input(buttons, analog, &touches) {
                runtime.take().unwrap().shutdown();
                switch::cancel_pending();
                error = failure;
            }
        }
        if let Some(guest) = runtime.as_mut() {
            guest.render();
        } else {
            graphics::begin_frame(0xff1c_1410);
            pocketjs_vita::overlay::notice(&error);
            graphics::present();
        }
        #[cfg(feature = "bench")]
        if let Err(error) = benchmark.end(GLOBAL_FRAME) {
            vita_log(format_args!("Vita benchmark: {error}"));
        }

        #[cfg(feature = "capture")]
        if wanted.contains(&GLOBAL_FRAME) {
            let stem = format!("{CAPTURE_DIR}/f{:04}", GLOBAL_FRAME);
            // No guest to capture (a refused app.pkb, a failed boot):
            // report its error to the capture harness instead.
            let Some(guest) = runtime.as_mut() else {
                fail(&error)
            };
            guest
                .capture_golden(&format!("{stem}.rgba"))
                .unwrap_or_else(|error| fail(&error.to_string()));
            std::fs::write(format!("{stem}.json"), switch::frame_json(app_index))
                .unwrap_or_else(|error| fail(&error.to_string()));
        }

        #[cfg(feature = "capture")]
        if GLOBAL_FRAME >= last_capture {
            let _ = std::fs::create_dir_all(CAPTURE_DIR);
            let _ = std::fs::write(format!("{CAPTURE_DIR}/done"), b"ok\n");
            // Vita3K 0.2.1/macOS can fault while tearing down GXM from
            // sceKernelExitProcess. The E2E host owns process lifetime.
            loop {
                std::thread::yield_now();
            }
        }

        // appLaunch/SELECT requests become visible only after the outgoing
        // current frame has presented. A summon additionally freezes that
        // DrawList before the outgoing core is dropped.
        if let Some((next, summon)) = switch::take_pending() {
            if summon {
                if let Some(guest) = runtime.as_mut() {
                    guest.capture_switch_shot();
                }
            }
            GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
            if let Some(guest) = runtime.take() {
                guest.shutdown();
            }
            return next;
        }

        GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
    }
}

fn main() {
    unsafe {
        graphics::init().unwrap_or_else(|error| fail(error));
        input::init();
        let mut next = 0usize;
        loop {
            next = run_guest(next);
        }
    }
}
