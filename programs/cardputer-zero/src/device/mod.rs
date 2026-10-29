//! The device API: what the Zero's sensors, radios, microphone, camera and
//! infrared port read and do, as JSON under `http://zero/dev/…` on the
//! program's loopback transport (net.rs). The guest reads one topic at a
//! time (`GET /dev/motion`, `/dev/audio`, …) and posts commands
//! (`POST /dev/ir/send`); nothing here is called from a frame. A sampler
//! thread keeps the motion, battery and system readings fresh so a GET is a
//! copy of the latest snapshot, never a hardware read. Long work (scans,
//! learning a signal, taking a picture) runs on its own thread and the
//! topic's JSON carries its `scanning` / `learning` / `busy` state until it
//! lands.
//!
//! `--mock` answers every topic from synthesized readings (mock.rs) so the
//! program runs headless on any machine.

pub mod camera;
pub mod dsp;
pub mod ir;
pub mod pose;
pub mod speaker;
#[cfg(target_os = "linux")]
pub mod zxing;

mod mock;
#[cfg(target_os = "linux")]
mod linux;

use pose::{MagCalibration, Pose, Vec3};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const G: f32 = 9.81;
/// A field swing per axis that counts as a full turn, µT.
const CALIBRATION_SPAN_UT: f32 = 40.0;
/// Impacts above this deviation from gravity are logged, m/s².
const IMPACT_THRESHOLD: f32 = 8.0;
const IMPACT_LOG: usize = 24;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const BLE_SCAN_SECONDS: u32 = 6;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Network {
    pub ssid: String,
    pub bssid: String,
    pub signal: u8,
    pub freq_mhz: u32,
    pub channel: u32,
    pub security: String,
    pub active: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BleDevice {
    pub address: String,
    pub name: Option<String>,
    pub rssi: Option<i32>,
}

#[derive(Default)]
struct Motion {
    available: bool,
    mag_available: bool,
    accel: Vec3,
    gyro: Vec3,
    mag: Option<Vec3>,
    pose: Pose,
    zero: Option<(f32, f32)>,
    mag_offset: Vec3,
    calibrating: Option<MagCalibration>,
    shake: f32,
    impact_peak: f32,
    impacts: Vec<(f64, f32)>,
    updated: f64,
}

#[derive(Default)]
struct Battery {
    available: bool,
    percent: Option<u8>,
    voltage: Option<f32>,
    current: Option<f32>,
    status: String,
    temp: Option<f32>,
}

#[derive(Default)]
struct System {
    hostname: String,
    uptime: f64,
    load: [f32; 3],
    mem_used: u32,
    mem_total: u32,
    cpu_temp: Option<f32>,
    ip: Option<String>,
    ssid: Option<String>,
    rssi: Option<i32>,
    link: Option<u8>,
    backlight: Option<(u32, u32)>,
    volume: Option<u8>,
    disk: Option<(u64, u64)>,
}

struct Recording {
    name: String,
    started: f64,
    seconds: f32,
}

struct Audio {
    capturing: bool,
    /// The guest asked for a recording; the capture thread opens and
    /// closes the file.
    record_wanted: bool,
    recording: Option<Recording>,
    level_db: f32,
    peak_db: f32,
    spectrum: [f32; dsp::BANDS],
    wave: [f32; dsp::WAVE],
    pitch_hz: Option<f32>,
    recordings: Vec<(String, f32, u64)>,
    /// What the speaker plays, until when.
    playing: Option<(String, Instant)>,
    error: Option<String>,
    blocks: u64,
    /// The `arecord` child while it runs, so `stop` can end it.
    capture_pid: Option<u32>,
    /// The mixer values the capture raised, until they are put back.
    gain_previous: Vec<(String, i64)>,
}

impl Default for Audio {
    fn default() -> Self {
        Self {
            capturing: false,
            record_wanted: false,
            recording: None,
            level_db: dsp::FLOOR_DB,
            peak_db: dsp::FLOOR_DB,
            spectrum: [0.0; dsp::BANDS],
            wave: [0.0; dsp::WAVE],
            pitch_hz: None,
            recordings: Vec::new(),
            playing: None,
            error: None,
            blocks: 0,
            capture_pid: None,
            gain_previous: Vec::new(),
        }
    }
}

struct Captured {
    pulses: Vec<u32>,
    carrier_hz: u32,
    t: f64,
}

#[derive(Clone)]
struct Saved {
    id: u32,
    name: String,
    pulses: Vec<u32>,
    carrier_hz: u32,
}

#[derive(Default)]
struct Ir {
    tx: Option<PathBuf>,
    rx: Option<PathBuf>,
    learning: bool,
    captured: Option<Captured>,
    sending: bool,
    last_sent: Option<(f64, bool, String)>,
    signals: Vec<Saved>,
    next_id: u32,
}

#[derive(Default)]
struct Scan<T> {
    scanning: bool,
    t: Option<f64>,
    items: Vec<T>,
    error: Option<String>,
}

#[derive(Default)]
struct Radio {
    wifi: Scan<Network>,
    ble: Scan<BleDevice>,
}

struct Photo {
    name: String,
    t: f64,
    at: u64,
    width: u32,
    height: u32,
    qr: Option<String>,
    bytes: u64,
}

#[derive(Default)]
struct Camera {
    available: bool,
    qr_available: bool,
    busy: bool,
    preview: Option<Vec<u8>>,
    last: Option<Photo>,
    photos: Vec<(String, u64, f64)>,
    error: Option<String>,
    live: camera::Live,
}

#[derive(Default)]
struct Caps {
    motion: bool,
    magnet: bool,
    battery: bool,
    ir_tx: bool,
    ir_rx: bool,
    audio_capture: bool,
    audio_play: bool,
    camera: bool,
    qr: bool,
    wifi: bool,
    ble: bool,
    backlight: bool,
    volume: bool,
}

#[derive(Default)]
struct State {
    motion: Motion,
    battery: Battery,
    system: System,
    audio: Audio,
    ir: Ir,
    radio: Radio,
    camera: Camera,
    caps: Caps,
}

struct Inner {
    mock: bool,
    store: PathBuf,
    audio_device: String,
    speaker: speaker::Speaker,
    started: Instant,
    state: Mutex<State>,
}

/// One answer of the API.
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

fn json_response(status: u16, value: Value) -> Response {
    Response { status, content_type: "application/json", body: value.to_string().into_bytes() }
}

fn error_response(status: u16, message: impl Into<String>) -> Response {
    json_response(status, json!({ "error": message.into() }))
}

fn ok_response() -> Response {
    Response { status: 204, content_type: "application/json", body: Vec::new() }
}

fn round(value: f32, digits: i32) -> Value {
    let factor = 10f32.powi(digits);
    json!((value * factor).round() / factor)
}

fn vec_json(v: Vec3, digits: i32) -> Value {
    json!([round(v.x, digits), round(v.y, digits), round(v.z, digits)])
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn stamp() -> String {
    let ms = unix_ms();
    format!("{}-{:03}", ms / 1000, ms % 1000)
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 48 && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.contains('/') && !name.contains("..") && !name.starts_with('.')
}

/// The PCM the microphone and speaker use, as the applet shows it.
fn audio_device_name(configured: &str) -> String {
    #[cfg(target_os = "linux")]
    {
        linux::pcm_device(configured)
    }
    #[cfg(not(target_os = "linux"))]
    {
        configured.to_string()
    }
}

/// A 16-bit mono WAV header for `data_bytes` of samples.
fn wav_header(data_bytes: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&1u16.to_le_bytes());
    h[24..28].copy_from_slice(&dsp::RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(dsp::RATE * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

/// The speaker: the players linux.rs names, tried in order (PipeWire's
/// `pw-play`, then `aplay` on the codec); the mock's goes nowhere.
fn open_speaker(mock: bool, audio_device: &str) -> speaker::Speaker {
    let timing = speaker::Timing::default();
    #[cfg(target_os = "linux")]
    if !mock {
        let players = linux::speaker_players(audio_device);
        return speaker::Speaker::new(timing, move |attempt| players.get(attempt).map(|argv| linux::open_player(argv)));
    }
    let _ = (mock, audio_device);
    speaker::Speaker::new(timing, |attempt| (attempt == 0).then(|| Ok(Box::new(speaker::Silent) as Box<dyn speaker::Output>)))
}

#[derive(Clone)]
pub struct Device(Arc<Inner>);

impl Device {
    /// Open the device layer: `store` holds its files (calibration, saved
    /// signals, recordings, photos, the guest's store). `mock` answers from
    /// synthesized readings.
    pub fn new(store: PathBuf, mock: bool, audio_device: String) -> Device {
        let _ = std::fs::create_dir_all(store.join("recordings"));
        let _ = std::fs::create_dir_all(store.join("photos"));
        let _ = std::fs::create_dir_all(store.join("store"));
        let device = Device(Arc::new(Inner {
            mock,
            store,
            speaker: open_speaker(mock, &audio_device),
            audio_device,
            started: Instant::now(),
            state: Mutex::new(State::default()),
        }));
        device.load_persisted();
        device.probe();
        device.spawn_sampler();
        device
    }

    fn t(&self) -> f64 {
        self.0.started.elapsed().as_secs_f64()
    }

    /// Put the microphone preamplifier back as the capture found it.
    fn restore_gain(&self) {
        let previous = std::mem::take(&mut self.lock().audio.gain_previous);
        #[cfg(target_os = "linux")]
        if !previous.is_empty() {
            linux::capture_gain_restore(&previous);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = previous;
    }

    /// End what outlives a frame: the microphone capture, its child and the
    /// preamplifier it raised. Called once when the program leaves; a child
    /// left running would hold the codec after the panel went back to the
    /// launcher.
    pub fn stop(&self) {
        self.stop_live();
        let pid = {
            let mut state = self.lock();
            state.audio.capturing = false;
            state.audio.record_wanted = false;
            state.ir.learning = false;
            state.audio.capture_pid.take()
        };
        #[cfg(target_os = "linux")]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
        self.restore_gain();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---- persistence ----------------------------------------------------------

    fn store_path(&self, key: &str) -> PathBuf {
        self.0.store.join("store").join(format!("{key}.json"))
    }

    fn read_store(&self, key: &str) -> Option<Value> {
        let text = std::fs::read_to_string(self.store_path(key)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn write_store(&self, key: &str, value: &Value) -> std::io::Result<()> {
        let path = self.store_path(key);
        let temporary = path.with_extension("json.new");
        std::fs::write(&temporary, value.to_string())?;
        std::fs::rename(temporary, path)
    }

    fn load_persisted(&self) {
        let motion = self.read_store("motion-calibration");
        let signals = self.read_store("ir-signals");
        let mut state = self.lock();
        if let Some(value) = motion {
            if let Some(offset) = value.get("magOffset").and_then(Value::as_array) {
                if offset.len() == 3 {
                    state.motion.mag_offset = Vec3::new(
                        offset[0].as_f64().unwrap_or(0.0) as f32,
                        offset[1].as_f64().unwrap_or(0.0) as f32,
                        offset[2].as_f64().unwrap_or(0.0) as f32,
                    );
                }
            }
            if let (Some(pitch), Some(roll)) = (value.get("zeroPitch").and_then(Value::as_f64), value.get("zeroRoll").and_then(Value::as_f64)) {
                state.motion.zero = Some((pitch as f32, roll as f32));
            }
        }
        if let Some(Value::Array(items)) = signals {
            for item in items {
                let (Some(id), Some(name), Some(pulses)) = (
                    item.get("id").and_then(Value::as_u64),
                    item.get("name").and_then(Value::as_str),
                    item.get("pulses").and_then(Value::as_array),
                ) else {
                    continue;
                };
                state.ir.signals.push(Saved {
                    id: id as u32,
                    name: name.to_string(),
                    pulses: pulses.iter().filter_map(Value::as_u64).map(|v| v as u32).collect(),
                    carrier_hz: item.get("carrierHz").and_then(Value::as_u64).unwrap_or(ir::DEFAULT_CARRIER_HZ as u64) as u32,
                });
                state.ir.next_id = state.ir.next_id.max(id as u32 + 1);
            }
        }
        drop(state);
        self.refresh_recordings();
        self.refresh_photos();
    }

    fn save_motion_calibration(&self) {
        let value = {
            let state = self.lock();
            let m = &state.motion;
            json!({
                "magOffset": [m.mag_offset.x, m.mag_offset.y, m.mag_offset.z],
                "zeroPitch": m.zero.map(|z| z.0),
                "zeroRoll": m.zero.map(|z| z.1),
            })
        };
        let _ = self.write_store("motion-calibration", &value);
    }

    fn save_signals(&self) {
        let value = {
            let state = self.lock();
            Value::Array(
                state
                    .ir
                    .signals
                    .iter()
                    .map(|s| json!({ "id": s.id, "name": s.name, "pulses": s.pulses, "carrierHz": s.carrier_hz }))
                    .collect(),
            )
        };
        let _ = self.write_store("ir-signals", &value);
    }

    fn refresh_recordings(&self) {
        let mut items: Vec<(String, f32, u64)> = std::fs::read_dir(self.0.store.join("recordings"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let bytes = entry.metadata().ok()?.len();
                        if !name.ends_with(".wav") {
                            return None;
                        }
                        Some((name, bytes.saturating_sub(44) as f32 / (dsp::RATE * 2) as f32, bytes))
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.sort_by(|a, b| b.0.cmp(&a.0));
        self.lock().audio.recordings = items;
    }

    fn refresh_photos(&self) {
        let mut items: Vec<(String, u64, f64)> = std::fs::read_dir(self.0.store.join("photos"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let metadata = entry.metadata().ok()?;
                        if !name.ends_with(".jpg") {
                            return None;
                        }
                        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
                        Some((name, metadata.len(), modified))
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.sort_by(|a, b| b.0.cmp(&a.0));
        self.lock().camera.photos = items;
    }

    // ---- probing ---------------------------------------------------------------

    fn probe(&self) {
        let mut state = self.lock();
        if self.0.mock {
            state.caps = Caps {
                motion: true,
                magnet: true,
                battery: true,
                ir_tx: true,
                ir_rx: true,
                audio_capture: true,
                audio_play: true,
                camera: true,
                qr: true,
                wifi: true,
                ble: true,
                backlight: true,
                volume: true,
            };
            state.motion.available = true;
            state.motion.mag_available = true;
            state.battery.available = true;
            state.camera.available = true;
            state.camera.qr_available = true;
            state.ir.tx = Some(PathBuf::from("/dev/lirc0"));
            state.ir.rx = Some(PathBuf::from("/dev/lirc1"));
            state.system.backlight = Some((180, 255));
            state.system.volume = Some(60);
            return;
        }
        #[cfg(target_os = "linux")]
        {
            let iio = linux::probe_iio();
            state.caps.motion = iio.accel.is_some();
            state.caps.magnet = iio.mag.is_some();
            state.motion.available = iio.accel.is_some();
            state.motion.mag_available = iio.mag.is_some();
            state.caps.battery = linux::read_battery().is_some();
            state.battery.available = state.caps.battery;
            state.ir.tx = ir::lirc::find(ir::lirc::LIRC_CAN_SEND_PULSE);
            state.ir.rx = ir::lirc::find(ir::lirc::LIRC_CAN_REC_MODE2);
            state.caps.ir_tx = state.ir.tx.is_some();
            state.caps.ir_rx = state.ir.rx.is_some();
            state.caps.audio_capture = linux::tool("arecord").is_some();
            state.caps.audio_play = !linux::speaker_players(&self.0.audio_device).is_empty();
            state.caps.camera = linux::camera_tool().is_some() || linux::live_tool().is_some();
            state.camera.available = state.caps.camera;
            // QR codes are read in-process (camera.rs: zxing-cpp, or rqrr).
            state.caps.qr = state.caps.camera;
            state.camera.qr_available = state.caps.qr;
            state.caps.wifi = linux::tool("nmcli").is_some();
            state.caps.ble = linux::tool("bluetoothctl").is_some();
            state.system.backlight = linux::backlight();
            state.caps.backlight = state.system.backlight.is_some();
            state.system.volume = linux::volume();
            state.caps.volume = state.system.volume.is_some();
        }
    }

    // ---- the sampler -----------------------------------------------------------

    fn spawn_sampler(&self) {
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-sensors".into()).stack_size(256 * 1024).spawn(move || {
            #[cfg(target_os = "linux")]
            let iio = linux::probe_iio();
            let mut count: u64 = 0;
            loop {
                let t = device.t();
                let sample = if device.0.mock {
                    Some((mock::accel(t), mock::gyro(t), Some(mock::mag(t))))
                } else {
                    #[cfg(target_os = "linux")]
                    {
                        linux::read_imu(&iio).map(|(accel, gyro)| {
                            (pose::accel_to_screen(accel), pose::accel_to_screen(gyro).scale(180.0 / std::f32::consts::PI), linux::read_mag(&iio).map(pose::mag_to_screen))
                        })
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        None
                    }
                };
                if let Some((accel, gyro, mag)) = sample {
                    device.feed_motion(t, accel, gyro, mag);
                }
                if count % 50 == 0 {
                    device.refresh_slow(count % 250 == 0);
                }
                count += 1;
                thread::sleep(Duration::from_millis(20));
            }
        });
    }

    fn feed_motion(&self, t: f64, accel: Vec3, gyro: Vec3, mag: Option<Vec3>) {
        let mut state = self.lock();
        let m = &mut state.motion;
        m.available = true;
        m.accel = if m.updated == 0.0 { accel } else { pose::smooth(m.accel, accel, 0.25) };
        m.gyro = gyro;
        let deviation = (accel.norm() - G).abs();
        m.shake = (m.shake * 0.9).max((deviation / 6.0).min(1.0));
        m.impact_peak = if deviation > m.impact_peak { deviation } else { m.impact_peak * 0.98 };
        if deviation > IMPACT_THRESHOLD && m.impacts.last().is_none_or(|last| t - last.0 > 0.4) {
            m.impacts.push((t, deviation));
            if m.impacts.len() > IMPACT_LOG {
                m.impacts.remove(0);
            }
        }
        let corrected = mag.map(|field| {
            if let Some(calibration) = m.calibrating.as_mut() {
                calibration.feed(field);
            }
            field.sub(m.mag_offset)
        });
        m.mag = corrected;
        m.mag_available = mag.is_some();
        let mut computed = pose::pose(m.accel, corrected);
        if let Some((pitch, roll)) = m.zero {
            computed.pitch_deg -= pitch;
            computed.roll_deg -= roll;
            computed.bubble_x = (computed.roll_deg / pose::BUBBLE_RANGE_DEG).clamp(-1.0, 1.0);
            computed.bubble_y = (-computed.pitch_deg / pose::BUBBLE_RANGE_DEG).clamp(-1.0, 1.0);
        }
        m.pose = computed;
        m.updated = t;
    }

    fn refresh_slow(&self, link_too: bool) {
        if self.0.mock {
            let t = self.t();
            let mut state = self.lock();
            state.battery = Battery {
                available: true,
                percent: Some(mock::battery_percent(t)),
                voltage: Some(3.92),
                current: Some(-0.31),
                status: "Discharging".into(),
                temp: Some(29.5),
            };
            let backlight = state.system.backlight;
            let volume = state.system.volume;
            state.system = System {
                hostname: "cardputer".into(),
                uptime: 7200.0 + t,
                load: [0.42, 0.35, 0.30],
                mem_used: 118,
                mem_total: 227,
                cpu_temp: Some(48.2 + (t / 10.0).sin() as f32),
                ip: Some("192.168.8.159".into()),
                ssid: Some("GL-SFT1200-128".into()),
                rssi: Some(-58),
                link: Some(70),
                backlight,
                volume,
                disk: Some((9_400_000_000, 31_000_000_000)),
            };
            return;
        }
        #[cfg(target_os = "linux")]
        {
            let battery = linux::read_battery();
            let uptime = linux::uptime_seconds();
            let load = linux::load_average();
            let memory = linux::memory();
            let cpu = linux::cpu_temperature();
            let hostname = linux::hostname();
            let link = if link_too { Some((linux::wifi_link(), linux::ip_address(), linux::backlight(), linux::volume(), linux::disk())) } else { None };
            let mut state = self.lock();
            if let Some(reading) = battery {
                state.battery = Battery {
                    available: true,
                    percent: reading.percent,
                    voltage: reading.voltage,
                    current: reading.current,
                    status: reading.status,
                    temp: reading.temp,
                };
            }
            let s = &mut state.system;
            if let Some(value) = uptime {
                s.uptime = value;
            }
            if let Some(value) = load {
                s.load = value;
            }
            if let Some((used, total)) = memory {
                s.mem_used = used;
                s.mem_total = total;
            }
            s.cpu_temp = cpu;
            if let Some(name) = hostname {
                s.hostname = name;
            }
            if let Some(((ssid, rssi, quality), ip, backlight, volume, disk)) = link {
                s.ssid = ssid;
                s.rssi = rssi;
                s.link = quality;
                s.ip = ip;
                if backlight.is_some() {
                    s.backlight = backlight;
                }
                if volume.is_some() {
                    s.volume = volume;
                }
                s.disk = disk;
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = link_too;
        }
    }

    // ---- audio --------------------------------------------------------------------

    fn start_capture(&self) {
        {
            let mut state = self.lock();
            if state.audio.capturing {
                return;
            }
            state.audio.capturing = true;
            state.audio.error = None;
        }
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-audio".into()).stack_size(512 * 1024).spawn(move || device.capture_loop());
    }

    fn capture_loop(&self) {
        let mut file: Option<(std::fs::File, u32, PathBuf)> = None;
        #[cfg(target_os = "linux")]
        let mut child: Option<std::process::Child> = None;
        #[cfg(target_os = "linux")]
        let mut stdout: Option<std::process::ChildStdout> = None;
        if !self.0.mock {
            #[cfg(target_os = "linux")]
            {
                let previous = linux::capture_gain_up();
                self.lock().audio.gain_previous = previous;
            }
            #[cfg(target_os = "linux")]
            match linux::spawn_capture(&self.0.audio_device) {
                Ok(mut spawned) => {
                    stdout = spawned.stdout.take();
                    self.lock().audio.capture_pid = Some(spawned.id());
                    child = Some(spawned);
                }
                Err(error) => {
                    let mut state = self.lock();
                    state.audio.capturing = false;
                    state.audio.error = Some(error);
                    return;
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let mut state = self.lock();
                state.audio.capturing = false;
                state.audio.error = Some("the microphone needs Linux".into());
                return;
            }
        }
        let mut block = vec![0i16; dsp::BLOCK];
        loop {
            let (capturing, record_wanted, recording_open) = {
                let state = self.lock();
                (state.audio.capturing, state.audio.record_wanted, state.audio.recording.is_some())
            };
            if !capturing {
                break;
            }
            // One block of samples.
            if self.0.mock {
                thread::sleep(Duration::from_millis(32));
                block.copy_from_slice(&mock::audio_block(self.t()));
            } else {
                #[cfg(target_os = "linux")]
                {
                    use std::io::Read;
                    let mut bytes = vec![0u8; dsp::BLOCK * 2];
                    let Some(reader) = stdout.as_mut() else { break };
                    if reader.read_exact(&mut bytes).is_err() {
                        let mut state = self.lock();
                        state.audio.error = Some("the microphone stream ended".into());
                        state.audio.capturing = false;
                        break;
                    }
                    for (i, sample) in block.iter_mut().enumerate() {
                        *sample = i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]);
                    }
                }
            }
            // The recording file follows the request.
            if record_wanted && file.is_none() {
                let name = format!("rec-{}.wav", stamp());
                let path = self.0.store.join("recordings").join(&name);
                match std::fs::File::create(&path) {
                    Ok(mut created) => {
                        let _ = created.write_all(&wav_header(0));
                        file = Some((created, 0, path));
                        let t = self.t();
                        self.lock().audio.recording = Some(Recording { name, started: t, seconds: 0.0 });
                    }
                    Err(error) => {
                        let mut state = self.lock();
                        state.audio.record_wanted = false;
                        state.audio.error = Some(format!("cannot write a recording: {error}"));
                    }
                }
            } else if !record_wanted && recording_open {
                self.finish_recording(&mut file);
            }
            if let Some((handle, written, _)) = file.as_mut() {
                let bytes: Vec<u8> = block.iter().flat_map(|s| s.to_le_bytes()).collect();
                if handle.write_all(&bytes).is_ok() {
                    *written += bytes.len() as u32;
                }
                let seconds = *written as f32 / (dsp::RATE * 2) as f32;
                if let Some(recording) = self.lock().audio.recording.as_mut() {
                    recording.seconds = seconds;
                }
            }
            let (level, peak) = dsp::level_db(&block);
            let spectrum = dsp::spectrum(&block);
            let wave = dsp::wave(&block);
            let pitch = dsp::pitch(&block);
            let mut state = self.lock();
            let a = &mut state.audio;
            a.level_db = level;
            a.peak_db = peak;
            a.spectrum = spectrum;
            a.wave = wave;
            a.pitch_hz = pitch;
            a.blocks += 1;
        }
        self.finish_recording(&mut file);
        #[cfg(target_os = "linux")]
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        self.restore_gain();
        let mut state = self.lock();
        state.audio.capturing = false;
        state.audio.record_wanted = false;
        state.audio.capture_pid = None;
        state.audio.level_db = dsp::FLOOR_DB;
        state.audio.peak_db = dsp::FLOOR_DB;
        state.audio.pitch_hz = None;
    }

    fn finish_recording(&self, file: &mut Option<(std::fs::File, u32, PathBuf)>) {
        use std::io::Seek;
        if let Some((mut handle, written, _path)) = file.take() {
            if handle.seek(std::io::SeekFrom::Start(0)).is_ok() {
                let _ = handle.write_all(&wav_header(written));
            }
            drop(handle);
            self.lock().audio.recording = None;
            self.refresh_recordings();
        }
    }

    fn play(&self, name: &str) -> Response {
        if !valid_name(name) {
            return error_response(400, "bad name");
        }
        let path = self.0.store.join("recordings").join(name);
        let Ok(bytes) = std::fs::read(&path) else {
            return error_response(404, "no such recording");
        };
        match speaker::wav_samples(&bytes) {
            Ok(samples) => self.sound(&samples, name),
            Err(error) => error_response(415, error),
        }
    }

    fn beep(&self) -> Response {
        self.sound(&speaker::beep(), "tone")
    }

    fn sound(&self, samples: &[i16], label: &str) -> Response {
        let until = Instant::now() + self.0.speaker.play(samples);
        self.lock().audio.playing = Some((label.to_string(), until));
        ok_response()
    }

    // ---- infrared ----------------------------------------------------------------

    fn learn(&self, on: bool) -> Response {
        {
            let mut state = self.lock();
            if !on {
                state.ir.learning = false;
                return ok_response();
            }
            if state.ir.learning {
                return ok_response();
            }
            if state.ir.rx.is_none() {
                return error_response(503, "no infrared receiver");
            }
            state.ir.learning = true;
            state.ir.captured = None;
        }
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-ir".into()).spawn(move || {
            let result: Result<Option<Vec<u32>>, String> = if device.0.mock {
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(1500) {
                    if !device.lock().ir.learning {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                if device.lock().ir.learning { Ok(Some(ir::encode_nec(0x04, 0x08))) } else { Ok(None) }
            } else {
                #[cfg(target_os = "linux")]
                {
                    let rx = device.lock().ir.rx.clone();
                    match rx {
                        Some(path) => {
                            let waiter = device.clone();
                            ir::lirc::receive(&path, Duration::from_secs(30), &|| !waiter.lock().ir.learning).map_err(|e| e.to_string())
                        }
                        None => Err("no infrared receiver".into()),
                    }
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err("infrared needs Linux".into())
                }
            };
            let t = device.t();
            let mut state = device.lock();
            state.ir.learning = false;
            match result {
                Ok(Some(pulses)) => state.ir.captured = Some(Captured { pulses, carrier_hz: ir::DEFAULT_CARRIER_HZ, t }),
                Ok(None) => {}
                Err(error) => state.ir.last_sent = Some((t, false, error)),
            }
        });
        ok_response()
    }

    fn send(&self, body: &Value) -> Response {
        let signal = {
            let state = self.lock();
            if state.ir.tx.is_none() {
                return error_response(503, "no infrared transmitter");
            }
            if let Some(id) = body.get("id").and_then(Value::as_u64) {
                match state.ir.signals.iter().find(|s| s.id == id as u32) {
                    Some(saved) => ir::Signal { pulses: saved.pulses.clone(), carrier_hz: saved.carrier_hz },
                    None => return error_response(404, "no such signal"),
                }
            } else if let (Some(address), Some(command)) = (body.get("address").and_then(Value::as_u64), body.get("command").and_then(Value::as_u64)) {
                ir::Signal { pulses: ir::encode_nec(address as u16, command as u8), carrier_hz: ir::DEFAULT_CARRIER_HZ }
            } else if let Some(pulses) = body.get("pulses").and_then(Value::as_array) {
                ir::Signal {
                    pulses: pulses.iter().filter_map(Value::as_u64).map(|v| v as u32).collect(),
                    carrier_hz: body.get("carrierHz").and_then(Value::as_u64).unwrap_or(ir::DEFAULT_CARRIER_HZ as u64) as u32,
                }
            } else if body.get("captured").and_then(Value::as_bool) == Some(true) {
                match state.ir.captured.as_ref() {
                    Some(captured) => ir::Signal { pulses: captured.pulses.clone(), carrier_hz: captured.carrier_hz },
                    None => return error_response(404, "nothing captured"),
                }
            } else {
                return error_response(400, "send needs id, address+command, pulses or captured");
            }
        };
        if signal.pulses.len() < 3 {
            return error_response(400, "the signal is empty");
        }
        self.lock().ir.sending = true;
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-ir-tx".into()).spawn(move || {
            let result: Result<(), String> = if device.0.mock {
                thread::sleep(Duration::from_millis(120));
                Ok(())
            } else {
                #[cfg(target_os = "linux")]
                {
                    let tx = device.lock().ir.tx.clone();
                    match tx {
                        Some(path) => ir::lirc::send(&path, &signal).map_err(|e| e.to_string()),
                        None => Err("no infrared transmitter".into()),
                    }
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err("infrared needs Linux".into())
                }
            };
            let t = device.t();
            let mut state = device.lock();
            state.ir.sending = false;
            state.ir.last_sent = Some(match result {
                Ok(()) => (t, true, String::new()),
                Err(error) => (t, false, error),
            });
        });
        ok_response()
    }

    fn save_signal(&self, body: &Value) -> Response {
        let name = body.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !valid_name(&name) {
            return error_response(400, "bad name");
        }
        let id = {
            let mut state = self.lock();
            let Some(captured) = state.ir.captured.as_ref() else {
                return error_response(404, "nothing captured");
            };
            let saved = Saved { id: state.ir.next_id, name, pulses: captured.pulses.clone(), carrier_hz: captured.carrier_hz };
            state.ir.next_id += 1;
            let id = saved.id;
            state.ir.signals.push(saved);
            state.ir.captured = None;
            id
        };
        self.save_signals();
        json_response(200, json!({ "id": id }))
    }

    // ---- radio ------------------------------------------------------------------

    fn scan_wifi(&self) -> Response {
        {
            let mut state = self.lock();
            if state.radio.wifi.scanning {
                return ok_response();
            }
            state.radio.wifi.scanning = true;
            state.radio.wifi.error = None;
        }
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-wifi".into()).spawn(move || {
            let result: Result<Vec<Network>, String> = if device.0.mock {
                thread::sleep(Duration::from_millis(1800));
                Ok(mock::networks(device.t()))
            } else {
                #[cfg(target_os = "linux")]
                {
                    linux::wifi_scan()
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err("Wi-Fi scans need Linux".into())
                }
            };
            let t = device.t();
            let mut state = device.lock();
            let scan = &mut state.radio.wifi;
            scan.scanning = false;
            scan.t = Some(t);
            match result {
                Ok(items) => scan.items = items,
                Err(error) => scan.error = Some(error),
            }
        });
        ok_response()
    }

    fn scan_ble(&self) -> Response {
        {
            let mut state = self.lock();
            if state.radio.ble.scanning {
                return ok_response();
            }
            state.radio.ble.scanning = true;
            state.radio.ble.error = None;
        }
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-ble".into()).spawn(move || {
            let result: Result<Vec<BleDevice>, String> = if device.0.mock {
                thread::sleep(Duration::from_millis(2500));
                Ok(mock::ble_devices(device.t()))
            } else {
                #[cfg(target_os = "linux")]
                {
                    linux::ble_scan(BLE_SCAN_SECONDS)
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err("Bluetooth scans need Linux".into())
                }
            };
            let t = device.t();
            let mut state = device.lock();
            let scan = &mut state.radio.ble;
            scan.scanning = false;
            scan.t = Some(t);
            match result {
                Ok(items) => scan.items = items,
                Err(error) => scan.error = Some(error),
            }
        });
        ok_response()
    }

    // ---- camera ------------------------------------------------------------------

    /// Start or stop the live stream (camera.rs).
    fn live(&self, on: bool) -> Response {
        if !on {
            self.stop_live();
            return ok_response();
        }
        match self.start_live() {
            Ok(()) => ok_response(),
            Err(message) => error_response(503, message),
        }
    }

    /// Start the live stream unless it runs: the video plane (video.rs) and
    /// `POST /dev/camera/live` both come here.
    pub fn start_live(&self) -> Result<(), String> {
        let generation = {
            let mut state = self.lock();
            if !state.camera.available {
                return Err("no camera".into());
            }
            let live = &mut state.camera.live;
            if matches!(live.phase, camera::Phase::Starting | camera::Phase::Live) {
                return Ok(());
            }
            live.generation += 1;
            live.phase = camera::Phase::Starting;
            live.error = None;
            live.started_ms = unix_ms();
            live.frame = 0;
            live.fps = 0.0;
            live.jpeg = None;
            live.rgba = None;
            live.qr = None;
            live.generation
        };
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-camera-live".into()).stack_size(4 * 1024 * 1024).spawn(move || device.run_live(generation));
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-camera-qr".into()).stack_size(4 * 1024 * 1024).spawn(move || device.run_scanner(generation));
        Ok(())
    }

    /// The newest decoded frame when it is newer than `after`: its number and
    /// the 256x128 RGBA texture.
    pub fn newest_frame(&self, after: Option<u32>) -> Option<(u32, Arc<Vec<u8>>)> {
        let state = self.lock();
        let live = &state.camera.live;
        if live.phase != camera::Phase::Live || Some(live.frame) == after {
            return None;
        }
        live.rgba.clone().map(|rgba| (live.frame, rgba))
    }

    pub fn stop_live(&self) {
        let pid = {
            let mut state = self.lock();
            let live = &mut state.camera.live;
            live.generation += 1;
            live.phase = camera::Phase::Off;
            live.scanning = false;
            live.jpeg = None;
            live.rgba = None;
            live.pid.take()
        };
        #[cfg(target_os = "linux")]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }

    /// Keep one frame: the latest JPEG and its texture, or None when this
    /// generation is gone.
    fn keep_frame(&self, generation: u64, jpeg: Vec<u8>, rgba: Option<Vec<u8>>, rate: &mut camera::Rate) -> bool {
        let t = self.t();
        let mut state = self.lock();
        let live = &mut state.camera.live;
        if live.generation != generation {
            return false;
        }
        live.phase = camera::Phase::Live;
        live.frame = live.frame.wrapping_add(1);
        live.fps = rate.tick(t);
        live.jpeg = Some(Arc::new(jpeg));
        if let Some(rgba) = rgba {
            live.rgba = Some(Arc::new(rgba));
        }
        true
    }

    fn end_live(&self, generation: u64, error: String) {
        let mut state = self.lock();
        let live = &mut state.camera.live;
        if live.generation == generation {
            live.phase = camera::Phase::Failed;
            live.error = Some(error);
            live.pid = None;
        }
    }

    fn run_live(&self, generation: u64) {
        let mut rate = camera::Rate::default();
        if self.0.mock {
            // The real camera's start, shortened: frames after 1.5 s.
            thread::sleep(Duration::from_millis(1500));
            loop {
                let picture = mock::picture(self.t());
                if !self.keep_frame(generation, b"mock".to_vec(), Some(picture), &mut rate) {
                    return;
                }
                thread::sleep(Duration::from_millis(80));
            }
        }
        #[cfg(target_os = "linux")]
        {
            use std::io::Read;
            let mut child = match linux::live_stream() {
                Ok(child) => child,
                Err(error) => return self.end_live(generation, error),
            };
            {
                let mut state = self.lock();
                if state.camera.live.generation != generation {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                state.camera.live.pid = Some(child.id());
            }
            let Some(mut stdout) = child.stdout.take() else {
                let _ = child.kill();
                return self.end_live(generation, "the camera gave no stream".into());
            };
            let mut splitter = camera::Splitter::default();
            let mut buffer = vec![0u8; 64 * 1024];
            'stream: loop {
                let read = match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                for jpeg in splitter.push(&buffer[..read]) {
                    let rgba = camera::texture(&jpeg).ok().map(|(rgba, _, _)| rgba);
                    if !self.keep_frame(generation, jpeg, rgba, &mut rate) {
                        break 'stream;
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            self.end_live(generation, "the camera stopped".into());
        }
        #[cfg(not(target_os = "linux"))]
        self.end_live(generation, "the camera needs Linux".into());
    }

    /// Read QR codes from the latest frame while the tool scans.
    fn run_scanner(&self, generation: u64) {
        let mut scanned_frame = 0;
        let mut scanning_since: Option<f64> = None;
        loop {
            thread::sleep(Duration::from_millis(250));
            let (jpeg, frame) = {
                let state = self.lock();
                let live = &state.camera.live;
                if live.generation != generation {
                    return;
                }
                if !live.scanning || live.frame == scanned_frame {
                    if !live.scanning {
                        scanning_since = None;
                    }
                    continue;
                }
                (live.jpeg.clone(), live.frame)
            };
            scanned_frame = frame;
            let text = if self.0.mock {
                // The mock reads a code after a second and a half of scanning.
                let since = *scanning_since.get_or_insert(self.t());
                (self.t() - since > 1.5).then(|| "https://pocket.nexus".to_string())
            } else {
                jpeg.and_then(|jpeg| camera::read_qr(&jpeg).ok().flatten())
            };
            if let Some(text) = text {
                let mut state = self.lock();
                let live = &mut state.camera.live;
                if live.generation == generation {
                    live.qr = Some(text);
                    live.qr_frame = frame;
                }
            }
        }
    }

    fn scan(&self, on: bool) -> Response {
        let mut state = self.lock();
        state.camera.live.scanning = on;
        if on {
            state.camera.live.qr = None;
        }
        ok_response()
    }

    /// The last photo as a 128x64 RGB565 thumbnail (16 KiB, little endian).
    fn thumbnail(&self) -> Response {
        match self.lock().camera.preview.as_ref() {
            Some(rgba) => Response { status: 200, content_type: "application/octet-stream", body: camera::thumbnail_rgb565(rgba) },
            None => error_response(404, "no photo"),
        }
    }

    fn capture(&self, want_qr: bool) -> Response {
        // With the stream running, a picture is the frame on screen.
        let frame = {
            let state = self.lock();
            let live = &state.camera.live;
            if live.phase == camera::Phase::Live {
                live.jpeg.clone().zip(live.rgba.clone())
            } else {
                None
            }
        };
        if let Some((jpeg, rgba)) = frame {
            let name = format!("photo-{}.jpg", stamp());
            let path = self.0.store.join("photos").join(&name);
            if let Err(error) = std::fs::write(&path, &jpeg[..]) {
                return error_response(500, format!("could not save the picture: {error}"));
            }
            let qr = if want_qr && !self.0.mock { camera::read_qr(&jpeg).ok().flatten() } else if want_qr { Some("https://pocket.nexus".into()) } else { None };
            let t = self.t();
            {
                let mut state = self.lock();
                state.camera.error = None;
                state.camera.preview = Some(rgba.to_vec());
                state.camera.last = Some(Photo { name, t, at: unix_ms(), width: camera::WIDTH, height: camera::HEIGHT, qr, bytes: jpeg.len() as u64 });
            }
            self.refresh_photos();
            return ok_response();
        }
        {
            let mut state = self.lock();
            if !state.camera.available {
                return error_response(503, "no camera");
            }
            if state.camera.busy {
                return ok_response();
            }
            state.camera.busy = true;
            state.camera.error = None;
        }
        let device = self.clone();
        let _ = thread::Builder::new().name("pocket-zero-camera".into()).stack_size(4 * 1024 * 1024).spawn(move || {
            let name = format!("photo-{}.jpg", stamp());
            let path = device.0.store.join("photos").join(&name);
            let result: Result<(Vec<u8>, u32, u32, Option<String>, u64), String> = if device.0.mock {
                thread::sleep(Duration::from_millis(900));
                let picture = mock::picture(device.t());
                let _ = std::fs::write(&path, b"mock");
                Ok((picture, 640, 360, if want_qr { Some("https://pocket.nexus".into()) } else { None }, 4))
            } else {
                #[cfg(target_os = "linux")]
                {
                    match linux::camera_tool() {
                        Some(tool_path) => linux::capture_jpeg(&tool_path, &path).and_then(|()| {
                            let (preview, width, height) = linux::preview_rgba(&path)?;
                            let qr = if want_qr { linux::read_qr(&path).unwrap_or(None) } else { None };
                            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                            Ok((preview, width, height, qr, bytes))
                        }),
                        None => Err("no camera tool".into()),
                    }
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err("the camera needs Linux".into())
                }
            };
            let t = device.t();
            {
                let mut state = device.lock();
                state.camera.busy = false;
                match result {
                    Ok((preview, width, height, qr, bytes)) => {
                        state.camera.preview = Some(preview);
                        state.camera.last = Some(Photo { name, t, at: unix_ms(), width, height, qr, bytes });
                    }
                    Err(error) => state.camera.error = Some(error),
                }
            }
            device.refresh_photos();
        });
        ok_response()
    }

    // ---- JSON ------------------------------------------------------------------

    fn capabilities_json(&self) -> Value {
        let state = self.lock();
        let c = &state.caps;
        json!({
            "motion": c.motion, "magnet": c.magnet, "battery": c.battery,
            "ir": { "tx": c.ir_tx, "rx": c.ir_rx },
            "audio": { "capture": c.audio_capture, "play": c.audio_play },
            "camera": c.camera, "qr": c.qr, "wifi": c.wifi, "ble": c.ble,
            "backlight": c.backlight, "volume": c.volume, "mock": self.0.mock,
        })
    }

    fn motion_json(&self) -> Value {
        let state = self.lock();
        let m = &state.motion;
        json!({
            "available": m.available,
            "t": round(m.updated as f32, 2),
            "pitch": round(m.pose.pitch_deg, 1),
            "roll": round(m.pose.roll_deg, 1),
            "heading": m.pose.heading_deg.map(|h| round(h, 0)),
            "bubble": [round(m.pose.bubble_x, 3), round(m.pose.bubble_y, 3)],
            "accel": vec_json(m.accel, 2),
            "gyro": vec_json(m.gyro, 1),
            "mag": m.mag.map(|v| vec_json(v, 1)),
            "magAvailable": m.mag_available,
            "shake": round(m.shake, 2),
            "impactPeak": round(m.impact_peak, 1),
            "impacts": m.impacts.iter().rev().map(|(t, g)| json!([round(*t as f32, 1), round(*g, 1)])).collect::<Vec<_>>(),
            "zeroed": m.zero.is_some(),
            "calibrating": m.calibrating.is_some(),
            "calibration": m.calibrating.as_ref().map(|c| round(c.progress(CALIBRATION_SPAN_UT), 2)),
        })
    }

    fn battery_json(&self) -> Value {
        let state = self.lock();
        let b = &state.battery;
        let power = match (b.voltage, b.current) {
            (Some(v), Some(i)) => Some(round(v * i, 2)),
            _ => None,
        };
        json!({
            "available": b.available,
            "percent": b.percent,
            "voltage": b.voltage.map(|v| round(v, 2)),
            "current": b.current.map(|v| round(v, 2)),
            "power": power,
            "status": b.status,
            "temp": b.temp.map(|v| round(v, 1)),
        })
    }

    fn system_json(&self) -> Value {
        let state = self.lock();
        let s = &state.system;
        json!({
            "hostname": s.hostname,
            "uptime": s.uptime.round(),
            "load": [round(s.load[0], 2), round(s.load[1], 2), round(s.load[2], 2)],
            "mem": { "used": s.mem_used, "total": s.mem_total },
            "cpuTemp": s.cpu_temp.map(|v| round(v, 1)),
            "ip": s.ip,
            "wifi": { "ssid": s.ssid, "rssi": s.rssi, "link": s.link },
            "backlight": s.backlight.map(|(value, max)| json!({ "value": value, "max": max })),
            "volume": s.volume,
            "disk": s.disk.map(|(used, total)| json!({ "used": used, "total": total })),
            "clock": unix_ms(),
        })
    }

    fn audio_json(&self) -> Value {
        let state = self.lock();
        let a = &state.audio;
        json!({
            "capturing": a.capturing,
            "level": round(a.level_db, 1),
            "peak": round(a.peak_db, 1),
            "spectrum": a.spectrum.iter().map(|v| round(*v, 3)).collect::<Vec<_>>(),
            "wave": a.wave.iter().map(|v| round(*v, 3)).collect::<Vec<_>>(),
            "pitch": a.pitch_hz.map(|hz| {
                let (name, cents) = dsp::note(hz);
                json!({ "hz": round(hz, 1), "note": name, "cents": round(cents, 0) })
            }),
            "blocks": a.blocks,
            "recording": a.recording.as_ref().map(|r| json!({ "name": r.name, "seconds": round(r.seconds, 1), "started": round(r.started as f32, 1) })),
            "recordings": a.recordings.iter().map(|(name, seconds, bytes)| json!({ "name": name, "seconds": round(*seconds, 1), "bytes": bytes })).collect::<Vec<_>>(),
            "playing": a.playing.as_ref().filter(|(_, until)| Instant::now() < *until).map(|(name, _)| name),
            "error": a.error.clone().or_else(|| self.0.speaker.error()),
            "device": if self.0.mock { self.0.audio_device.clone() } else { audio_device_name(&self.0.audio_device) },
        })
    }

    fn ir_json(&self) -> Value {
        let state = self.lock();
        let i = &state.ir;
        json!({
            "tx": i.tx.is_some(),
            "rx": i.rx.is_some(),
            "learning": i.learning,
            "sending": i.sending,
            "captured": i.captured.as_ref().map(|c| {
                let nec = ir::decode_nec(&c.pulses);
                json!({
                    "pulses": c.pulses,
                    "carrierHz": c.carrier_hz,
                    "protocol": ir::protocol(&c.pulses),
                    "nec": nec.map(|n| json!({ "address": n.address, "command": n.command, "extended": n.extended })),
                    "t": round(c.t as f32, 1),
                })
            }),
            "lastSent": i.last_sent.as_ref().map(|(t, ok, error)| json!({ "t": round(*t as f32, 1), "ok": ok, "error": error })),
            "signals": i.signals.iter().map(|s| json!({
                "id": s.id, "name": s.name, "protocol": ir::protocol(&s.pulses), "count": s.pulses.len(),
                "nec": ir::decode_nec(&s.pulses).map(|n| json!({ "address": n.address, "command": n.command })),
            })).collect::<Vec<_>>(),
        })
    }

    fn radio_json(&self) -> Value {
        let state = self.lock();
        let r = &state.radio;
        json!({
            "wifi": {
                "scanning": r.wifi.scanning,
                "t": r.wifi.t.map(|t| round(t as f32, 1)),
                "error": r.wifi.error,
                "networks": r.wifi.items.iter().map(|n| json!({
                    "ssid": n.ssid, "bssid": n.bssid, "signal": n.signal, "freq": n.freq_mhz, "chan": n.channel, "security": n.security, "active": n.active,
                })).collect::<Vec<_>>(),
            },
            "ble": {
                "scanning": r.ble.scanning,
                "t": r.ble.t.map(|t| round(t as f32, 1)),
                "error": r.ble.error,
                "devices": r.ble.items.iter().map(|d| json!({ "address": d.address, "name": d.name, "rssi": d.rssi })).collect::<Vec<_>>(),
            },
        })
    }

    fn camera_json(&self) -> Value {
        let state = self.lock();
        let c = &state.camera;
        json!({
            "available": c.available,
            "qrAvailable": c.qr_available,
            "busy": c.busy,
            "error": c.error,
            "last": c.last.as_ref().map(|p| json!({ "name": p.name, "t": round(p.t as f32, 1), "at": p.at, "width": p.width, "height": p.height, "qr": p.qr, "bytes": p.bytes })),
            "photos": c.photos.iter().map(|(name, bytes, modified)| json!({ "name": name, "bytes": bytes, "modified": modified })).collect::<Vec<_>>(),
            "thumbnail": c.preview.as_ref().map(|_| "/dev/camera/thumbnail.rgb565"),
            "live": {
                "phase": c.live.phase.name(),
                "error": c.live.error,
                "startedAt": c.live.started_ms,
                "frame": c.live.frame,
                "fps": round(c.live.fps, 1),
                "scanning": c.live.scanning,
                "qr": c.live.qr,
            },
        })
    }

    // ---- routing ------------------------------------------------------------------

    /// Answer one request to `/dev/…`. `path` excludes the host.
    pub fn handle(&self, method: &str, path: &str, body: &[u8]) -> Response {
        let body_json: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(body).unwrap_or(Value::Null) };
        let flag = |name: &str| body_json.get(name).and_then(Value::as_bool).unwrap_or(true);
        match (method, path) {
            ("GET", "/dev/capabilities") => json_response(200, self.capabilities_json()),
            ("GET", "/dev/motion") => json_response(200, self.motion_json()),
            ("POST", "/dev/motion/zero") => {
                {
                    let mut state = self.lock();
                    let (pitch, roll) = {
                        let p = pose::pose(state.motion.accel, None);
                        (p.pitch_deg, p.roll_deg)
                    };
                    state.motion.zero = Some((pitch, roll));
                }
                self.save_motion_calibration();
                ok_response()
            }
            ("POST", "/dev/motion/unzero") => {
                self.lock().motion.zero = None;
                self.save_motion_calibration();
                ok_response()
            }
            ("POST", "/dev/motion/calibrate") => {
                let on = flag("on");
                let finished = {
                    let mut state = self.lock();
                    if on {
                        if state.motion.calibrating.is_none() {
                            state.motion.calibrating = Some(MagCalibration::default());
                        }
                        false
                    } else if let Some(calibration) = state.motion.calibrating.take() {
                        if let Some(offset) = calibration.offset(CALIBRATION_SPAN_UT) {
                            state.motion.mag_offset = offset;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if finished {
                    self.save_motion_calibration();
                }
                json_response(200, json!({ "applied": finished }))
            }
            ("GET", "/dev/battery") => json_response(200, self.battery_json()),
            ("GET", "/dev/system") => json_response(200, self.system_json()),
            ("POST", "/dev/system/backlight") => {
                let Some(value) = body_json.get("value").and_then(Value::as_u64) else {
                    return error_response(400, "backlight needs value");
                };
                let result = if self.0.mock {
                    Ok(())
                } else {
                    #[cfg(target_os = "linux")]
                    {
                        linux::set_backlight(value as u32)
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        Err::<(), String>("no backlight".into())
                    }
                };
                match result {
                    Ok(()) => {
                        let mut state = self.lock();
                        let max = state.system.backlight.map(|b| b.1).unwrap_or(255);
                        state.system.backlight = Some(((value as u32).min(max), max));
                        ok_response()
                    }
                    Err(error) => error_response(503, error),
                }
            }
            ("POST", "/dev/system/volume") => {
                let Some(value) = body_json.get("value").and_then(Value::as_u64) else {
                    return error_response(400, "volume needs value");
                };
                let result = if self.0.mock {
                    Ok(())
                } else {
                    #[cfg(target_os = "linux")]
                    {
                        linux::set_volume(value as u8)
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        Err::<(), String>("no mixer".into())
                    }
                };
                match result {
                    Ok(()) => {
                        self.lock().system.volume = Some((value as u8).min(100));
                        ok_response()
                    }
                    Err(error) => error_response(503, error),
                }
            }
            ("GET", "/dev/audio") => json_response(200, self.audio_json()),
            ("POST", "/dev/audio/capture") => {
                if flag("on") {
                    self.start_capture();
                } else {
                    let mut state = self.lock();
                    state.audio.capturing = false;
                    state.audio.record_wanted = false;
                }
                ok_response()
            }
            ("POST", "/dev/audio/record") => {
                if flag("on") {
                    self.start_capture();
                    self.lock().audio.record_wanted = true;
                } else {
                    self.lock().audio.record_wanted = false;
                }
                ok_response()
            }
            ("POST", "/dev/audio/play") => match body_json.get("name").and_then(Value::as_str) {
                Some(name) => self.play(name),
                None => error_response(400, "play needs name"),
            },
            ("POST", "/dev/audio/beep") => self.beep(),
            ("POST", "/dev/audio/delete") => {
                let Some(name) = body_json.get("name").and_then(Value::as_str) else {
                    return error_response(400, "delete needs name");
                };
                if !valid_name(name) {
                    return error_response(400, "bad name");
                }
                let _ = std::fs::remove_file(self.0.store.join("recordings").join(name));
                self.refresh_recordings();
                ok_response()
            }
            ("GET", "/dev/ir") => json_response(200, self.ir_json()),
            ("POST", "/dev/ir/learn") => self.learn(flag("on")),
            ("POST", "/dev/ir/send") => self.send(&body_json),
            ("POST", "/dev/ir/save") => self.save_signal(&body_json),
            ("POST", "/dev/ir/delete") => {
                let Some(id) = body_json.get("id").and_then(Value::as_u64) else {
                    return error_response(400, "delete needs id");
                };
                self.lock().ir.signals.retain(|s| s.id != id as u32);
                self.save_signals();
                ok_response()
            }
            ("POST", "/dev/ir/rename") => {
                let (Some(id), Some(name)) = (body_json.get("id").and_then(Value::as_u64), body_json.get("name").and_then(Value::as_str)) else {
                    return error_response(400, "rename needs id and name");
                };
                if !valid_name(name.trim()) {
                    return error_response(400, "bad name");
                }
                {
                    let mut state = self.lock();
                    match state.ir.signals.iter_mut().find(|s| s.id == id as u32) {
                        Some(saved) => saved.name = name.trim().to_string(),
                        None => return error_response(404, "no such signal"),
                    }
                }
                self.save_signals();
                ok_response()
            }
            ("GET", "/dev/radio") => json_response(200, self.radio_json()),
            ("POST", "/dev/radio/wifi/scan") => {
                if !self.lock().caps.wifi {
                    return error_response(503, "no Wi-Fi scan tool");
                }
                self.scan_wifi()
            }
            ("POST", "/dev/radio/ble/scan") => {
                if !self.lock().caps.ble {
                    return error_response(503, "no Bluetooth scan tool");
                }
                self.scan_ble()
            }
            ("GET", "/dev/camera") => json_response(200, self.camera_json()),
            ("POST", "/dev/camera/capture") => self.capture(body_json.get("qr").and_then(Value::as_bool).unwrap_or(false)),
            ("POST", "/dev/camera/live") => self.live(body_json.get("on").and_then(Value::as_bool).unwrap_or(false)),
            ("POST", "/dev/camera/scan") => self.scan(body_json.get("on").and_then(Value::as_bool).unwrap_or(false)),
            ("GET", "/dev/camera/thumbnail.rgb565") => self.thumbnail(),
            ("POST", "/dev/camera/delete") => {
                let Some(name) = body_json.get("name").and_then(Value::as_str) else {
                    return error_response(400, "delete needs name");
                };
                if !valid_name(name) {
                    return error_response(400, "bad name");
                }
                let _ = std::fs::remove_file(self.0.store.join("photos").join(name));
                self.refresh_photos();
                ok_response()
            }
            (method, path) if path.starts_with("/dev/store/") => {
                let key = &path["/dev/store/".len()..];
                if !valid_key(key) {
                    return error_response(400, "a store key is lower-case letters, digits and dashes");
                }
                match method {
                    "GET" => match self.read_store(key) {
                        Some(value) => json_response(200, value),
                        None => json_response(200, Value::Null),
                    },
                    "PUT" | "POST" => {
                        if body.len() > 64 * 1024 {
                            return error_response(413, "a store value is at most 64 KiB");
                        }
                        match serde_json::from_slice::<Value>(body) {
                            Ok(value) => match self.write_store(key, &value) {
                                Ok(()) => ok_response(),
                                Err(error) => error_response(500, error.to_string()),
                            },
                            Err(_) => error_response(400, "a store value is JSON"),
                        }
                    }
                    _ => error_response(405, "GET or PUT"),
                }
            }
            _ => error_response(404, format!("no device route {method} {path}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> Device {
        let dir = std::env::temp_dir().join(format!("pocket-zero-device-{}-{}", std::process::id(), unix_ms()));
        Device::new(dir, true, "default".into())
    }

    fn get(device: &Device, path: &str) -> Value {
        let response = device.handle("GET", path, b"");
        assert_eq!(response.status, 200, "{path}");
        serde_json::from_slice(&response.body).unwrap()
    }

    #[test]
    fn the_mock_answers_every_topic_and_commands_change_state() {
        let d = device();
        thread::sleep(Duration::from_millis(80));
        let caps = get(&d, "/dev/capabilities");
        assert_eq!(caps["mock"], true);
        assert_eq!(caps["ir"]["tx"], true);
        let motion = get(&d, "/dev/motion");
        assert_eq!(motion["available"], true);
        assert!(motion["heading"].is_number());
        assert_eq!(d.handle("POST", "/dev/motion/zero", b"").status, 204);
        assert_eq!(get(&d, "/dev/motion")["zeroed"], true);
        let battery = get(&d, "/dev/battery");
        assert_eq!(battery["status"], "Discharging");
        let system = get(&d, "/dev/system");
        assert_eq!(system["wifi"]["ssid"], "GL-SFT1200-128");
        assert_eq!(d.handle("POST", "/dev/system/backlight", br#"{"value":90}"#).status, 204);
        assert_eq!(get(&d, "/dev/system")["backlight"]["value"], 90);
        // Store round trip and key rules.
        assert_eq!(d.handle("PUT", "/dev/store/clock", br#"{"alarms":[1]}"#).status, 204);
        assert_eq!(get(&d, "/dev/store/clock")["alarms"][0], 1);
        assert_eq!(get(&d, "/dev/store/nothing"), Value::Null);
        assert_eq!(d.handle("PUT", "/dev/store/../etc", b"{}").status, 400);
        // Infrared: a sent NEC frame, a learned one saved under a name.
        assert_eq!(d.handle("POST", "/dev/ir/send", br#"{"address":4,"command":8}"#).status, 204);
        assert_eq!(d.handle("POST", "/dev/ir/learn", br#"{"on":true}"#).status, 204);
        assert_eq!(get(&d, "/dev/ir")["learning"], true);
        thread::sleep(Duration::from_millis(1800));
        let ir = get(&d, "/dev/ir");
        assert_eq!(ir["learning"], false);
        assert_eq!(ir["captured"]["protocol"], "NEC");
        assert_eq!(ir["captured"]["nec"]["command"], 8);
        assert_eq!(ir["lastSent"]["ok"], true);
        let saved = d.handle("POST", "/dev/ir/save", br#"{"name":"TV power"}"#);
        assert_eq!(saved.status, 200);
        let ir = get(&d, "/dev/ir");
        assert_eq!(ir["signals"][0]["name"], "TV power");
        assert!(ir["captured"].is_null());
        assert_eq!(d.handle("POST", "/dev/ir/send", br#"{"id":0}"#).status, 204);
        assert_eq!(d.handle("POST", "/dev/ir/send", br#"{"id":99}"#).status, 404);
        // Audio capture fills the meters; a recording lands in the list.
        assert_eq!(d.handle("POST", "/dev/audio/record", br#"{"on":true}"#).status, 204);
        thread::sleep(Duration::from_millis(400));
        let audio = get(&d, "/dev/audio");
        assert_eq!(audio["capturing"], true);
        assert!(audio["recording"]["seconds"].as_f64().unwrap() > 0.1);
        assert!(audio["pitch"]["note"].as_str().unwrap().starts_with('A'));
        assert_eq!(audio["spectrum"].as_array().unwrap().len(), dsp::BANDS);
        assert_eq!(d.handle("POST", "/dev/audio/capture", br#"{"on":false}"#).status, 204);
        thread::sleep(Duration::from_millis(150));
        let audio = get(&d, "/dev/audio");
        assert_eq!(audio["capturing"], false);
        assert!(audio["recording"].is_null());
        assert_eq!(audio["recordings"].as_array().unwrap().len(), 1);
        // Scans and the camera finish on their threads.
        assert_eq!(d.handle("POST", "/dev/radio/wifi/scan", b"").status, 204);
        assert_eq!(d.handle("POST", "/dev/camera/capture", br#"{"qr":true}"#).status, 204);
        assert_eq!(get(&d, "/dev/radio")["wifi"]["scanning"], true);
        thread::sleep(Duration::from_millis(2100));
        let radio = get(&d, "/dev/radio");
        assert_eq!(radio["wifi"]["scanning"], false);
        assert_eq!(radio["wifi"]["networks"][0]["active"], true);
        let camera = get(&d, "/dev/camera");
        assert_eq!(camera["busy"], false);
        assert_eq!(camera["last"]["qr"], "https://pocket.nexus");
        let thumbnail = d.handle("GET", "/dev/camera/thumbnail.rgb565", b"");
        assert_eq!((thumbnail.status, thumbnail.body.len()), (200, camera::THUMB_W * camera::THUMB_H * 2));
        assert_eq!(d.handle("GET", "/dev/nothing", b"").status, 404);
        let _ = std::fs::remove_dir_all(&d.0.store);
    }

    #[test]
    fn the_live_camera_streams_keeps_a_frame_as_a_photo_and_reads_a_code() {
        let d = device();
        assert_eq!(d.handle("POST", "/dev/camera/live", br#"{"on":true}"#).status, 204);
        assert_eq!(get(&d, "/dev/camera")["live"]["phase"], "starting");
        assert!(d.newest_frame(None).is_none());
        thread::sleep(Duration::from_millis(1900));
        let camera = get(&d, "/dev/camera");
        assert_eq!(camera["live"]["phase"], "live");
        assert!(camera["live"]["frame"].as_u64().unwrap() > 0);
        // The video plane takes each frame once.
        let (number, rgba) = d.newest_frame(None).unwrap();
        assert_eq!(rgba.len(), camera::TEXTURE_W * camera::TEXTURE_H * 4);
        assert!(d.newest_frame(Some(number)).is_none() || d.newest_frame(Some(number)).unwrap().0 != number);
        // A picture is the frame on screen, written at once.
        assert_eq!(d.handle("POST", "/dev/camera/capture", b"{}").status, 204);
        let camera = get(&d, "/dev/camera");
        assert_eq!(camera["busy"], false);
        assert_eq!(camera["last"]["width"], 640);
        assert_eq!(camera["photos"].as_array().unwrap().len(), 1);
        assert_eq!(d.handle("POST", "/dev/camera/scan", br#"{"on":true}"#).status, 204);
        thread::sleep(Duration::from_millis(2200));
        assert_eq!(get(&d, "/dev/camera")["live"]["qr"], "https://pocket.nexus");
        assert_eq!(d.handle("POST", "/dev/camera/live", br#"{"on":false}"#).status, 204);
        let camera = get(&d, "/dev/camera");
        assert_eq!(camera["live"]["phase"], "off");
        assert_eq!(camera["live"]["scanning"], false);
        let _ = std::fs::remove_dir_all(&d.0.store);
    }

    #[test]
    fn wav_headers_and_names_are_checked() {
        let header = wav_header(32000);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 32000);
        assert!(valid_key("ir-signals") && !valid_key("Ir") && !valid_key("a/b") && !valid_key(""));
        assert!(valid_name("TV power") && !valid_name("../x") && !valid_name(".hidden"));
    }
}
