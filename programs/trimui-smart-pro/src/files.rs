//! The agent's file tools, confined to one game's directory.
use anyhow::{anyhow, bail, Result};
use std::path::{Component, Path, PathBuf};

const READ_LIMIT: usize = 64 * 1024;
const WRITE_LIMIT: usize = 256 * 1024;

pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    let mut out = root.to_owned();
    let mut depth = 0;
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                out.push(name);
                depth += 1;
            }
            Component::CurDir => {}
            _ => bail!("{relative}: paths stay inside the game's directory"),
        }
    }
    anyhow::ensure!(depth > 0, "empty path");
    Ok(out)
}

pub fn list(root: &Path) -> String {
    fn walk(directory: &Path, prefix: &str, out: &mut String) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                walk(&entry.path(), &format!("{prefix}{name}/"), out);
            } else if !matches!(name.as_str(), "shot.png" | "save.json") {
                out.push_str(&format!("{prefix}{name} ({} bytes)\n", metadata.len()));
            }
        }
    }
    let mut out = String::new();
    walk(root, "", &mut out);
    if out.is_empty() {
        out.push_str("(empty)\n");
    }
    out
}

pub fn read(root: &Path, relative: &str) -> Result<String> {
    let text = std::fs::read_to_string(resolve(root, relative)?)
        .map_err(|error| anyhow!("{relative}: {error}"))?;
    if text.len() > READ_LIMIT {
        let mut end = READ_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(format!(
            "{}\n(truncated at {READ_LIMIT} bytes of {})",
            &text[..end],
            text.len()
        ));
    }
    Ok(text)
}

/// Write a file; a TypeScript file's syntax errors come back in the reply.
pub fn write(root: &Path, relative: &str, content: &str) -> Result<String> {
    anyhow::ensure!(
        content.len() <= WRITE_LIMIT,
        "{relative}: larger than {WRITE_LIMIT} bytes"
    );
    let path = resolve(root, relative)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    Ok(format!(
        "wrote {relative} ({} bytes){}",
        content.len(),
        syntax_note(relative, content)
    ))
}

/// Replace the one occurrence of `old` with `new`.
pub fn edit(root: &Path, relative: &str, old: &str, new: &str) -> Result<String> {
    let path = resolve(root, relative)?;
    let text = std::fs::read_to_string(&path).map_err(|error| anyhow!("{relative}: {error}"))?;
    let count = text.matches(old).count();
    if count != 1 {
        bail!("{relative}: `old` occurs {count} times; it must occur once");
    }
    let updated = text.replacen(old, new, 1);
    std::fs::write(&path, &updated)?;
    Ok(format!(
        "edited {relative}{}",
        syntax_note(relative, &updated)
    ))
}

fn syntax_note(relative: &str, content: &str) -> String {
    if !(relative.ends_with(".ts") || relative.ends_with(".js")) {
        return String::new();
    }
    match pocket_arcade::script::strip(relative, content) {
        Ok(_) => String::new(),
        Err(errors) => format!("\nSYNTAX ERRORS:\n{errors}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("pocket-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn paths_stay_inside_the_game() {
        let root = scratch("paths");
        assert!(resolve(&root, "../auth.json").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "a/../../b").is_err());
        assert!(resolve(&root, "").is_err());
        assert_eq!(resolve(&root, "./src/x.ts").unwrap(), root.join("src/x.ts"));
    }

    #[test]
    fn write_edit_read_and_report_syntax() {
        let root = scratch("edit");
        assert!(!write(&root, "src/a.ts", "const a: number = 1;\n")
            .unwrap()
            .contains("SYNTAX"));
        assert_eq!(read(&root, "src/a.ts").unwrap(), "const a: number = 1;\n");
        assert!(edit(&root, "src/a.ts", "a: number", "b: number")
            .unwrap()
            .starts_with("edited"));
        assert!(edit(&root, "src/a.ts", "missing", "x").is_err());
        assert!(write(&root, "b.ts", "const = ;\n")
            .unwrap()
            .contains("SYNTAX ERRORS"));
        assert!(list(&root).contains("src/a.ts"));
    }
}
