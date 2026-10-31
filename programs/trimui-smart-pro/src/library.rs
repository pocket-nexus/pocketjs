//! The games on this console: one directory each under `<data>/games`.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub tagline: String,
    pub summary: String,
    pub color: String,
    pub modified: u64,
}

const STARTER: &str = r#"import { camera, game, hud, scene, spawn } from "@pocketjs/framework/arcade";

let cube: ReturnType<typeof spawn>;

export default game({
  setup() {
    scene.sky(0x241b3e);
    spawn({ shape: "plane", sx: 20, sz: 20, color: 0x3a2f63 });
    cube = spawn({ y: 1, color: 0xffd23f, shadow: true });
  },
  update(dt) {
    cube.ry += dt;
    camera.look(4, 4, 6, 0, 0.5, 0);
  },
  draw() {
    hud.text("new game", 640, 40, { align: "center" });
  },
});
"#;

pub struct Library {
    root: PathBuf,
}

impl Library {
    pub fn new(data: &Path) -> Self {
        let root = data.join("games");
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    pub fn directory(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// Finished games, newest first. A directory without game.json is a draft.
    pub fn list(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let Ok(directories) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for directory in directories.filter_map(Result::ok) {
            let path = directory.path().join("game.json");
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let modified = std::fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            let get = |key: &str| meta[key].as_str().unwrap_or("").to_owned();
            out.push(Entry {
                id: directory.file_name().to_string_lossy().into_owned(),
                title: get("title"),
                tagline: get("tagline"),
                summary: get("summary"),
                color: get("color"),
                modified,
            });
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// A new draft with a starter main.ts.
    pub fn create(&self) -> std::io::Result<String> {
        let mut index = 1;
        loop {
            let id = format!("game-{index:04}");
            let directory = self.directory(&id);
            if !directory.exists() {
                std::fs::create_dir_all(&directory)?;
                std::fs::write(directory.join("main.ts"), STARTER)?;
                return Ok(id);
            }
            index += 1;
        }
    }

    pub fn remove(&self, id: &str) -> std::io::Result<()> {
        if id.is_empty() || id.contains('/') || id.contains("..") {
            return Ok(());
        }
        std::fs::remove_dir_all(self.directory(id))
    }
}

pub fn entry_json(entry: &Entry) -> Value {
    json!({ "id": entry.id, "title": entry.title, "tagline": entry.tagline, "summary": entry.summary, "color": entry.color })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_lists_and_removes() {
        let root = std::env::temp_dir().join(format!("pocket-library-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let library = Library::new(&root);
        let id = library.create().unwrap();
        assert_eq!(id, "game-0001");
        assert_eq!(library.create().unwrap(), "game-0002");
        assert!(library.list().is_empty(), "drafts are not on the shelf");
        std::fs::write(
            library.directory(&id).join("game.json"),
            json!({ "title": "贪吃蛇", "tagline": "t", "summary": "s", "color": "#ff0000" })
                .to_string(),
        )
        .unwrap();
        assert_eq!(library.list()[0].title, "贪吃蛇");
        library.remove(&id).unwrap();
        assert!(library.list().is_empty());
        library.remove("../..").unwrap();
        assert!(root.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
