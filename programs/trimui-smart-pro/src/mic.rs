//! Voice input: the codec's MIC1 through the firmware's `arecord`, recognized on
//! this device by a small Mandarin/English Paraformer in its own process, so its
//! memory returns whenever a game has the machine.
use anyhow::{bail, Context, Result};
use std::{
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const SAMPLE_RATE: u32 = 16000;
const MAX_SECONDS: u32 = 60;
/// MIC1 analog gain: 25 of 31 keeps speech at arm's length below clipping.
const MIC_GAIN: &str = "25";
const MIC1_GAIN_CONTROL: &str = "numid=5";

pub struct Mic {
    child: Child,
    samples: Arc<Mutex<Vec<i16>>>,
    pub level: Arc<AtomicU32>,
    pub started: Instant,
}

impl Mic {
    pub fn start() -> Result<Self> {
        let _ = Command::new("amixer")
            .args(["cset", MIC1_GAIN_CONTROL, MIC_GAIN])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let mut child = Command::new("arecord")
            .args([
                "-q", "-D", "hw:0,0", "-f", "S16_LE", "-c", "2", "-r", "16000", "-t", "raw",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("arecord")?;
        let mut stdout = child.stdout.take().context("arecord stdout")?;
        let samples = Arc::new(Mutex::new(Vec::with_capacity((SAMPLE_RATE * 10) as usize)));
        let level = Arc::new(AtomicU32::new(0));
        let (sink, meter) = (samples.clone(), level.clone());
        std::thread::Builder::new()
            .name("mic".into())
            .spawn(move || {
                let mut buffer = vec![0u8; 3200];
                let mut mean = 0.0f32;
                loop {
                    let Ok(read) = stdout.read(&mut buffer) else {
                        break;
                    };
                    if read == 0 {
                        break;
                    }
                    let mut peak = 0i32;
                    let mut sink = sink.lock().unwrap();
                    if sink.len() >= (SAMPLE_RATE * MAX_SECONDS) as usize {
                        continue;
                    }
                    // The microphone is on the left channel; the right one is silent.
                    for frame in buffer[..read].chunks_exact(4) {
                        let sample = i16::from_le_bytes([frame[0], frame[1]]);
                        sink.push(sample);
                        mean += (sample as f32 - mean) * 0.001;
                        peak = peak.max((sample as i32 - mean as i32).abs());
                    }
                    meter.store(
                        ((peak as f32 / 16000.0).min(1.0) * 1000.0) as u32,
                        Ordering::Relaxed,
                    );
                }
            })?;
        Ok(Self {
            child,
            samples,
            level,
            started: Instant::now(),
        })
    }

    pub fn stop(mut self) -> Vec<i16> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::mem::take(&mut *self.samples.lock().unwrap())
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Remove DC and bring the peak to 70% of full scale. Silence stays silence.
pub fn condition(samples: &mut [i16]) {
    if samples.is_empty() {
        return;
    }
    let mean = samples.iter().map(|&s| s as i64).sum::<i64>() / samples.len() as i64;
    let mut peak = 1i32;
    for sample in samples.iter_mut() {
        let value = (*sample as i64 - mean).clamp(-32768, 32767) as i16;
        *sample = value;
        peak = peak.max((value as i32).abs());
    }
    if peak < 300 {
        return;
    }
    let gain = (22000.0 / peak as f32).min(12.0);
    for sample in samples.iter_mut() {
        *sample = (*sample as f32 * gain).clamp(-32768.0, 32767.0) as i16;
    }
}

/// The `"text"` field of a result the recognizer sends.
pub fn parse_result(message: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(message.trim()).ok()?;
    Some(value["text"].as_str()?.trim().to_owned())
}

pub struct Recognition {
    pub text: Result<String>,
    pub seconds: f32,
}

const PORT: u16 = 6006;

/// `sherpa-onnx-offline-websocket-server` with the model loaded. Loading takes
/// about 15 s on this CPU and decoding about 1 s, so the process stays up while
/// a voice prompt is possible and stops while a game has the machine.
pub struct Recognizer {
    child: Option<Child>,
}

impl Recognizer {
    pub fn new() -> Self {
        Self { child: None }
    }

    pub fn start(&mut self, asr: &Path) {
        if self.child.is_some() {
            return;
        }
        let program = asr.join("sherpa-onnx-offline-websocket-server");
        let spawned = Command::new("nice")
            .arg("-n")
            .arg("5")
            .arg(&program)
            .arg(format!("--port={PORT}"))
            .arg("--num-threads=3")
            .arg("--num-work-threads=1")
            .arg(format!(
                "--tokens={}",
                asr.join("model/tokens.txt").display()
            ))
            .arg(format!(
                "--paraformer={}",
                asr.join("model/model.int8.onnx").display()
            ))
            .env("LD_LIBRARY_PATH", asr.join("lib"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(child) => self.child = Some(child),
            Err(error) => eprintln!("pocket-studio: recognizer: {error}"),
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // `nice` execs the server, so this pid is the server's.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Decode on a background thread, waiting for the model if it is still loading.
pub fn recognize(samples: Vec<i16>) -> Receiver<Recognition> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("asr".into())
        .spawn(move || {
            let started = Instant::now();
            let text = decode_with_server(&samples);
            let _ = sender.send(Recognition {
                text,
                seconds: started.elapsed().as_secs_f32(),
            });
        })
        .expect("asr thread");
    receiver
}

fn decode_with_server(samples: &[i16]) -> Result<String> {
    let mut stream = None;
    for _ in 0..120 {
        if let Ok(connected) = TcpStream::connect(("127.0.0.1", PORT)) {
            stream = Some(connected);
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let mut stream = stream.context("the recognizer did not start")?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    stream.write_all(handshake().as_bytes())?;
    read_handshake(&mut stream)?;
    let mut payload = Vec::with_capacity(8 + samples.len() * 4);
    payload.extend_from_slice(&(SAMPLE_RATE as i32).to_le_bytes());
    payload.extend_from_slice(&((samples.len() * 4) as i32).to_le_bytes());
    for &sample in samples {
        payload.extend_from_slice(&(sample as f32 / 32768.0).to_le_bytes());
    }
    stream.write_all(&client_frame(2, &payload))?;
    let message = read_text_frame(&mut stream)?;
    let _ = stream.write_all(&client_frame(1, b"Done"));
    parse_result(&message).with_context(|| {
        format!(
            "no text in: {}",
            message.chars().take(200).collect::<String>()
        )
    })
}

fn handshake() -> String {
    format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: cG9ja2V0LXN0dWRpby1rZXk=\r\nSec-WebSocket-Version: 13\r\n\r\n")
}

fn read_handshake(stream: &mut impl Read) -> Result<()> {
    let mut seen = Vec::new();
    let mut byte = [0u8];
    while !seen.ends_with(b"\r\n\r\n") {
        stream
            .read_exact(&mut byte)
            .context("recognizer handshake")?;
        seen.push(byte[0]);
        if seen.len() > 8192 {
            bail!("recognizer handshake too long");
        }
    }
    if !seen.starts_with(b"HTTP/1.1 101") {
        bail!(
            "recognizer refused: {}",
            String::from_utf8_lossy(&seen[..seen.len().min(80)])
        );
    }
    Ok(())
}

/// A masked client frame. The zero mask leaves the payload as is.
pub fn client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x80 | opcode);
    match payload.len() {
        length if length < 126 => frame.push(0x80 | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&[0; 4]);
    frame.extend_from_slice(payload);
    frame
}

/// Read server frames until a text frame arrives. Server frames are not masked.
pub fn read_text_frame(stream: &mut impl Read) -> Result<String> {
    loop {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).context("recognizer closed")?;
        let opcode = head[0] & 0x0f;
        let length = match head[1] & 0x7f {
            126 => {
                let mut bytes = [0u8; 2];
                stream.read_exact(&mut bytes)?;
                u16::from_be_bytes(bytes) as usize
            }
            127 => {
                let mut bytes = [0u8; 8];
                stream.read_exact(&mut bytes)?;
                u64::from_be_bytes(bytes) as usize
            }
            short => short as usize,
        };
        anyhow::ensure!(length < 4 * 1024 * 1024, "oversized recognizer frame");
        let mut payload = vec![0u8; length];
        stream.read_exact(&mut payload)?;
        match opcode {
            1 => return Ok(String::from_utf8_lossy(&payload).into_owned()),
            8 => bail!("recognizer closed the connection"),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_removes_dc_and_normalizes() {
        let mut samples: Vec<i16> = (0..1000)
            .map(|i| 500 + if i % 2 == 0 { 2000 } else { -2000 })
            .collect();
        condition(&mut samples);
        let mean: i64 = samples.iter().map(|&s| s as i64).sum::<i64>() / samples.len() as i64;
        assert!(mean.abs() < 2);
        assert!(samples.iter().any(|&s| s > 20000));
        let mut quiet = vec![10i16, -10, 10, -10];
        condition(&mut quiet);
        assert!(quiet.iter().all(|&s| s.abs() < 20));
    }

    #[test]
    fn reads_the_recognizers_result() {
        assert_eq!(
            parse_result("{\"lang\": \"\", \"text\": \" 做一个游戏 \", \"tokens\": []}").as_deref(),
            Some("做一个游戏")
        );
        assert_eq!(parse_result("nothing"), None);
    }

    #[test]
    fn frames_follow_the_websocket_layout() {
        let short = client_frame(1, b"Done");
        assert_eq!(&short[..2], &[0x81, 0x84]);
        assert_eq!(&short[2..6], &[0; 4]);
        assert_eq!(&short[6..], b"Done");
        let long = client_frame(2, &vec![7u8; 70000]);
        assert_eq!(&long[..2], &[0x82, 0x80 | 127]);
        assert_eq!(u64::from_be_bytes(long[2..10].try_into().unwrap()), 70000);

        let mut input: &[u8] = &[0x89, 0x01, b'x', 0x81, 0x02, b'h', b'i'];
        assert_eq!(read_text_frame(&mut input).unwrap(), "hi");
        let mut closed: &[u8] = &[0x88, 0x00];
        assert!(read_text_frame(&mut closed).is_err());
    }
}
