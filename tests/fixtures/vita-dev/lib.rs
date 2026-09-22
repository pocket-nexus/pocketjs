#[path = "../../../hosts/vita/src/dev_delivery.rs"]
mod delivery;
#[path = "../../../hosts/vita/src/devmenu/input.rs"]
mod menu_input;
#[path = "../../../hosts/vita/src/dev_protocol.rs"]
mod protocol;

#[cfg(test)]
mod tests {
    use super::protocol::*;
    use serde_json::{json, Value};
    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(std::path::Path::new(&std::env::var("VITA_DEV_FIXTURES").unwrap()).join(name))
            .unwrap()
    }
    fn plan() -> Value {
        serde_json::from_slice(&fixture("plan.json")).unwrap()
    }

    #[test]
    fn interrupted_capture_and_receipt_writes_recover_without_reexecution() {
        use super::delivery::PendingReply;
        use std::collections::HashMap;
        let mut reply = PendingReply {
            id: "capture-id".into(),
            receipt: br#"{"ok":true,"frame":42}"#.to_vec(),
            pixels: vec![1, 2, 3, 255].into(),
        };
        let mut files = HashMap::new();
        // Cable loss during pixels must not publish the success receipt.
        assert!(reply
            .deliver("host0:/test", |_, _| Err("disconnected".into()))
            .is_err());
        assert!(reply.pixels.is_some());
        // Pixels arrive after reconnect, but the receipt write is interrupted.
        assert!(reply
            .deliver("host0:/test", |path, bytes| {
                if path.ends_with(".json") {
                    return Err("disconnected".into());
                }
                files.insert(path.to_string(), bytes.to_vec());
                Ok(())
            })
            .is_err());
        assert!(!files.contains_key("host0:/test/capture-id.json"));
        reply
            .deliver("host0:/test", |path, bytes| {
                files.insert(path.to_string(), bytes.to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(files["host0:/test/capture-id.rgba"], vec![1, 2, 3, 255]);
        assert_eq!(
            serde_json::from_slice::<Value>(&files["host0:/test/capture-id.json"]).unwrap()
                ["frame"],
            42
        );
    }

    #[test]
    fn admits_js_and_assets_with_verified_package_identity() {
        let bundle = admit(&fixture("good.pocket"), &plan()).unwrap();
        assert_eq!(bundle.js, "globalThis.frame = () => {};\0");
        assert_eq!(bundle.hash.len(), 16);
    }
    #[test]
    fn rejects_corruption_wrong_application_target_and_native_contract() {
        for name in [
            "bad-hash.pocket",
            "wrong-app.pocket",
            "wrong-abi.pocket",
            "wrong-native.pocket",
            "wrong-target.pocket",
            "no-nul.pocket",
        ] {
            assert!(admit(&fixture(name), &plan()).is_err(), "admitted {name}");
        }
    }
    #[test]
    fn unknown_native_fields_are_part_of_admission() {
        let mut changed = plan();
        changed["futureNativeExtension"] = json!({"enabled": true});
        assert!(admit(&fixture("good.pocket"), &changed).is_err());
    }
    #[test]
    fn source_path_title_and_version_changes_do_not_require_native_rebuild() {
        let mut changed = plan();
        changed["app"]["entry"] = json!("new/main.tsx");
        changed["app"]["title"] = json!("New title");
        changed["app"]["version"] = json!("2.0.0");
        changed["planHash"] = json!("new-plan-hash");
        assert!(admit(&fixture("good.pocket"), &changed).is_ok());
    }
    #[test]
    fn command_fences_sessions_paths_sizes_and_checksums() {
        let session = Session {
            version: VERSION,
            session: "a".repeat(32),
        };
        let mut command: Command = serde_json::from_value(json!({
            "version":1,"session":session.session,"id":"b".repeat(32),"op":"push",
            "size":3,"hash":format!("{:016x}", pocketjs_core::package::fnv1a64(&[b"abc"]))
        }))
        .unwrap();
        command.validate(&session).unwrap();
        command.check_payload(b"abc").unwrap();
        assert!(command.check_payload(b"abd").is_err());
        command.size = MAX_PACKAGE + 1;
        assert!(command.validate(&session).is_err());
        command.size = 3;
        command.id = "../eboot.bin".into();
        assert!(command.validate(&session).is_err());
        command.id = "b".repeat(32);
        command.session = "c".repeat(32);
        assert!(command.validate(&session).is_err());
        assert!(
            serde_json::from_value::<Command>(json!({"version":1,"session":session.session,
            "id":"b".repeat(32),"op":"status","path":"ux0:/app/other/eboot.bin"}))
            .is_err()
        );
    }
}
