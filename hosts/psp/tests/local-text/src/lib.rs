extern crate alloc;

#[cfg(test)]
#[path = "../../../src/local_text.rs"]
mod local_text;

#[cfg(test)]
mod tests {
    use super::local_text::LocalText;
    use serde_json::{json, Value};

    const INTER: &[u8] = include_bytes!("../../../../../assets/fonts/Inter-Regular.ttf");
    const BOLD: &[u8] = include_bytes!("../../../../../assets/fonts/Inter-Bold.ttf");
    const CFF: &[u8] = include_bytes!("../../../../../assets/fonts/W95FA.otf");

    fn pak(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use pocketjs_core::spec::pak as spec;
        let directory = 32usize;
        let names = directory + entries.len() * spec::ENTRY_SIZE;
        let data = names + entries.iter().map(|(name, _)| name.len()).sum::<usize>();
        let length = data + entries.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        let mut pak = vec![0; length];
        pak[..4].copy_from_slice(&spec::MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&spec::VERSION.to_le_bytes());
        pak[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        pak[12..16].copy_from_slice(&(directory as u32).to_le_bytes());
        pak[16..20].copy_from_slice(&(names as u32).to_le_bytes());
        let mut name_at = names;
        let mut data_at = data;
        for (index, (key, bytes)) in entries.iter().enumerate() {
            let entry = directory + index * spec::ENTRY_SIZE;
            pak[entry + 4..entry + 8].copy_from_slice(&(data_at as u32).to_le_bytes());
            pak[entry + 8..entry + 12].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
            pak[entry + 12..entry + 16].copy_from_slice(&((name_at - names) as u32).to_le_bytes());
            pak[entry + 16..entry + 18].copy_from_slice(&(key.len() as u16).to_le_bytes());
            pak[name_at..name_at + key.len()].copy_from_slice(key.as_bytes());
            pak[data_at..data_at + bytes.len()].copy_from_slice(bytes);
            name_at += key.len();
            data_at += bytes.len();
        }
        pak
    }
    fn request(service: &mut LocalText, method: &str, value: Value) -> Value {
        serde_json::from_str(
            &service
                .dispatch(method, &value.to_string(), |_, _| {
                    panic!("ordinary text requests must not read files")
                })
                .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn packaged_static_fonts_shape_and_raster_without_mutating_source() {
        let package = pak(&[
            ("text:font.0", INTER),
            ("text:font.bad", BOLD),
            ("font:any", BOLD),
            ("text:font.1", CFF),
        ]);
        let original = package.clone();
        let mut service = LocalText::new(&package);
        let fonts = request(&mut service, "runtime.fonts", json!({}));
        assert_eq!(fonts["local"], true);
        assert_eq!(fonts["total"], 1);
        assert_eq!(fonts["maxUnits"], 512);
        assert_eq!(fonts["limits"]["fontSourceBytes"], 1024 * 1024);
        let f = request(
            &mut service,
            "runtime.font",
            json!({"family":"Inter", "size":24,"fallback":[]}),
        );
        let prepared = request(
            &mut service,
            "runtime.prepare",
            json!({"font":f["font"], "text":"AV office e\u{301}", "width":200,"leaseKey":"editor"}),
        );
        let layout = prepared["layout"].as_u64().unwrap();
        let page = request(
            &mut service,
            "runtime.layout.page",
            json!({"layout":layout,"kind":"glyphs"}),
        );
        let glyph = page["items"][0][0].as_u64().unwrap();
        let bitmap = request(&mut service, "runtime.glyph", json!({"glyph":glyph}));
        assert_eq!(bitmap["glyph"], glyph);
        let stats = request(&mut service, "runtime.stats", json!({}));
        assert_eq!(stats["loadedPackageFonts"], 1);
        assert_eq!(stats["rejectedPackageFonts"], 1);
        assert_eq!(stats["shapeCount"], 1);
        assert_eq!(stats["rasterizations"], 1);
        assert_eq!(package, original);
    }
    #[test]
    fn explicit_file_reads_receive_remaining_budget_and_refuse_invalid_fonts() {
        let mut service = LocalText::new(&pak(&[("text:font.0", INTER)]));
        let mut calls = 0;
        let loaded = service
            .dispatch(
                "runtime.load",
                r#"{"path":"ms0:/fonts/bold.ttf"}"#,
                |path, limit| {
                    calls += 1;
                    assert_eq!(path, "ms0:/fonts/bold.ttf");
                    assert_eq!(limit, 1024 * 1024 - INTER.len());
                    Ok(BOLD.to_vec())
                },
            )
            .unwrap();
        assert_eq!(calls, 1);
        let loaded: Value = serde_json::from_str(&loaded).unwrap();
        assert_eq!(loaded["loaded"], true);
        assert_eq!(loaded["total"], 2);
        assert!(service
            .dispatch("runtime.load", r#"{"path":"ms0:/bad.ttf"}"#, |_, _| Ok(
                CFF.to_vec()
            ))
            .unwrap_err()
            .contains("static TTF"));
        assert!(service
            .dispatch(
                "runtime.load",
                r#"{"path":"ms0:/large.ttf"}"#,
                |_, limit| Ok(vec![0; limit + 1])
            )
            .unwrap_err()
            .contains("budget"));
        assert_eq!(
            request(&mut service, "runtime.fonts", json!({}))["total"],
            2
        );
    }
    #[test]
    fn exhausted_font_admission_rejects_before_reader_and_budget_cannot_expand() {
        // Trailing bytes do not change the valid face, but consume its source budget.
        let mut exact = INTER.to_vec();
        exact.resize(1024 * 1024, 0);
        let mut service = LocalText::new(&pak(&[("text:font.0", &exact)]));
        assert_eq!(
            request(&mut service, "runtime.fonts", json!({}))["total"],
            1
        );
        assert!(service
            .dispatch(
                "runtime.load",
                r#"{"path":"ms0:/next.ttf"}"#,
                |_, _| panic!("reader must not run at capacity")
            )
            .unwrap_err()
            .contains("budget"));
        assert!(service
            .dispatch("runtime.budget", r#"{"bitmap":131073}"#, |_, _| panic!())
            .is_err());
        assert_eq!(
            request(&mut service, "runtime.stats", json!({}))["bitmap"]["budget"],
            131072
        );
    }
    #[test]
    fn invalid_requests_and_paths_do_not_invoke_reader_or_system_lookup() {
        let mut service = LocalText::new(&[]);
        for payload in [
            "null",
            "[]",
            "bad",
            r#"{}"#,
            r#"{"path":""}"#,
            r#"{"path":"bad\u0000path"}"#,
        ] {
            assert!(service
                .dispatch("runtime.load", payload, |_, _| panic!(
                    "invalid request reached reader"
                ))
                .is_err());
        }
        assert!(service
            .dispatch("runtime.load", &" ".repeat(4097), |_, _| panic!())
            .is_err());
        assert!(service
            .dispatch(
                "runtime.font",
                r#"{"family":"Arial","size":16,"fallback":[]}"#,
                |_, _| panic!()
            )
            .unwrap_err()
            .contains("unavailable"));
        assert!(service
            .dispatch("text.shape", r#"{}"#, |_, _| panic!())
            .is_err());
    }
}
