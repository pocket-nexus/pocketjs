//! Build-time raw-bundle and package tables shared by handheld programs.
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Existing programs report distinct debug identities; table generation is shared.
#[derive(Clone, Copy)]
#[allow(dead_code)] // Each build script selects one of these existing identity protocols.
pub enum Identity {
    PackageTable,
    LegacyBundle,
}

pub struct Config<'a> {
    pub identity: Identity,
    pub output: &'a str,
    pub enabled: bool,
    pub dist: &'a Path,
    pub out: &'a Path,
    pub package: Option<&'a Path>,
    pub registry: Option<&'a Path>,
    pub packages: Option<&'a Path>,
}
#[derive(Debug)]
pub struct Generated {
    pub hash: String,
    pub inputs: Vec<PathBuf>,
}
enum Payload {
    Package(Vec<u8>),
    Legacy { js: String, pak: Vec<u8> },
}
struct App {
    output: String,
    id: String,
    title: String,
    payload: Payload,
}
fn read(path: &Path, inputs: &mut Vec<PathBuf>) -> Result<Vec<u8>, String> {
    inputs.push(path.to_owned());
    fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
}
fn write(path: &Path, value: impl AsRef<[u8]>) -> Result<(), String> {
    fs::write(path, value).map_err(|error| format!("{}: {error}", path.display()))
}
fn fnv(chunks: &[&[u8]]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in chunks.iter().flat_map(|chunk| chunk.iter()) {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}
fn legacy_bundle(config: &Config<'_>, inputs: &mut Vec<PathBuf>) -> Result<Payload, String> {
    let (js, pak) = if config.enabled {
        let js_path = config.dist.join(format!("{}.js", config.output));
        let js = String::from_utf8(read(&js_path, inputs)?).map_err(|error| error.to_string())?;
        let pak_path = config.dist.join(format!("{}.pak", config.output));
        inputs.push(pak_path.clone());
        let pak = if pak_path.exists() {
            fs::read(&pak_path).map_err(|error| error.to_string())?
        } else {
            Vec::new()
        };
        (js, pak)
    } else {
        (String::new(), Vec::new())
    };
    Ok(Payload::Legacy { js, pak })
}
pub fn generate(config: Config<'_>) -> Result<Generated, String> {
    if !config.enabled && (config.package.is_some() || config.registry.is_some()) {
        return Err("generic runtime cannot embed a package or launcher registry".into());
    }
    if config.package.is_some_and(|path| !path.is_absolute()) {
        return Err("POCKETJS_EMBED_PACKAGE must be an absolute captured package path".into());
    }
    let mut inputs = Vec::new();
    // Vita's debugger and old custom-host includes still use the raw launcher
    // bundle, even when the launcher's table contains verbatim packages.
    let legacy = if matches!(config.identity, Identity::LegacyBundle)
        && (config.package.is_some() || config.registry.is_some())
    {
        Some(legacy_bundle(&config, &mut inputs)?)
    } else {
        None
    };
    let mut apps = Vec::new();
    let default_packages = config.dist.join("packages");
    let packages = config.packages.unwrap_or(&default_packages);
    if config.enabled && (config.package.is_some() || config.registry.is_some()) {
        let default_package = packages.join(format!("{}.pocket", config.output));
        let bytes = read(config.package.unwrap_or(&default_package), &mut inputs)?;
        apps.push(App {
            output: config.output.into(),
            id: String::new(),
            title: String::new(),
            payload: Payload::Package(bytes),
        });
    } else {
        apps.push(App {
            output: config.output.into(),
            id: String::new(),
            title: String::new(),
            payload: legacy_bundle(&config, &mut inputs)?,
        });
    }
    if let Some(registry) = config.registry {
        let tsv =
            String::from_utf8(read(registry, &mut inputs)?).map_err(|error| error.to_string())?;
        for (line_number, line) in tsv.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let mut columns = line.split('\t');
            let (Some(output), Some(id), Some(title)) =
                (columns.next(), columns.next(), columns.next())
            else {
                return Err(format!(
                    "{}:{}: expected output\\tid\\ttitle",
                    registry.display(),
                    line_number + 1
                ));
            };
            if columns.next().is_some() {
                return Err(format!(
                    "{}:{}: expected output\\tid\\ttitle",
                    registry.display(),
                    line_number + 1
                ));
            }
            if output.is_empty()
                || !output
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                || output == "."
                || output == ".."
            {
                return Err(format!("invalid launcher output: {output}"));
            }
            if apps.iter().any(|app| app.output == output) {
                return Err(format!("launcher registry duplicates output: {output}"));
            }
            let bytes = read(&packages.join(format!("{output}.pocket")), &mut inputs)?;
            apps.push(App {
                output: output.into(),
                id: id.into(),
                title: title.into(),
                payload: Payload::Package(bytes),
            });
        }
        if apps.len() < 2 {
            return Err("launcher registry contains no guest applications".into());
        }
    }
    let compatibility = legacy.as_ref().unwrap_or(&apps[0].payload);
    let hash = match config.identity {
        Identity::LegacyBundle => match compatibility {
            Payload::Legacy { js, pak } => fnv(&[js.as_bytes(), pak]),
            Payload::Package(_) => unreachable!("legacy identity requires a raw bundle"),
        },
        Identity::PackageTable if !config.enabled => "none".into(),
        Identity::PackageTable => fnv(&apps
            .iter()
            .flat_map(|app| match &app.payload {
                Payload::Package(bytes) => vec![bytes.as_slice()],
                Payload::Legacy { js, pak } => vec![js.as_bytes(), pak.as_slice()],
            })
            .collect::<Vec<_>>()),
    };
    let mut table = String::from(
        "// GENERATED by tools/build/embedded-apps.rs.\n\
        pub struct EmbeddedApp {\n\
        pub output: &'static str, pub id: &'static str, pub title: &'static str,\n\
        pub js: &'static str, pub pak: &'static [u8], pub pocket: &'static [u8],\n\
        }\n",
    );
    if apps
        .iter()
        .any(|app| matches!(app.payload, Payload::Package(_)))
    {
        table.push_str("#[repr(align(16))]\nstruct Aligned<const N: usize>([u8; N]);\n");
    }
    table.push_str("pub static APPS: &[EmbeddedApp] = &[\n");
    write(&config.out.join("empty.bin"), [])?;
    for (index, app) in apps.iter().enumerate() {
        table.push_str(&format!(
            "    EmbeddedApp {{ output: {:?}, id: {:?}, title: {:?}, ",
            app.output, app.id, app.title
        ));
        match &app.payload {
            Payload::Package(bytes) => {
                write(&config.out.join(format!("app{index}.pocket")), bytes)?;
                table.push_str(&format!("js: \"\", pak: &[], pocket: {{ static A{index}: Aligned<{}> = Aligned(*include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app{index}.pocket\"))); &A{index}.0 }} }},\n", bytes.len()));
            }
            Payload::Legacy { js, pak } => {
                write(
                    &config.out.join(format!("app{index}.js")),
                    format!("{js}\0"),
                )?;
                write(&config.out.join(format!("app{index}.pak")), pak)?;
                table.push_str(&format!("js: include_str!(concat!(env!(\"OUT_DIR\"), \"/app{index}.js\")), pak: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app{index}.pak\")), pocket: &[] }},\n"));
            }
        }
    }
    table.push_str("];\n");
    write(&config.out.join("apps.rs"), table)?;
    // Retain old custom-host include names without duplicating a packaged app.
    match compatibility {
        Payload::Legacy { js, pak } => {
            write(&config.out.join("game.js"), format!("{js}\0"))?;
            write(&config.out.join("app.pak"), pak)?;
        }
        Payload::Package(_) => {
            write(&config.out.join("game.js"), b"\0")?;
            write(&config.out.join("app.pak"), [])?;
        }
    }
    Ok(Generated { hash, inputs })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory(name: &str) -> PathBuf {
        let path = PathBuf::from(std::env::var_os("POCKET_EMBED_TEST_DIR").unwrap()).join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn config(path: &Path) -> Config<'_> {
        Config {
            identity: Identity::PackageTable,
            output: "hero-main",
            enabled: true,
            dist: path,
            out: path,
            package: None,
            registry: None,
            packages: None,
        }
    }
    #[test]
    fn captured_package_is_embedded_verbatim_without_reading_js_or_pak() {
        let path = directory("single");
        let package = path.join("captured.pocket");
        fs::write(&package, b"original package with private sections\0\xff").unwrap();
        let generated = generate(Config {
            package: Some(&package),
            ..config(&path)
        })
        .unwrap();
        assert_eq!(generated.inputs, vec![package.clone()]);
        assert_eq!(
            fs::read(path.join("app0.pocket")).unwrap(),
            fs::read(&package).unwrap()
        );
        assert_eq!(fs::read(path.join("app.pak")).unwrap(), b"");
        // Compile the real emitted table: verify its actual backing and 16-byte alignment.
        let main = path.join("table.rs");
        fs::write(&main, format!("include!({:?});\nfn main() {{ assert_eq!(APPS.len(),1); assert_eq!(APPS[0].pocket,include_bytes!({:?})); assert!(APPS[0].js.is_empty() && APPS[0].pak.is_empty()); assert_eq!(APPS[0].pocket.as_ptr() as usize % 16,0); }}", path.join("apps.rs"), package)).unwrap();
        let binary = path.join("table");
        assert!(
            std::process::Command::new(std::env::var_os("RUSTC").unwrap_or("rustc".into()))
                .arg(&main)
                .arg("-o")
                .arg(&binary)
                .env("OUT_DIR", &path)
                .status()
                .unwrap()
                .success()
        );
        assert!(std::process::Command::new(binary)
            .status()
            .unwrap()
            .success());
        fs::write(&package, b"changed original bytes").unwrap();
        let next = generate(Config {
            package: Some(&package),
            ..config(&path)
        })
        .unwrap();
        assert_ne!(generated.hash, next.hash);
        assert_eq!(
            fs::read(path.join("app0.pocket")).unwrap(),
            b"changed original bytes"
        );
    }
    #[test]
    fn launcher_uses_captured_first_package_and_explicit_guest_directory_in_order() {
        let path = directory("launcher");
        let package = path.join("current.pocket");
        let guests = path.join("elsewhere");
        fs::create_dir_all(&guests).unwrap();
        let registry = path.join("registry.tsv");
        fs::write(&package, b"launcher original").unwrap();
        fs::write(guests.join("guest.pocket"), b"guest original").unwrap();
        fs::write(&registry, "guest\tdev.guest\tGuest title\n").unwrap();
        let options = || Config {
            package: Some(&package),
            registry: Some(&registry),
            packages: Some(&guests),
            ..config(&path)
        };
        let generated = generate(options()).unwrap();
        assert_eq!(
            generated.hash,
            fnv(&[b"launcher original", b"guest original"])
        );
        assert_eq!(
            generated.inputs,
            vec![
                package.clone(),
                registry.clone(),
                guests.join("guest.pocket")
            ]
        );
        assert_eq!(
            fs::read(path.join("app1.pocket")).unwrap(),
            b"guest original"
        );
        assert!(fs::read_to_string(path.join("apps.rs"))
            .unwrap()
            .contains("id: \"dev.guest\", title: \"Guest title\""));
        fs::write(&registry, "guest\tdev.guest\tGuest title\textra\n").unwrap();
        assert!(generate(options()).unwrap_err().contains("expected output"));
        fs::write(&registry, "guest\tdev.guest\tGuest title\n").unwrap();
        fs::remove_file(guests.join("guest.pocket")).unwrap();
        assert!(generate(options()).unwrap_err().contains("guest.pocket"));
        fs::write(&registry, "../outside\tid\ttitle\n").unwrap();
        assert!(generate(options())
            .unwrap_err()
            .contains("invalid launcher output"));
        fs::write(&registry, "hero-main\tid\ttitle\n").unwrap();
        assert!(generate(options())
            .unwrap_err()
            .contains("duplicates output"));
    }
    #[test]
    fn missing_relative_or_generic_package_inputs_never_fall_back_to_raw_bundle() {
        let path = directory("invalid");
        fs::write(path.join("hero-main.js"), b"stale js").unwrap();
        let absent = path.join("absent.pocket");
        assert!(generate(Config {
            package: Some(&absent),
            ..config(&path)
        })
        .is_err());
        assert!(generate(Config {
            package: Some(Path::new("relative.pocket")),
            ..config(&path)
        })
        .unwrap_err()
        .contains("absolute"));
        assert!(generate(Config {
            enabled: false,
            package: Some(&absent),
            ..config(&path)
        })
        .unwrap_err()
        .contains("generic runtime"));
        assert!(!path.join("apps.rs").exists());
    }
    #[test]
    fn explicit_legacy_bundle_and_generic_empty_table_keep_their_existing_shape() {
        let path = directory("legacy");
        fs::write(path.join("hero-main.js"), b"a").unwrap();
        let generated = generate(config(&path)).unwrap();
        assert_eq!(generated.hash, "af63dc4c8601ec8c");
        assert_eq!(fs::read(path.join("app0.js")).unwrap(), b"a\0");
        assert!(fs::read_to_string(path.join("apps.rs"))
            .unwrap()
            .contains("pocket: &[]"));
        let generated = generate(Config {
            enabled: false,
            ..config(&path)
        })
        .unwrap();
        assert_eq!(generated.hash, "none");
        assert_eq!(fs::read(path.join("app0.js")).unwrap(), b"\0");
    }
}
