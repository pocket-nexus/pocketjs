//! The Zero's hardware through Linux: IIO sysfs for the BMI270 and BMM150,
//! the power supply class for the BQ27220 gauge, /proc and /sys for the
//! system, NetworkManager and BlueZ command-line tools for scans, ALSA's
//! arecord/aplay for the microphone and speaker, rpicam-still for the camera
//! and zbarimg for QR codes. Every reader returns None or an error string
//! when its device or tool is absent; nothing here panics.

use super::pose::Vec3;
use super::{BleDevice, Network};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|text| text.trim().to_string())
}

fn read_f32(path: &Path) -> Option<f32> {
    read_trimmed(path)?.parse().ok()
}

/// A tool on PATH.
pub fn tool(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .chain(["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(PathBuf::from))
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

fn run(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("{program}: {error}")),
        }
    }
    let output = child.wait_with_output().map_err(|error| format!("{program}: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() || !text.is_empty() {
        Ok(text)
    } else {
        Err(format!("{program}: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

// ---- IIO ------------------------------------------------------------------

pub struct Iio {
    pub accel: Option<PathBuf>,
    pub accel_scale: f32,
    pub gyro_scale: f32,
    pub mag: Option<PathBuf>,
    pub mag_scale: f32,
}

/// Find the IMU and magnetometer under /sys/bus/iio/devices by name.
pub fn probe_iio() -> Iio {
    let mut probe = Iio { accel: None, accel_scale: 1.0, gyro_scale: 1.0, mag: None, mag_scale: 1.0 };
    let Ok(entries) = fs::read_dir("/sys/bus/iio/devices") else {
        return probe;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = read_trimmed(&path.join("name")) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.contains("bmi270") || (path.join("in_accel_x_raw").exists() && probe.accel.is_none()) {
            probe.accel_scale = read_f32(&path.join("in_accel_scale")).unwrap_or(1.0);
            probe.gyro_scale = read_f32(&path.join("in_anglvel_scale")).unwrap_or(1.0);
            probe.accel = Some(path.clone());
        }
        if lower.contains("bmm150") || (path.join("in_magn_x_raw").exists() && probe.mag.is_none()) {
            probe.mag_scale = read_f32(&path.join("in_magn_scale")).unwrap_or(1.0);
            probe.mag = Some(path.clone());
        }
    }
    probe
}

fn read_axes(dir: &Path, prefix: &str, scale: f32) -> Option<Vec3> {
    let axis = |name: &str| read_f32(&dir.join(format!("in_{prefix}_{name}_raw"))).map(|raw| raw * scale);
    Some(Vec3::new(axis("x")?, axis("y")?, axis("z")?))
}

/// Acceleration in m/s² and angular rate in rad/s, sensor axes.
pub fn read_imu(probe: &Iio) -> Option<(Vec3, Vec3)> {
    let dir = probe.accel.as_ref()?;
    let accel = read_axes(dir, "accel", probe.accel_scale)?;
    let gyro = read_axes(dir, "anglvel", probe.gyro_scale).unwrap_or_default();
    Some((accel, gyro))
}

/// Magnetic field in µT (IIO reports gauss), sensor axes.
pub fn read_mag(probe: &Iio) -> Option<Vec3> {
    let dir = probe.mag.as_ref()?;
    read_axes(dir, "magn", probe.mag_scale * 100.0)
}

// ---- battery -----------------------------------------------------------------

pub struct BatteryReading {
    pub percent: Option<u8>,
    pub voltage: Option<f32>,
    pub current: Option<f32>,
    pub status: String,
    pub temp: Option<f32>,
}

pub fn read_battery() -> Option<BatteryReading> {
    let entries = fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if read_trimmed(&path.join("type")).as_deref() != Some("Battery") {
            continue;
        }
        return Some(BatteryReading {
            percent: read_f32(&path.join("capacity")).map(|v| v.clamp(0.0, 100.0) as u8),
            voltage: read_f32(&path.join("voltage_now")).map(|v| v / 1_000_000.0),
            current: read_f32(&path.join("current_now")).map(|v| v / 1_000_000.0),
            status: read_trimmed(&path.join("status")).unwrap_or_else(|| "Unknown".into()),
            temp: read_f32(&path.join("temp")).map(|v| v / 10.0),
        });
    }
    None
}

// ---- system ---------------------------------------------------------------------

pub fn uptime_seconds() -> Option<f64> {
    read_trimmed(Path::new("/proc/uptime"))?.split_whitespace().next()?.parse().ok()
}

pub fn load_average() -> Option<[f32; 3]> {
    let text = read_trimmed(Path::new("/proc/loadavg"))?;
    let mut parts = text.split_whitespace();
    Some([parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?])
}

/// Used and total memory in MiB.
pub fn memory() -> Option<(u32, u32)> {
    let text = fs::read_to_string("/proc/meminfo").ok()?;
    let field = |name: &str| -> Option<u64> {
        text.lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse().ok())
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:")?;
    Some((((total - available) / 1024) as u32, (total / 1024) as u32))
}

pub fn cpu_temperature() -> Option<f32> {
    read_f32(Path::new("/sys/class/thermal/thermal_zone0/temp")).map(|v| v / 1000.0)
}

pub fn hostname() -> Option<String> {
    read_trimmed(Path::new("/etc/hostname")).or_else(|| read_trimmed(Path::new("/proc/sys/kernel/hostname")))
}

/// The first IPv4 address `hostname -I` lists.
pub fn ip_address() -> Option<String> {
    let text = run("hostname", &["-I"], Duration::from_secs(2)).ok()?;
    text.split_whitespace().find(|word| word.contains('.')).map(str::to_string)
}

/// Used and total bytes of the root file system.
pub fn disk() -> Option<(u64, u64)> {
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let path = std::ffi::CString::new("/").ok()?;
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let total = stat.f_blocks as u64 * stat.f_frsize as u64;
    let free = stat.f_bavail as u64 * stat.f_frsize as u64;
    Some((total.saturating_sub(free), total))
}

/// The Wi-Fi link: SSID (NetworkManager), signal level in dBm and link
/// quality 0..100 (/proc/net/wireless).
pub fn wifi_link() -> (Option<String>, Option<i32>, Option<u8>) {
    let mut rssi = None;
    let mut link = None;
    if let Ok(text) = fs::read_to_string("/proc/net/wireless") {
        for line in text.lines().skip(2) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 4 {
                link = fields[2].trim_end_matches('.').parse::<f32>().ok().map(|q| (q / 70.0 * 100.0).clamp(0.0, 100.0) as u8);
                rssi = fields[3].trim_end_matches('.').parse::<f32>().ok().map(|v| v as i32);
                break;
            }
        }
    }
    let ssid = tool("nmcli").and_then(|_| {
        run("nmcli", &["-t", "-f", "ACTIVE,SSID", "dev", "wifi", "list", "--rescan", "no"], Duration::from_secs(3))
            .ok()?
            .lines()
            .find(|line| line.starts_with("yes:"))
            .map(|line| unescape_nmcli(&line[4..]))
    });
    (ssid, rssi, link)
}

fn unescape_nmcli(text: &str) -> String {
    text.replace("\\:", ":").replace("\\\\", "\\")
}

/// Split one `nmcli -t` line on unescaped colons.
fn nmcli_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                current.push(next);
            }
        } else if c == ':' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    fields.push(current);
    fields
}

