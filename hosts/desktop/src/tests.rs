#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_backpressure_reserves_before_gpu_submission() {
        let available = Arc::new(AtomicBool::new(true));
        let permit = OutputPermit::acquire(&available).unwrap();
        assert!(OutputPermit::acquire(&available).is_none());
        // Receipt/drop releases the slot even on presentation failure or exit.
        drop(permit);
        assert!(OutputPermit::acquire(&available).is_some());
    }

    #[test]
    fn app_supervisor_uses_lifecycle_focus_and_shell_painter_order() {
        let mut facts = [
            SchedulingFact {
                visible: true,
                focused: false,
                order: 10,
                state: AppInstanceState::Running,
            },
            SchedulingFact {
                visible: false,
                focused: false,
                order: 20,
                state: AppInstanceState::Suspended,
            },
            SchedulingFact {
                visible: true,
                focused: true,
                order: 30,
                state: AppInstanceState::Running,
            },
            SchedulingFact {
                visible: true,
                focused: true,
                order: 25,
                state: AppInstanceState::Failed,
            },
        ];
        assert_eq!(focused_app_instance(&facts), Some(2));
        assert_eq!(scheduled_app_instances(&facts), vec![2, 0]);
        facts[1].state = AppInstanceState::Running;
        assert_eq!(scheduled_app_instances(&facts), vec![2, 1, 0]);
    }

    #[test]
    fn app_instances_do_not_share_quickjs_globals() {
        let hero = Guest::new().unwrap();
        let settings = Guest::new().unwrap();
        hero.eval("hero", "globalThis.realmProbe = 41;").unwrap();
        settings
            .eval(
                "settings",
                "globalThis.realmProbeWasAbsent = typeof realmProbe === 'undefined';",
            )
            .unwrap();

        let hero_probe: i32 = hero.with(|ctx| ctx.globals().get("realmProbe").unwrap());
        let settings_absent: bool =
            settings.with(|ctx| ctx.globals().get("realmProbeWasAbsent").unwrap());
        assert_eq!(hero_probe, 41);
        assert!(settings_absent);
    }

    #[test]
    fn app_instance_repaint_hash_includes_raster_revision() {
        let surface = UiSurface::new((16.0, 16.0));
        let texture = surface.with_ui(|ui| {
            ui.upload_texture(
                &[0xff, 0xff, 0xff, 0xff],
                1,
                1,
                pocketjs_core::spec::psm::PSM_8888,
            )
        });
        assert!(texture >= 0);

        let (words_before, revision_before) =
            surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
        let mut hash_before = 0xcbf2_9ce4_8422_2325u64;
        mix_app_instance_repaint_hash(&mut hash_before, 7, fnv1a64(&words_before), revision_before);

        surface.with_ui(|ui| ui.free_texture(texture));
        let (words_after, revision_after) =
            surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
        let mut hash_after = 0xcbf2_9ce4_8422_2325u64;
        mix_app_instance_repaint_hash(&mut hash_after, 7, fnv1a64(&words_after), revision_after);

        assert_eq!(words_after, words_before);
        assert_ne!(revision_after, revision_before);
        assert_ne!(hash_after, hash_before);
    }

    #[test]
    fn resolved_system_plan_uses_the_exact_system_ui_wire_key() {
        let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
            "system": {
                "id": "dev.pocket-stack.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": 4 },
            "roles": { "systemUI": "dev.pocket-stack.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-stack.shell"]
            },
            "systemUI": {
                "package": "dev.pocket-stack.shell",
                "source": "apps/shell/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-stack.shell",
                        "output": "shell-main",
                        "title": "System UI",
                        "version": "0.1.0",
                        "entry": "apps/shell/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": 4 },
                    "viewport": {
                        "logical": [800, 600],
                        "physical": [1600, 1200],
                        "presentation": "native",
                        "rasterDensity": 2,
                        "policy": "dynamic"
                    },
                    "features": { "ui.compositor-surfaces": true },
                    "companions": ["system-ui"],
                    "planHash": "sha256:package"
                }
            },
            "applications": [],
            "planHash": "sha256:system"
        }))
        .unwrap();

        assert_eq!(plan.roles.system_ui, "dev.pocket-stack.shell");
        assert_eq!(plan.system_ui.package, "dev.pocket-stack.shell");
        assert!(plan.validate_for_host().is_ok());
    }

    // --- data.fs host binding ---------------------------------------------
    //
    // The module core's own conformance lives in engine/crates/pocket-fs;
    // these tests cover the desktop host's half: roots resolve per app under
    // the host base, the bound tree persists across module instances, the
    // vocabulary cannot name another app's tree, and the namespace mounts as
    // globalThis.fs on a real guest.

    use std::cell::RefCell;
    use std::path::Path;
    use std::rc::Rc;

    struct TempBase(PathBuf);
    impl TempBase {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "pocket-desktop-fs-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn json(line: &str) -> serde_json::Value {
        serde_json::from_str(line).unwrap()
    }
    fn text(s: &str) -> String {
        serde_json::json!(s).to_string()
    }
    fn module_at(base: &Path, app_id: &str) -> (Rc<RefCell<pocket_fs::FsModule>>, PathBuf) {
        let roots = fs::data_roots(Some(base), app_id).unwrap();
        let module = Rc::new(RefCell::new(pocket_fs::FsModule::new(
            pocket_fs::Storage::Dir {
                root: roots.data.clone(),
                tmp: roots.tmp.clone(),
            },
        )));
        (module, roots.data.clone())
    }

    #[test]
    fn data_roots_are_per_app_under_the_base() {
        let base = TempBase::new("roots");
        let a = fs::data_roots(Some(base.path()), "dev.pocket-stack.a").unwrap();
        let b = fs::data_roots(Some(base.path()), "dev.pocket-stack.b").unwrap();
        assert!(a.data.ends_with("dev.pocket-stack.a/data"));
        assert!(a.tmp.ends_with("dev.pocket-stack.a/tmp"));
        assert!(b.data.ends_with("dev.pocket-stack.b/data"));
        assert_ne!(a.data, b.data);
        assert!(a.data.is_dir(), "the data root is created on resolve");
        // App ids that could steer the join outside the base are refused.
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "a\0b"] {
            assert!(fs::data_roots(Some(base.path()), bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn fs_conformance_write_read_list_remove_usage_and_boundaries() {
        let base = TempBase::new("conformance");
        let (m, data_dir) = module_at(base.path(), "dev.pocket-stack.fs");
        let mut m = m.borrow_mut();

        // write + read: text payloads store their decoded UTF-8 bytes.
        assert_eq!(m.write("notes/today.md", &text("# hi"), 0), 0);
        assert_eq!(m.write("notes/today.md", &text(" there"), 1), 0);
        let read = json(&m.read("notes/today.md", 0, 64));
        assert_eq!(read["size"], 10);
        assert_eq!(read["eof"], true);
        assert_eq!(
            std::fs::read_to_string(data_dir.join("notes/today.md")).unwrap(),
            "# hi there",
            "truncate then append lands on disk"
        );
        assert_eq!(
            m.write("raw.bin", r#"{"$b":"AAEC/w=="}"#, 0),
            0,
            "bytes payload spelling"
        );
        assert_eq!(json(&m.stat("raw.bin"))["size"], 4);
        assert_eq!(
            std::fs::read(data_dir.join("raw.bin")).unwrap(),
            [0, 1, 2, 255]
        );

        // mkdir + list: sorted entries, dirs and files.
        assert_eq!(m.mkdir("assets/img"), 0);
        assert_eq!(m.rename("raw.bin", "assets/raw.bin"), 0);
        let listing = json(&m.list("assets", 0));
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["img", "raw.bin"]);
        assert_eq!(listing["eof"], true);

        // remove: non-empty dir refuses without recursive; recursive clears.
        assert_eq!(m.remove("assets", 0), 1);
        assert_eq!(m.last_error(), "directory not empty");
        assert_eq!(m.remove("assets", 1), 0);
        assert_eq!(json(&m.stat("assets"))["error"], "not found");

        // usage walks the bound root (the 4 raw bytes were removed with assets).
        let usage = json(&m.usage());
        assert_eq!(usage["usedBytes"], 10);
        assert_eq!(usage["quotaBytes"], 0, "desktop default is unmetered");

        // The confinement vocabulary: traversal is unrepresentable.
        assert_eq!(
            json(&m.read("../../etc/passwd", 0, 16))["error"],
            "invalid path"
        );
        assert_eq!(m.write("../escape.txt", &text("x"), 0), 1);
        assert_eq!(m.last_error(), "invalid path");

        // Universal names (dot-prefixed, CJK) round-trip on the real FS.
        assert_eq!(m.write(".config", &text("k=v"), 0), 0);
        assert_eq!(m.write("笔记/今天.md", &text("你好"), 0), 0);
        assert_eq!(json(&m.stat("笔记/今天.md"))["size"], 6);

        // Host machinery never appears inside the bound root.
        let root_names: Vec<String> = std::fs::read_dir(&data_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            root_names.iter().all(|n| n != "tmp"),
            "tmp must stay outside the bound root: {root_names:?}"
        );
        std::mem::drop(m);

        // A second module over the same root sees the persisted tree.
        let (m2, _) = module_at(base.path(), "dev.pocket-stack.fs");
        let mut m2 = m2.borrow_mut();
        let again = json(&m2.read(".config", 0, 16));
        assert_eq!(again["size"], 3);
    }

    #[test]
    fn fs_app_trees_are_isolated_on_disk() {
        let base = TempBase::new("isolation");
        let (a, dir_a) = module_at(base.path(), "dev.pocket-stack.iso-a");
        let (b, _dir_b) = module_at(base.path(), "dev.pocket-stack.iso-b");
        a.borrow_mut()
            .write("save.json", &text("{\"chapter\":1}"), 0);
        // b cannot name a's file: the vocabulary is bound to b's root.
        assert_eq!(
            json(&b.borrow_mut().read("save.json", 0, 64))["error"],
            "not found"
        );
        // And b's root genuinely is a different directory with no a tree.
        assert_eq!(
            std::fs::read_dir(dir_a)
                .unwrap()
                .filter_map(|e| e.ok())
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn fs_treats_a_host_planted_symlink_as_absent() {
        let base = TempBase::new("symlink");
        let (m, data_dir) = module_at(base.path(), "dev.pocket-stack.sym");
        let outside = base.path().join("outside.txt");
        std::fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, data_dir.join("link.txt")).unwrap();
        let mut m = m.borrow_mut();
        assert_eq!(json(&m.read("link.txt", 0, 64))["error"], "not found");
        assert_eq!(json(&m.stat("link.txt"))["error"], "not found");
        let listing = json(&m.list("", 0));
        assert!(
            !listing["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == "link.txt"),
            "a planted symlink is invisible to the guest"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fs_bind_refuses_a_symlinked_app_root_pointing_at_another_app() {
        // Review D213 regression: a host-side actor replaces the attacker's
        // app-root component with a symlink to the victim's app-root. The bind
        // must fail before a module exists, so the victim's bytes can never be
        // served under the attacker's id.
        let base = TempBase::new("bind-approot");
        let (victim, _) = module_at(base.path(), "dev.pocket-stack.victim");
        victim.borrow_mut().write("save.json", &text("secret"), 0);
        drop(victim);

        // The attacker id has never been resolved: plant the link where its
        // app-root would be, pointing at the victim's whole tree.
        let attacker_root = base.path().join("dev.pocket-stack.attacker");
        std::os::unix::fs::symlink(base.path().join("dev.pocket-stack.victim"), &attacker_root)
            .unwrap();
        let err = fs::data_roots(Some(base.path()), "dev.pocket-stack.attacker")
            .err()
            .expect("a symlinked app-root crossing the app boundary is refused");
        assert!(
            err.to_string().contains("outside the app data root"),
            "unexpected error: {err}"
        );
        // No bind succeeded through the link; the victim file is intact.
        assert_eq!(
            std::fs::read_to_string(base.path().join("dev.pocket-stack.victim/data/save.json"))
                .unwrap(),
            "secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fs_bind_refuses_a_data_symlink_pointing_outside_the_base() {
        // The `data` child itself is a pre-bound component the core resolver
        // starts on, so it cannot be a link out of the app subtree either.
        let base = TempBase::new("bind-dataout");
        let outside = TempBase::new("bind-dataout-victim");
        std::fs::create_dir_all(outside.path().join("data")).unwrap();
        std::fs::write(outside.path().join("data/save.json"), b"secret").unwrap();

        // Real app-root, but a data child linked at a tree outside the base.
        let app_root = base.path().join("dev.pocket-stack.leak");
        std::fs::create_dir_all(&app_root).unwrap();
        std::os::unix::fs::symlink(outside.path().join("data"), app_root.join("data")).unwrap();
        let err = fs::data_roots(Some(base.path()), "dev.pocket-stack.leak")
            .err()
            .expect("a data symlink resolving outside the base is refused");
        assert!(
            err.to_string().contains("outside the app data root"),
            "unexpected error: {err}"
        );

        // A dangling link is refused too: it must not be created through or
        // silently accepted.
        let dangling_root = base.path().join("dev.pocket-stack.dangling");
        std::fs::create_dir_all(&dangling_root).unwrap();
        std::os::unix::fs::symlink(app_root.join("does-not-exist"), dangling_root.join("data"))
            .unwrap();
        assert!(
            fs::data_roots(Some(base.path()), "dev.pocket-stack.dangling").is_err(),
            "a dangling bind symlink is refused"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fs_bind_accepts_a_data_symlink_resolving_inside_the_app_tree() {
        // A link whose target stays under <base>/<app-id> binds normally: the
        // bytes physically land in the linked directory.
        let base = TempBase::new("bind-datain");
        let app_id = "dev.pocket-stack.linked";
        fs::data_roots(Some(base.path()), app_id).unwrap(); // lay out the real tree
        let app_root = base.path().join(app_id);
        std::fs::remove_dir(app_root.join("data")).unwrap();
        std::fs::create_dir_all(app_root.join("store")).unwrap();
        std::os::unix::fs::symlink(app_root.join("store"), app_root.join("data")).unwrap();

        let roots = fs::data_roots(Some(base.path()), app_id)
            .expect("an in-tree data symlink resolves inside the app root");
        let module = Rc::new(RefCell::new(pocket_fs::FsModule::new(
            pocket_fs::Storage::Dir {
                root: roots.data.clone(),
                tmp: roots.tmp.clone(),
            },
        )));
        assert_eq!(module.borrow_mut().write("a.txt", &text("ok"), 0), 0);
        assert_eq!(
            std::fs::read_to_string(app_root.join("store/a.txt")).unwrap(),
            "ok",
            "guest writes land in the linked in-tree directory"
        );
        assert_eq!(json(&module.borrow_mut().read("a.txt", 0, 64))["size"], 2);
    }

    #[cfg(unix)]
    fn unix_symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// Review D213-fix2 regression: data and tmp whose canonical trees overlap
    /// must be refused before any module mounts (the module constructor sweeps
    /// tmp, so an accepted overlap can delete player saves). The planted save
    /// bytes must survive the refused bind.
    #[cfg(unix)]
    #[test]
    fn fs_bind_refuses_overlapping_data_and_tmp_roots() {
        // (layout, data link target, tmp link target, extra dirs to create).
        // Each target is relative to the app root; `None` means a real dir.
        for (layout, data_link, tmp_link, extra) in [
            ("data-to-tmp", Some("tmp"), None, &[][..]),
            ("data-below-tmp", Some("tmp/store"), None, &["tmp/store"]),
            ("tmp-to-data", None, Some("data"), &[]),
            ("tmp-below-data", None, Some("data/cache"), &["data/cache"]),
            ("data-to-app", Some("."), None, &[]),
            ("both-to-store", Some("store"), Some("store"), &["store"]),
        ] {
            let base = TempBase::new(&format!("overlap-{layout}"));
            let app_root = base.path().join("dev.pocket-stack.overlap");
            std::fs::create_dir_all(&app_root).unwrap();
            for dir in extra {
                std::fs::create_dir_all(app_root.join(dir)).unwrap();
            }
            // Lay out whichever side is the real backing tree.
            std::fs::create_dir_all(app_root.join("tmp")).unwrap();
            std::fs::create_dir_all(app_root.join("data")).unwrap();
            let data_path = app_root.join("data");
            let tmp_path = app_root.join("tmp");
            if let Some(target) = data_link {
                std::fs::remove_dir(&data_path).unwrap();
                unix_symlink(&app_root.join(target), &data_path);
            }
            if let Some(target) = tmp_link {
                std::fs::remove_dir(&tmp_path).unwrap();
                unix_symlink(&app_root.join(target), &tmp_path);
            }
            let save = std::fs::canonicalize(&data_path).unwrap().join("save.json");
            std::fs::write(&save, b"saved-progress").unwrap();

            let err = fs::data_roots(Some(base.path()), "dev.pocket-stack.overlap")
                .err()
                .unwrap_or_else(|| panic!("overlapping data/tmp must be refused: {layout}"));
            assert!(
                err.to_string().contains("overlap"),
                "unexpected error for {layout}: {err}"
            );
            assert_eq!(
                std::fs::read(&save).unwrap(),
                b"saved-progress",
                "a refused bind leaves the save bytes untouched: {layout}"
            );
        }
    }

    /// Review D213-fix2 regression: the roots handed to a mounted module are
    /// the canonical paths checked at bind time. Retargeting an accepted data
    /// symlink at another app's tree after mount must not redirect guest ops.
    #[cfg(unix)]
    #[test]
    fn fs_bind_pins_the_canonical_data_root_against_alias_retarget() {
        let base = TempBase::new("bind-retarget");
        let app_root = base.path().join("dev.pocket-stack.rtrg");
        let store = app_root.join("store");
        std::fs::create_dir_all(&store).unwrap();
        unix_symlink(&store, &app_root.join("data"));

        let roots = fs::data_roots(Some(base.path()), "dev.pocket-stack.rtrg")
            .expect("an in-tree data alias binds");
        assert_eq!(
            roots.data,
            std::fs::canonicalize(&store).unwrap(),
            "the returned data root is the resolved path, not the alias"
        );
        let guest = Guest::new().unwrap();
        let mounted = fs::mount_fs(&guest, &roots).unwrap();
        assert_eq!(mounted.borrow_mut().write("own", &text("own"), 0), 0);

        // A host-side actor repoints the accepted alias at a second app's tree.
        let victim = base.path().join("dev.pocket-stack.victim/data");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("sentinel"), b"secret").unwrap();
        std::fs::remove_file(app_root.join("data")).unwrap();
        unix_symlink(&victim, &app_root.join("data"));

        let mut module = mounted.borrow_mut();
        assert_eq!(
            json(&module.read("sentinel", 0, 64))["error"],
            "not found",
            "the mounted root stays on the store checked at bind time"
        );
        drop(module);
        assert_eq!(
            std::fs::read_to_string(victim.join("sentinel")).unwrap(),
            "secret",
            "the other app's bytes are untouched after the alias retargets"
        );
        assert_eq!(
            std::fs::read_to_string(store.join("own")).unwrap(),
            "own",
            "guest writes keep landing in the bound store"
        );
    }

    #[test]
    fn mounted_fs_namespace_serves_a_desktop_guest_in_its_data_root() {
        let base = TempBase::new("guest");
        let guest = Guest::new().unwrap();
        let roots = fs::data_roots(Some(base.path()), "dev.pocket-stack.guest").unwrap();
        let _mount = fs::mount_fs(&guest, &roots).unwrap();
        guest
            .eval(
                "fs-guest",
                r#"
                if (typeof fs !== "object") throw new Error("fs namespace missing");
                if (fs.write("saves/slot1.json", JSON.stringify("ok"), 0) !== 0) {
                    throw new Error(fs.lastError());
                }
                const read = JSON.parse(fs.read("saves/slot1.json", 0, 64));
                // JSON.stringify("ok") is a text payload; stored bytes are
                // its decoded value ("ok" = 2 bytes).
                if (read.size !== 2 || !read.eof) throw new Error("bad read: " + JSON.stringify(read));
                if (JSON.parse(fs.read("../other/data/x", 0, 16)).error !== "invalid path") {
                    throw new Error("traversal not refused");
                }
                // The namespace carries all nine ops.
                for (const op of ["read","write","remove","list","stat","mkdir","rename","usage","lastError"]) {
                    if (typeof fs[op] !== "function") throw new Error("fs." + op + " missing");
                }
                globalThis.fsProbe = read.size;
                "#,
            )
            .unwrap();
        let probe: f64 = guest.with(|ctx| ctx.globals().get("fsProbe").unwrap());
        assert_eq!(probe, 2.0);
        // The payload is stored on disk verbatim under the per-app root.
        assert_eq!(
            std::fs::read_to_string(roots.data.join("saves/slot1.json")).unwrap(),
            "ok"
        );
    }
}
