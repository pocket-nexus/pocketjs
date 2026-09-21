use pocketjs_core::spec;
use pocketjs_vita::{
    dev,
    dev_protocol::{Bundle, Op},
    devmenu::Action,
    graphics, input, switch, vita_log, Runtime,
};
use std::sync::Arc;

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
    pocketjs_vita::input::TouchSnapshot::from_logical(&contacts)
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

/// Boot one embedded guest, drive it until an app switch is requested, then
/// retire it at a closed-scene boundary and return the next table index.
unsafe fn boot_guest(app_index: usize, active: &Option<Arc<Bundle>>) -> Result<Runtime, String> {
    let mut runtime = if let Some(bundle) = active {
        Runtime::with_owned_pak(bundle.pak.clone())?
    } else {
        Runtime::new(
            switch::guest_bytes(app_index)
                .ok_or("embedded package unreadable")?
                .pak,
        )?
    };
    let js = active
        .as_ref()
        .map(|b| b.js.as_str())
        .unwrap_or_else(|| switch::guest_bytes(app_index).unwrap().js);
    if let Err(error) = runtime.eval(js) {
        runtime.shutdown();
        return Err(error);
    }
    Ok(runtime)
}

fn embedded_hash(app_index: usize) -> String {
    switch::guest_bytes(app_index)
        .map(|guest| {
            let js = guest.js.as_bytes();
            let js = js.strip_suffix(&[0]).unwrap_or(js);
            format!("{:016x}", pocketjs_core::package::fnv1a64(&[js, guest.pak]))
        })
        .unwrap_or_else(|| "unavailable".into())
}

unsafe fn run_guest(app_index: usize, dev: &mut dev::Host) -> usize {
    switch::set_current(app_index);
    dev.active_hash = embedded_hash(app_index);
    dev.error.clear();
    let mut active: Option<Arc<Bundle>> = None;
    let mut runtime = boot_guest(app_index, &active)
        .map_err(|e| {
            dev.error = e;
            dev.menu.visible = true;
        })
        .ok();
    // Retain the last admitted bundle until the candidate produces its first frame.
    let mut pending: Option<(Option<dev::Request>, Option<Arc<Bundle>>, String)> = None;

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
        let current_frame = GLOBAL_FRAME;
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
            (pad.buttons as i32, pad.left_analog(), input::read_touches())
        };
        let (filtered, action) = dev.menu.input(buttons as u32);
        buttons = filtered as i32;
        let touches = if dev.menu.visible {
            input::TouchSnapshot::EMPTY
        } else {
            touches
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
            if let Err(error) = guest.frame_with_input(
                buttons,
                if dev.menu.visible {
                    spec::ANALOG_CENTER as i32
                } else {
                    analog
                },
                &touches,
            ) {
                runtime.take().unwrap().shutdown();
                switch::cancel_pending();
                if let Some((request, previous, hash)) = pending.take() {
                    active = previous;
                    dev.active_hash = hash;
                    runtime = boot_guest(app_index, &active).ok();
                    if let Some(request) = request {
                        request.finish(Err(format!(
                            "candidate frame failed; previous guest restored: {error}"
                        )));
                    }
                }
                dev.error = error;
                dev.menu.visible = true;
            }
        }
        if let Some(guest) = runtime.as_mut() {
            guest.tick();
            guest.render();
        } else {
            graphics::begin_frame(0xff1c_1410);
        }
        dev.overlay();
        graphics::present();
        if pending.is_some() {
            vita2d_sys::vita2d_wait_rendering_done();
        }
        if let Some((request, _, _)) = pending.take() {
            dev.generation += 1;
            dev.error.clear();
            if let Some(request) = request {
                request.finish(Ok(serde_json::json!({"generation":dev.generation,"bundle":dev.active_hash,"frame":current_frame,"nativeBuild":dev::NATIVE_BUILD})));
            }
        }
        dev.publish(GLOBAL_FRAME, switch::APPS[app_index].output);
        #[cfg(feature = "bench")]
        if let Err(error) = benchmark.end(GLOBAL_FRAME) {
            vita_log(format_args!("Vita benchmark: {error}"));
        }

        #[cfg(feature = "capture")]
        if wanted.contains(&GLOBAL_FRAME) {
            let stem = format!("{CAPTURE_DIR}/f{:04}", GLOBAL_FRAME);
            runtime
                .as_mut()
                .unwrap()
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

        let mut request = dev.poll();
        let op = request.as_ref().map(|r| r.command.op).or(match action {
            Action::Reload => Some(Op::Reload),
            Action::Reset => Some(Op::Reset),
            Action::Capture => Some(Op::Capture),
            Action::None => None,
        });
        match op {
            Some(Op::Status) => {
                request
                    .take()
                    .unwrap()
                    .finish(Ok(dev.status(current_frame, switch::APPS[app_index].output)));
            }
            Some(Op::Menu) => {
                dev.menu.visible = !dev.menu.visible;
                request
                    .take()
                    .unwrap()
                    .finish(Ok(serde_json::json!({"menu":dev.menu.visible})));
            }
            Some(Op::Capture) => {
                if let Some(request) = request.take() {
                    let _ = request.reply.try_send(dev.capture(GLOBAL_FRAME));
                } else {
                    dev.capture_from_menu(GLOBAL_FRAME);
                }
            }
            Some(Op::Push | Op::Reload | Op::Reset) => {
                if app_index != 0 && op == Some(Op::Push) {
                    request
                        .take()
                        .unwrap()
                        .finish(Err("return to the VPK's main guest before updating".into()));
                } else {
                    let previous = active.clone();
                    let hash = dev.active_hash.clone();
                    if op == Some(Op::Push) {
                        active = request.as_mut().unwrap().bundle.take().map(Arc::new);
                    }
                    if op == Some(Op::Reset) {
                        active = None;
                    }
                    if let Some(guest) = runtime.take() {
                        guest.shutdown();
                    }
                    switch::cancel_pending();
                    match boot_guest(app_index, &active) {
                        Ok(guest) => {
                            runtime = Some(guest);
                            dev.active_hash = active
                                .as_ref()
                                .map(|b| b.hash.clone())
                                .unwrap_or_else(|| embedded_hash(app_index));
                            pending = Some((request.take(), previous, hash));
                        }
                        Err(error) => {
                            active = previous;
                            runtime = boot_guest(app_index, &active).ok();
                            dev.error = error.clone();
                            dev.menu.visible = true;
                            if let Some(request) = request.take() {
                                request.finish(Err(format!(
                                    "candidate boot failed; previous guest restored: {error}"
                                )));
                            }
                        }
                    }
                }
            }
            Some(Op::Native) => {
                let request = request.take().unwrap();
                if let Some(guest) = runtime.take() {
                    guest.shutdown();
                }
                let result = dev::exec_native(request.native_path.as_ref().unwrap());
                runtime = boot_guest(app_index, &active).ok();
                request.finish(result.map(|_| serde_json::json!({})));
            }
            None => {}
        }

        GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
    }
}

fn main() {
    unsafe {
        graphics::init().unwrap_or_else(|error| fail(error));
        input::init();
        let mut dev = dev::Host::new();
        let mut next = 0usize;
        loop {
            next = run_guest(next, &mut dev);
        }
    }
}