pub fn wifi_scan() -> Result<Vec<Network>, String> {
    if tool("nmcli").is_none() {
        return Err("nmcli is not installed".into());
    }
    let text = run(
        "nmcli",
        &["-t", "-f", "ACTIVE,SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY", "dev", "wifi", "list", "--rescan", "yes"],
        Duration::from_secs(20),
    )?;
    let mut networks: Vec<Network> = text
        .lines()
        .filter_map(|line| {
            let f = nmcli_fields(line);
            if f.len() < 7 {
                return None;
            }
            Some(Network {
                active: f[0] == "yes",
                ssid: f[1].clone(),
                bssid: f[2].clone(),
                signal: f[3].parse().unwrap_or(0),
                freq_mhz: f[4].split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0),
                channel: f[5].parse().unwrap_or(0),
                security: if f[6].is_empty() { "--".into() } else { f[6].clone() },
            })
        })
        .collect();
    networks.sort_by(|a, b| b.active.cmp(&a.active).then(b.signal.cmp(&a.signal)));
    Ok(networks)
}

pub fn ble_scan(seconds: u32) -> Result<Vec<BleDevice>, String> {
    if tool("bluetoothctl").is_none() {
        return Err("bluetoothctl is not installed".into());
    }
    // The Zero boots with the adapter off.
    let _ = run("bluetoothctl", &["power", "on"], Duration::from_secs(5));
    let timeout = seconds.to_string();
    let text = run("bluetoothctl", &["--timeout", &timeout, "scan", "on"], Duration::from_secs(seconds as u64 + 5))?;
    let mut devices: Vec<BleDevice> = Vec::new();
    for raw in text.lines() {
        // Lines carry terminal colour codes: strip escapes before reading.
        let line = strip_ansi(raw);
        let Some(at) = line.find("Device ") else {
            continue;
        };
        let rest = &line[at + 7..];
        let mut parts = rest.splitn(2, ' ');
        let Some(address) = parts.next() else {
            continue;
        };
        if address.len() != 17 {
            continue;
        }
        let tail = parts.next().unwrap_or("").trim();
        let entry = match devices.iter_mut().find(|d| d.address == address) {
            Some(entry) => entry,
            None => {
                devices.push(BleDevice { address: address.to_string(), name: None, rssi: None });
                devices.last_mut().unwrap()
            }
        };
        if let Some(value) = tail.strip_prefix("RSSI:") {
            entry.rssi = value.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if let Some(value) = tail.strip_prefix("Name:") {
            entry.name = Some(value.trim().to_string());
        } else if line.contains("[NEW]") && !tail.is_empty() && tail != address {
            entry.name = Some(tail.to_string());
        }
    }
    devices.sort_by(|a, b| b.rssi.unwrap_or(-200).cmp(&a.rssi.unwrap_or(-200)));
    Ok(devices)
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---- backlight and volume --------------------------------------------------

fn backlight_dir() -> Option<PathBuf> {
    fs::read_dir("/sys/class/backlight").ok()?.filter_map(Result::ok).map(|e| e.path()).next()
}

pub fn backlight() -> Option<(u32, u32)> {
    let dir = backlight_dir()?;
    Some((read_f32(&dir.join("brightness"))? as u32, read_f32(&dir.join("max_brightness"))? as u32))
}

pub fn set_backlight(value: u32) -> Result<(), String> {
    let dir = backlight_dir().ok_or("no backlight device")?;
    let max = read_f32(&dir.join("max_brightness")).unwrap_or(255.0) as u32;
    fs::write(dir.join("brightness"), value.min(max).to_string()).map_err(|e| e.to_string())
}

const MIXERS: [&str; 4] = ["Speaker", "Master", "PCM", "Headphone"];

/// The codec's ALSA card by name (`/proc/asound/cards`): the Zero's ES8389
/// is card 1 behind the HDMI card, and `default` has no capture slave, so
/// the microphone and the speaker are addressed by card name.
pub fn audio_card() -> Option<String> {
    let text = fs::read_to_string("/proc/asound/cards").ok()?;
    let mut cards: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let open = line.find('[')?;
            let close = line[open..].find(']')? + open;
            Some(line[open + 1..close].trim().to_string())
        })
        .filter(|name| !name.is_empty())
        .collect();
    cards.sort_by_key(|name| if name.to_ascii_lowercase().contains("hdmi") { 1 } else { 0 });
    cards.into_iter().next()
}

