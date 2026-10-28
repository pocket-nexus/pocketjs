//! Stand-in readings for a program running without the Zero's hardware
//! (`--mock`): every value is a function of the seconds since start, so a
//! headless shot shows live instruments and two runs look alike.

use super::pose::Vec3;
use super::{BleDevice, Network};

pub fn accel(t: f64) -> Vec3 {
    let pitch = (6.0 * (t / 3.0).sin()) as f32;
    let roll = (4.0 * (t / 2.3).cos()) as f32;
    let (p, r) = (pitch.to_radians(), roll.to_radians());
    Vec3::new(9.81 * r.sin(), 9.81 * p.sin(), 9.81 * p.cos() * r.cos())
}

pub fn gyro(t: f64) -> Vec3 {
    Vec3::new((2.0 * (t / 3.0).cos()) as f32, (-1.7 * (t / 2.3).sin()) as f32, 0.3)
}

/// A field whose horizontal part turns 12° a second, with the panel flat.
pub fn mag(t: f64) -> Vec3 {
    let heading = (t * 12.0).to_radians() as f32;
    // North ahead at t = 0: the field points up the panel (and down, -z,
    // as in the northern hemisphere). A heading of h turns the field by -h.
    Vec3::new(-28.0 * heading.sin(), 28.0 * heading.cos(), -40.0)
}

pub fn battery_percent(t: f64) -> u8 {
    (73.0 - t / 600.0).max(5.0) as u8
}

pub fn networks(t: f64) -> Vec<Network> {
    let wobble = |phase: f64| ((t / 4.0 + phase).sin() * 4.0) as i32;
    vec![
        Network { ssid: "GL-SFT1200-128".into(), bssid: "94:83:C4:94:61:29".into(), signal: (70 + wobble(0.0)) as u8, freq_mhz: 5745, channel: 149, security: "WPA2".into(), active: true },
        Network { ssid: "Pocket Studio".into(), bssid: "A4:2B:B0:11:22:33".into(), signal: (54 + wobble(1.0)) as u8, freq_mhz: 2437, channel: 6, security: "WPA2".into(), active: false },
        Network { ssid: "cafe-guest".into(), bssid: "F0:9F:C2:44:55:66".into(), signal: (38 + wobble(2.0)) as u8, freq_mhz: 2412, channel: 1, security: "--".into(), active: false },
        Network { ssid: "DIRECT-7A-HP M15".into(), bssid: "3C:A8:2A:77:88:99".into(), signal: (22 + wobble(3.0)) as u8, freq_mhz: 2462, channel: 11, security: "WPA2".into(), active: false },
        Network { ssid: "".into(), bssid: "00:11:22:AA:BB:CC".into(), signal: (15 + wobble(4.0)) as u8, freq_mhz: 5180, channel: 36, security: "WPA3".into(), active: false },
    ]
}

pub fn ble_devices(t: f64) -> Vec<BleDevice> {
    let wobble = |phase: f64| ((t / 3.0 + phase).sin() * 5.0) as i32;
    vec![
        BleDevice { address: "D4:3A:2C:10:20:30".into(), name: Some("Pocket Companion".into()), rssi: Some(-52 + wobble(0.0)) },
        BleDevice { address: "7C:2F:80:AA:01:02".into(), name: Some("Nintendo RVL-CNT-01".into()), rssi: Some(-71 + wobble(1.0)) },
        BleDevice { address: "5E:91:0B:33:44:55".into(), name: None, rssi: Some(-84 + wobble(2.0)) },
    ]
}

/// A 32 ms block of a tone whose pitch and loudness drift.
pub fn audio_block(t: f64) -> Vec<i16> {
    let hz = 440.0 * (1.0 + 0.004 * (t / 2.0).sin());
    let amplitude = 0.25 + 0.2 * (t * 1.3).sin();
    (0..super::dsp::BLOCK)
        .map(|i| {
            let phase = 2.0 * std::f64::consts::PI * hz * (t + i as f64 / super::dsp::RATE as f64);
            let noise = ((i as f64 * 12.9898 + t * 78.233).sin() * 43758.5453).fract() - 0.5;
            ((amplitude * phase.sin() + 0.02 * noise) * 32767.0) as i16
        })
        .collect()
}

/// A 256x128 RGBA test picture: a sky-to-floor gradient, a grid and a
/// marker in the centre.
pub fn picture(t: f64) -> Vec<u8> {
    let (w, h) = (256usize, 128usize);
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let at = (y * w + x) * 4;
            let sky = 1.0 - y as f32 / h as f32;
            let (mut r, mut g, mut b) = (40.0 + 80.0 * sky, 60.0 + 100.0 * sky, 110.0 + 120.0 * sky);
            if x % 32 == 0 || y % 32 == 0 {
                r *= 0.6;
                g *= 0.6;
                b *= 0.6;
            }
            let dx = x as f32 - 128.0 + 20.0 * (t / 2.0).sin() as f32;
            let dy = y as f32 - 64.0;
            if (dx * dx + dy * dy).sqrt() < 18.0 {
                r = 255.0;
                g = 210.0;
                b = 63.0;
            }
            out[at] = r as u8;
            out[at + 1] = g as u8;
            out[at + 2] = b as u8;
            out[at + 3] = 255;
        }
    }
    out
}
