//! Line protocol for native/worker equivalence and performance measurements.
//! Font I/O and every request execute on this process's service thread.
use std::io::{BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut engine = pocket_text::Engine::new();
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path)?;
        if path.ends_with(".pak") {
            engine.load_pak(&bytes);
        } else if !engine.load_font(&bytes) {
            return Err(format!("Invalid font: {path}").into());
        }
    }
    let input = std::io::stdin();
    let mut output = std::io::stdout().lock();
    for line in input.lock().lines() {
        writeln!(output, "{}", engine.reply(&line?))?;
        output.flush()?;
    }
    Ok(())
}