/// The PCM device of a configured name, or the codec card's first device.
pub fn pcm_device(configured: &str) -> String {
    if configured != "auto" {
        return configured.to_string();
    }
    match audio_card() {
        Some(card) => format!("plughw:CARD={card},DEV=0"),
        None => "default".into(),
    }
}

fn mixer_args<'a>(card: &'a Option<String>, rest: &[&'a str]) -> Vec<&'a str> {
    let mut args: Vec<&str> = Vec::new();
    if let Some(name) = card {
        args.push("-c");
        args.push(name.as_str());
    }
    args.extend_from_slice(rest);
    args
}

pub fn volume() -> Option<u8> {
    tool("amixer")?;
    let card = audio_card();
    for mixer in MIXERS {
        if let Ok(text) = run("amixer", &mixer_args(&card, &["sget", mixer]), Duration::from_secs(2)) {
            if let Some(percent) = text.split('[').skip(1).find_map(|part| part.split('%').next().and_then(|v| v.parse::<u8>().ok())) {
                return Some(percent);
            }
        }
    }
    None
}

pub fn set_volume(value: u8) -> Result<(), String> {
    tool("amixer").ok_or("amixer is not installed")?;
    let card = audio_card();
    let level = format!("{}%", value.min(100));
    for mixer in MIXERS {
        if run("amixer", &mixer_args(&card, &["sset", mixer, &level]), Duration::from_secs(2)).is_ok() {
            return Ok(());
        }
    }
    Err("no mixer control answered".into())
}

// ---- audio -------------------------------------------------------------------

const PGA_CONTROLS: [&str; 2] = ["ADCL PGA Volume", "ADCR PGA Volume"];

/// Read one integer mixer control by name.
fn mixer_value(card: &Option<String>, name: &str) -> Option<i64> {
    let selector = format!("name={name}");
    let text = run("amixer", &mixer_args(card, &["cget", &selector]), Duration::from_secs(2)).ok()?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix(": values="))
        .and_then(|values| values.split(',').next())
        .and_then(|value| value.trim().parse().ok())
}

fn set_mixer_value(card: &Option<String>, name: &str, value: i64) -> bool {
    let selector = format!("name={name}");
    let text = value.to_string();
    run("amixer", &mixer_args(card, &["cset", &selector, &text]), Duration::from_secs(2)).is_ok()
}

