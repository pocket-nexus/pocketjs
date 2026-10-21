fn button_for(key: &str) -> Option<u32> {
    Some(match key {
        "up" => BTN_UP,
        "down" => BTN_DOWN,
        "left" => BTN_LEFT,
        "right" => BTN_RIGHT,
        "z" | "enter" => BTN_CROSS,
        "x" | "backspace" => BTN_CIRCLE,
        "a" => BTN_SQUARE,
        "s" => BTN_TRIANGLE,
        "q" | "l" => BTN_LTRIGGER,
        "w" | "r" => BTN_RTRIGGER,
        "tab" => BTN_SELECT,
        "space" => BTN_START,
        _ => return None,
    })
}
fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
