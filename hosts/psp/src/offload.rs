//! Bounded offload over PSPLINK host0. The lower-priority native worker owns
//! every file operation; UI entry points only exchange fixed slots. The
//! worker never touches QuickJS, Ui, GE, or the single-thread global allocator.
use crate::offload_packet as pkt;
use core::{
    cell::UnsafeCell,
    ffi::c_void,
    sync::atomic::{
        AtomicU32,
        Ordering::{Acquire, Relaxed, Release},
    },
};
use psp::sys::{self, IoOpenFlags, SceUid};
const N: usize = 8;
// FREE -> QUEUED -> SENT -> READY -> BORROWED -> FREE. The UI publishes
// requests as QUEUED; the worker owns QUEUED/SENT even across USB stalls.
const FREE: u32 = 0;
const QUEUED: u32 = 1;
const SENT: u32 = 2;
const READY: u32 = 3;
const BORROWED: u32 = 4;
#[repr(C, align(16))]
struct SlotData {
    generation: u32,
    seq: u32,
    len: usize,
    req: [u8; 4096],
    header: [u8; 64],
    data: [u8; 4096],
}
struct Slot {
    state: AtomicU32,
    data: UnsafeCell<SlotData>,
}
// A release/acquire state transition transfers exclusive ownership of data.
// UI accesses FREE/READY/BORROWED, the worker accesses QUEUED/SENT only.
unsafe impl Sync for Slot {}
impl Slot {
    const fn new() -> Self {
        Self {
            state: AtomicU32::new(FREE),
            data: UnsafeCell::new(SlotData {
                generation: 0,
                seq: 0,
                len: 0,
                req: [0; 4096],
                header: [0; 64],
                data: [0; 4096],
            }),
        }
    }
}
static SLOTS: [Slot; N] = [const { Slot::new() }; N];
static LAST_CONTACT: AtomicU32 = AtomicU32::new(0);
static SESSION: AtomicU32 = AtomicU32::new(0);
static RESET: AtomicU32 = AtomicU32::new(0);
static FRAMES: AtomicU32 = AtomicU32::new(0);
static CPU: AtomicU32 = AtomicU32::new(0);
static MAX_CPU: AtomicU32 = AtomicU32::new(0);
static LATE: AtomicU32 = AtomicU32::new(0);
static STAGES: [AtomicU32; 3] = [const { AtomicU32::new(0) }; 3];
pub fn stages(js: u32, core: u32, ge: u32) {
    for (s, v) in STAGES.iter().zip([js, core, ge]) {
        s.store(v, Relaxed);
    }
}
static GPU_WAIT: AtomicU32 = AtomicU32::new(0);
pub fn gpu_wait(us: u32) {
    GPU_WAIT.store(us, Relaxed);
}
static BUTTONS: AtomicU32 = AtomicU32::new(0);
static ANALOG: AtomicU32 = AtomicU32::new(0);
static mut ROOT: [u8; 128] = [0; 128];
static mut ROOT_LEN: usize = 0;
static mut BOOT: u32 = 0;
static mut SEQUENCE: u32 = 0;
static mut STARTED: bool = false;
static mut SENT_FRAME: u32 = 0;
static mut TAKEN_FRAME: u32 = u32::MAX;
pub fn enabled() -> bool {
    !env!("POCKETJS_OFFLOAD_SLOT").is_empty()
}
pub unsafe fn start() {
    if STARTED || !enabled() {
        return;
    }
    STARTED = true;
    BOOT = sys::sceKernelGetSystemTimeLow().max(1);
    // Only boot initialization allocates; the lower-priority worker never does.
    let root = alloc::format!("host0:/pocket-offload/{}/", env!("POCKETJS_OFFLOAD_SLOT"));
    ROOT_LEN = root.len();
    ROOT[..ROOT_LEN].copy_from_slice(root.as_bytes());
    let th = sys::sceKernelCreateThread(
        b"pocket-offload\0".as_ptr(),
        worker,
        0x30,
        32768,
        sys::ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if th.0 >= 0 {
        sys::sceKernelStartThread(th, 0, core::ptr::null_mut());
    }
}
pub fn session() -> i32 {
    if unsafe { sys::sceKernelGetSystemTimeLow() }.wrapping_sub(LAST_CONTACT.load(Acquire))
        > 3000000
    {
        0
    } else {
        SESSION.load(Acquire) as i32
    }
}
pub fn frame(buttons: u32, analog: u32) {
    FRAMES.fetch_add(1, Relaxed);
    BUTTONS.store(buttons, Relaxed);
    ANALOG.store(analog, Relaxed);
}
pub fn timing(us: u32) {
    CPU.store(us, Relaxed);
    MAX_CPU.fetch_max(us, Relaxed);
    if us > 16667 {
        LATE.fetch_add(1, Relaxed);
    }
}
pub unsafe fn reset() {
    SESSION.store(0, Release);
    for slot in &SLOTS {
        let state = slot.state.load(Acquire);
        if state == READY || state == BORROWED {
            slot.state.store(FREE, Release);
        }
    }
    RESET.fetch_add(1, Release);
}
pub unsafe fn submit(bytes: &[u8]) -> bool {
    if session() <= 0 || bytes.is_empty() || bytes.len() > 4096 {
        return false;
    }
    let f = FRAMES.load(Relaxed);
    if SENT_FRAME == f {
        return false;
    }
    for slot in &SLOTS {
        if slot.state.load(Acquire) == FREE {
            let s = &mut *slot.data.get();
            s.generation = SESSION.load(Acquire);
            SEQUENCE = SEQUENCE.wrapping_add(1).max(1);
            s.seq = SEQUENCE;
            s.len = bytes.len();
            s.req[..bytes.len()].copy_from_slice(bytes);
            slot.state.store(QUEUED, Release);
            SENT_FRAME = f;
            return true;
        }
    }
    false
}
pub unsafe fn take() -> Option<alloc::string::String> {
    let f = FRAMES.load(Relaxed);
    if TAKEN_FRAME == f {
        return None;
    }
    for slot in &SLOTS {
        if slot.state.load(Acquire) == READY {
            let s = &*slot.data.get();
            if s.generation != SESSION.load(Acquire) {
                slot.state.store(FREE, Release);
                continue;
            }
            TAKEN_FRAME = f;
            let kind = pkt::word(&s.header, 16);
            let len = pkt::word(&s.header, 32) as usize;
            if kind == 0 {
                let value = core::str::from_utf8(&s.data[..len])
                    .ok()
                    .map(alloc::string::String::from);
                slot.state.store(FREE, Release);
                return value;
            }
            slot.state.store(FREE, Release);
        }
    }
    None
}
unsafe fn path(name: &[u8]) -> [u8; 160] {
    let mut b = [0; 160];
    b[..ROOT_LEN].copy_from_slice(&ROOT[..ROOT_LEN]);
    b[ROOT_LEN..ROOT_LEN + name.len()].copy_from_slice(name);
    b
}
unsafe fn read(fd: SceUid, b: &mut [u8]) -> bool {
    let mut n = 0;
    while n < b.len() {
        let k = sys::sceIoRead(
            fd,
            b.as_mut_ptr().add(n) as *mut c_void,
            (b.len() - n).min(16384) as u32,
        );
        if k <= 0 {
            return false;
        }
        n += k as usize;
    }
    true
}
unsafe fn write(fd: SceUid, b: &[u8]) -> bool {
    let mut n = 0;
    while n < b.len() {
        let k = sys::sceIoWrite(
            fd,
            b.as_ptr().add(n) as *const c_void,
            (b.len() - n).min(16384),
        );
        if k <= 0 {
            return false;
        }
        n += k as usize;
    }
    true
}
unsafe fn open(name: &[u8], write: bool) -> SceUid {
    let p = path(name);
    sys::sceIoOpen(
        p.as_ptr(),
        if write {
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC
        } else {
            IoOpenFlags::RD_ONLY
        },
        0o666,
    )
}
unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    let mut epoch = 0;
    let mut beat = 0;
    let mut last_beat = 0;
    let mut last_poll = 0;
    let mut reset = 0;
    let mut generation = 0;
    let mut stats_at = 0;
    loop {
        let now = sys::sceKernelGetSystemTimeLow();
        let wanted = RESET.load(Acquire);
        if wanted != reset {
            reset = wanted;
            epoch = 0;
            for slot in &SLOTS {
                let state = slot.state.load(Acquire);
                if state == QUEUED || state == SENT {
                    slot.state.store(FREE, Release);
                }
            }
        }
        if now.wrapping_sub(last_poll) >= 50000 {
            last_poll = now;
            let fd = open(b"ready", false);
            let mut h = [0; 64];
            let ok = fd.0 >= 0 && read(fd, &mut h);
            if fd.0 >= 0 {
                sys::sceIoClose(fd);
            }
            if ok && pkt::word(&h, 0) == pkt::MAGIC {
                if pkt::word(&h, 4) != epoch {
                    epoch = pkt::word(&h, 4);
                    SESSION.store(0, Release);
                    generation = (generation + 1) & 0x7fffffff;
                    if generation == 0 {
                        generation = 1;
                    }
                    for slot in &SLOTS {
                        let state = slot.state.load(Acquire);
                        if state == QUEUED || state == SENT {
                            slot.state.store(FREE, Release);
                        }
                    }
                    SESSION.store(generation, Release);
                }
                if pkt::word(&h, 8) != beat {
                    beat = pkt::word(&h, 8);
                    last_beat = now;
                    LAST_CONTACT.store(now, Release);
                }
            }
            if !ok || now.wrapping_sub(last_beat) > 3000000 {
                SESSION.store(0, Release);
                epoch = 0;
            }
        }
        if epoch != 0 {
            for (i, slot) in SLOTS.iter().enumerate() {
                let state = slot.state.load(Acquire);
                if state != QUEUED && state != SENT {
                    continue;
                }
                let s = &mut *slot.data.get();
                if s.generation != generation {
                    slot.state.store(FREE, Release);
                    continue;
                }
                if state == QUEUED {
                    let mut h = [0; 64];
                    for (p, v) in [
                        (0, pkt::MAGIC),
                        (4, epoch),
                        (8, BOOT),
                        (12, s.seq),
                        (32, s.len as u32),
                        (36, pkt::hash(&s.req[..s.len])),
                    ] {
                        pkt::put(&mut h, p, v);
                    }
                    let fd = open(&[b'r', b'e', b'q', b'0' + i as u8], true);
                    let ok = fd.0 >= 0 && write(fd, &h) && write(fd, &s.req[..s.len]);
                    if fd.0 >= 0 {
                        sys::sceIoClose(fd);
                    }
                    if ok {
                        slot.state.store(SENT, Release);
                    } else {
                        SESSION.store(0, Release);
                        epoch = 0;
                        break;
                    }
                }
                if slot.state.load(Acquire) == SENT {
                    let fd = open(&[b'r', b'e', b's', b'0' + i as u8], false);
                    if fd.0 < 0 {
                        continue;
                    }
                    let mut h = [0; 64];
                    let ok = read(fd, &mut h) && pkt::valid(&h, epoch, BOOT, s.seq);
                    if ok {
                        let len = pkt::word(&h, 32) as usize;
                        if read(fd, &mut s.data[..len])
                            && pkt::hash(&s.data[..len]) == pkt::word(&h, 36)
                        {
                            s.header = h;
                            slot.state.store(READY, Release);
                        }
                    }
                    sys::sceIoClose(fd);
                }
            }
            if now.wrapping_sub(stats_at) > 2000000 {
                stats_at = now;
                let mut b = [0u8; 256];
                let mut cursor = 0;
                for (key, value) in [
                    (b"frames=" as &[u8], FRAMES.load(Relaxed)),
                    (b" cpuUs=", CPU.load(Relaxed)),
                    (b" maxCpuUs=", MAX_CPU.load(Relaxed)),
                    (b" late=", LATE.load(Relaxed)),
                    (b" buttons=", BUTTONS.load(Relaxed)),
                    (b" analog=", ANALOG.load(Relaxed)),
                    (b" jsUs=", STAGES[0].load(Relaxed)),
                    (b" coreUs=", STAGES[1].load(Relaxed)),
                    (b" geUs=", STAGES[2].load(Relaxed)),
                    (b" gpuWaitUs=", GPU_WAIT.load(Relaxed)),
                ] {
                    b[cursor..cursor + key.len()].copy_from_slice(key);
                    cursor += key.len();
                    let mut digits = [0u8; 10];
                    let mut v = value;
                    let mut n = 10;
                    loop {
                        n -= 1;
                        digits[n] = b'0' + (v % 10) as u8;
                        v /= 10;
                        if v == 0 {
                            break;
                        }
                    }
                    b[cursor..cursor + 10 - n].copy_from_slice(&digits[n..]);
                    cursor += 10 - n;
                }
                let fd = open(b"stats", true);
                if fd.0 >= 0 {
                    write(fd, &b[..cursor]);
                    sys::sceIoClose(fd);
                }
            }
        }
        sys::sceKernelDelayThread(10000);
    }
}