/// Set the microphone preamplifier to its maximum while a tool listens, and
/// hand back what it was. **The ES8389's PGA at the vendor's 8 of 14 leaves
/// a quiet room at about -71 dBFS; at 14 it reads about -53 dBFS**, which
/// the meters, the tuner and the recorder can work with.
pub fn capture_gain_up() -> Vec<(String, i64)> {
    if tool("amixer").is_none() {
        return Vec::new();
    }
    let card = audio_card();
    let mut previous = Vec::new();
    for name in PGA_CONTROLS {
        if let Some(value) = mixer_value(&card, name) {
            previous.push((name.to_string(), value));
            set_mixer_value(&card, name, 14);
        }
    }
    previous
}

/// Put the preamplifier back as `capture_gain_up` found it.
pub fn capture_gain_restore(previous: &[(String, i64)]) {
    let card = audio_card();
    for (name, value) in previous {
        set_mixer_value(&card, name, *value);
    }
}

/// Start `arecord` as a raw 16 kHz mono S16LE stream on its stdout.
pub fn spawn_capture(device: &str) -> Result<std::process::Child, String> {
    tool("arecord").ok_or("arecord is not installed")?;
    let pcm = pcm_device(device);
    Command::new("arecord")
        .args(["-q", "-D", &pcm, "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("arecord: {error}"))
}

pub fn play(device: &str, path: &Path) -> Result<std::process::Child, String> {
    tool("aplay").ok_or("aplay is not installed")?;
    let pcm = pcm_device(device);
    Command::new("aplay")
        .args(["-q", "-D", &pcm])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("aplay: {error}"))
}

// ---- camera ------------------------------------------------------------------

pub fn camera_tool() -> Option<PathBuf> {
    tool("rpicam-still").or_else(|| tool("libcamera-still"))
}

/// Take one 640x360 JPEG after 1.5 s of exposure and white balance settling
/// (`--immediate` captures the sensor's first frame, which is near black
/// indoors). The sensor is powered by the device tree (`dtoverlay=imx219`);
/// BCM GPIO 18 is the codec's I2S clock, not a camera enable, so nothing
/// here touches pins.
pub fn capture_jpeg(tool_path: &Path, output: &Path) -> Result<(), String> {
    let output_text = output.to_string_lossy().to_string();
    let result = run(
        &tool_path.to_string_lossy(),
        &["-n", "-t", "1500", "--width", "640", "--height", "360", "--hflip", "--vflip", "-e", "jpg", "-o", &output_text],
        Duration::from_secs(20),
    );
    match result {
        Ok(_) if output.exists() => Ok(()),
        Ok(_) => Err("the camera wrote no picture".into()),
        Err(error) => Err(error),
    }
}

/// Decode `path` and box-sample it to a 256x128 RGBA picture.
pub fn preview_rgba(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    super::camera::texture(&bytes)
}

/// The text of the first QR code in the picture (camera.rs, rqrr).
pub fn read_qr(path: &Path) -> Result<Option<String>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    super::camera::read_qr(&bytes)
}

pub fn live_tool() -> Option<PathBuf> {
    tool("rpicam-vid").or_else(|| tool("libcamera-vid"))
}

/// The live stream: 640x360 MJPEG at up to 15 frames a second on stdout,
/// each frame flushed as it is encoded, until killed. The CardputerZero's
/// camera module is mounted turned half a turn (its picture was upside down
/// and mirrored on the device, 2026-10-28), so the stream and the still are
/// flipped on both axes.
pub fn live_stream() -> Result<std::process::Child, String> {
    use super::camera::{FRAMERATE, HEIGHT, WIDTH};
    let path = live_tool().ok_or("no rpicam-vid")?;
    std::process::Command::new(path)
        .args(["-n", "-t", "0", "--width", &WIDTH.to_string(), "--height", &HEIGHT.to_string(), "--framerate", &FRAMERATE.to_string(), "--hflip", "--vflip", "--codec", "mjpeg", "-q", "80", "--flush", "-o", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("rpicam-vid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nmcli_lines_split_on_unescaped_colons_and_ansi_is_stripped() {
        let fields = nmcli_fields("yes:My\\:Net:94\\:83\\:C4\\:94\\:61\\:29:70:5745 MHz:149:WPA2");
        assert_eq!(fields, ["yes", "My:Net", "94:83:C4:94:61:29", "70", "5745 MHz", "149", "WPA2"]);
        assert_eq!(strip_ansi("\u{1b}[0;93m[CHG]\u{1b}[0m Device AA RSSI: -60"), "[CHG] Device AA RSSI: -60");
    }
}
