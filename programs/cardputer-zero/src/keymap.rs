//! The CardputerZero's keyboard symbols. The kernel's tca8418 keymap puts the
//! symbol layer on key codes the US layout gives other keys (code 26 types
//! `!`, code 74 types `[`), and the vendor names them as X keysyms in
//! `/usr/share/keymaps/tca8418_keypad_m5stack_keymap.map` (`keycode 26 =
//! exclam`). The launcher's built-in table is the fallback when the file is
//! absent; both give the evdev decoder its `set_symbols` list.
// The panel and keyboard path runs on Linux only; the host build keeps the tables for its tests.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub const KEYMAP_PATH: &str = "/usr/share/keymaps/tca8418_keypad_m5stack_keymap.map";

/// The vendor launcher's built-in table (CardputerZero/launcher,
/// cp0_keyboard_keymap.c).
const DEFAULT: &[(u16, &str)] = &[
    (26, "exclam"),
    (27, "at"),
    (39, "numbersign"),
    (40, "dollar"),
    (41, "percent"),
    (43, "asciicircum"),
    (51, "ampersand"),
    (52, "asterisk"),
    (53, "parenleft"),
    (94, "parenright"),
    (55, "asciitilde"),
    (69, "grave"),
    (70, "underscore"),
    (71, "minus"),
    (72, "plus"),
    (73, "equal"),
    (74, "bracketleft"),
    (75, "bracketright"),
    (76, "braceleft"),
    (77, "braceright"),
    (79, "semicolon"),
    (80, "colon"),
    (81, "apostrophe"),
    (82, "quotedbl"),
    (83, "less"),
    (85, "greater"),
    (86, "backslash"),
    (89, "bar"),
    (90, "comma"),
    (91, "period"),
    (92, "slash"),
    (93, "question"),
];

/// The text an X keysym name types, for the names a small keyboard's map
/// uses. Editing keys take their KeyboardEvent.key names.
pub fn keysym_text(name: &str) -> Option<&'static str> {
    Some(match name {
        "exclam" => "!",
        "at" => "@",
        "numbersign" => "#",
        "dollar" => "$",
        "percent" => "%",
        "asciicircum" => "^",
        "ampersand" => "&",
        "asterisk" => "*",
        "parenleft" => "(",
        "parenright" => ")",
        "asciitilde" => "~",
        "grave" => "`",
        "underscore" => "_",
        "minus" => "-",
        "plus" => "+",
        "equal" => "=",
        "bracketleft" => "[",
        "bracketright" => "]",
        "braceleft" => "{",
        "braceright" => "}",
        "semicolon" => ";",
        "colon" => ":",
        "apostrophe" => "'",
        "quotedbl" => "\"",
        "less" => "<",
        "greater" => ">",
        "backslash" => "\\",
        "bar" => "|",
        "comma" => ",",
        "period" => ".",
        "slash" => "/",
        "question" => "?",
        "space" => " ",
        "Return" | "KP_Enter" => "Enter",
        "BackSpace" => "Backspace",
        "Escape" => "Escape",
        "Tab" => "Tab",
        "Delete" => "Delete",
        "Up" => "ArrowUp",
        "Down" => "ArrowDown",
        "Left" => "ArrowLeft",
        "Right" => "ArrowRight",
        "Home" => "Home",
        "End" => "End",
        _ => return None,
    })
}

/// Parse a keymap file: `keycode <n> = <keysym>` lines, `#` comments.
pub fn symbols_from(text: &str) -> Vec<(u16, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let body = line.split('#').next().unwrap_or("").trim();
        let Some(rest) = body.strip_prefix("keycode") else {
            continue;
        };
        let Some((code, name)) = rest.split_once('=') else {
            continue;
        };
        let Ok(code) = code.trim().parse::<u16>() else {
            continue;
        };
        if let Some(symbol) = keysym_text(name.trim()) {
            out.push((code, symbol.to_string()));
        }
    }
    out
}

/// The default table as `set_symbols` takes it.
pub fn default_symbols() -> Vec<(u16, String)> {
    DEFAULT
        .iter()
        .filter_map(|(code, name)| keysym_text(name).map(|text| (*code, text.to_string())))
        .collect()
}

/// The vendor's keymap file when it is present and names anything, else
/// the built-in table.
pub fn load() -> Vec<(u16, String)> {
    match std::fs::read_to_string(KEYMAP_PATH) {
        Ok(text) => {
            let symbols = symbols_from(&text);
            if symbols.is_empty() {
                default_symbols()
            } else {
                symbols
            }
        }
        Err(_) => default_symbols(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vendor_file_and_the_built_in_table_name_the_symbol_layer() {
        let parsed = symbols_from("# comment\nkeycode 26 = exclam\nkeycode 74 = bracketleft\nkeycode 9 = Unknown\nnonsense\n");
        assert_eq!(parsed, [(26, "!".to_string()), (74, "[".to_string())]);
        let defaults = default_symbols();
        assert_eq!(defaults.len(), DEFAULT.len());
        assert!(defaults.contains(&(92, "/".to_string())));
    }
}
