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

    /// Sets an environment variable for the test's lifetime, restoring the
    /// previous value on drop.
    struct EnvGuard {
        key: String,
        old: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &str, value: &str) -> Self {
            let old = std::env::var(key).ok();
            // SAFETY: test-only process-global mutation; tests that set
            // POCKETJS_DIST serialize on `DIST_ENV_LOCK`.
            unsafe { std::env::set_var(key, value) };
            EnvGuard {
                key: key.to_string(),
                old,
            }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: restores the value captured in `set`.
            unsafe {
                if let Some(old) = &self.old {
                    std::env::set_var(&self.key, old);
                } else {
                    std::env::remove_var(&self.key);
                }
            }
        }
    }

    /// `POCKETJS_DIST` is process-global, so tests that set it hold this
    /// lock for their whole lifetime: parallel tests would otherwise steer
    /// each other's `resolve_asset` lookups at the wrong dist directory.
    static DIST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A scratch directory for a test's bundle files, removed on drop.
    struct TempBase(std::path::PathBuf);
    impl TempBase {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "pocket-desktop-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn app_supervisor_child_realms_collect_at_the_tick_boundary() {
        // AppSupervisor child realms use the same between-tick collection as
        // the top-level guest: a turn's cyclic garbage is reclaimed by
        // idle_gc at the end of the tick, not inside whichever turn crosses
        // the engine's allocation threshold.
        let dist = TempBase::new("supervisor-dist");
        let app = "dev.pocket-nexus.child";
        std::fs::write(
            dist.path().join(format!("{app}.js")),
            // 3,000 two-object cycles per turn: enough to cross the soft
            // limit without crossing the GC threshold, so the collection
            // lands at the boundary.
            "globalThis.frame = (buttons) => { \
                for (let i = 0; i < 3000; i++) { const a = {}; const b = { a }; a.b = b; } \
                globalThis.lastButtons = buttons; \
            };",
        )
        .unwrap();
        std::fs::write(dist.path().join(format!("{app}.pak")), b"").unwrap();
        let _dist_lock = DIST_ENV_LOCK.lock().unwrap();
        let _dist_guard = EnvGuard::set("POCKETJS_DIST", dist.path().to_str().unwrap());

        let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
            "system": {
                "id": "dev.pocket-nexus.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
            "roles": { "systemUI": "dev.pocket-nexus.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-nexus.shell", "dev.pocket-nexus.child"]
            },
            "systemUI": {
                "package": "dev.pocket-nexus.shell",
                "source": "apps/shell/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-nexus.shell",
                        "output": "shell-main",
                        "title": "System UI",
                        "version": "0.1.0",
                        "entry": "apps/shell/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
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
            "applications": [{
                "package": app,
                "source": "apps/child/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": app,
                        "output": app,
                        "title": "Child",
                        "version": "0.1.0",
                        "entry": "apps/child/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
                    "viewport": {
                        "logical": [320, 240],
                        "physical": [320, 240],
                        "presentation": "native",
                        "rasterDensity": 1,
                        "policy": "dynamic"
                    },
                    "features": {},
                    "companions": [],
                    "planHash": "sha256:child"
                }
            }],
            "planHash": "sha256:system"
        }))
        .unwrap();

        let shell = UiSurface::new((800.0, 600.0));
        let mut supervisor = AppSupervisor::new(Some(&plan), &shell).unwrap();
        let handle = shell.register_compositor_surface(app).unwrap() as u32;
        assert!(supervisor.open(handle).unwrap());
        assert_eq!(supervisor.instances.len(), 1);

        for _ in 0..8 {
            supervisor.tick();
        }
        let stats = supervisor.instances[0]
            .guest
            .idle_gc_stats()
            .expect("child realm has idle GC");
        assert!(
            stats.idle_collections > 0,
            "child realm did not collect at the tick boundary: {stats:?}"
        );
        // The child's turn still ran between collections.
        let buttons: u32 = supervisor.instances[0]
            .guest
            .with(|ctx| ctx.globals().get("lastButtons").unwrap());
        assert_eq!(buttons, 0);
    }

    /// The re-review's first-frame probe: two garbage cycles in one turn,
    /// each holding a 2,000,000-element backing store (~38 MiB). A realm
    /// armed before its first product frame refuses the allocation with an
    /// out-of-memory exception; an unarmed realm grows the heap without
    /// bound, because the fallback arm only lands at the first `idle_gc`
    /// boundary.
    const FIRST_FRAME_PROBE: &str = "\
        globalThis.frame = () => { \
            for (let i = 0; i < 2; i++) { \
                const a = { pad: new Array(2000000).fill(i) }; \
                const b = { a }; a.b = b; \
            } \
        };";

    #[test]
    fn runtime_first_frame_is_bounded_by_the_armed_memory_limit() {
        // Production boot order in `Runtime::boot`: evaluate the bundle,
        // check `has_frame`, arm the hard cap, then run the first product
        // frame in `Runtime::tick`. The probe runs on that first frame,
        // before any boundary collection, so the arm is the only thing
        // bounding it. Deleting `Runtime::boot`'s `arm_idle_gc` call makes
        // this test fail: the first frame runs unbounded and `tick` returns
        // Ok with a ~38 MiB heap.
        let dist = TempBase::new("runtime-first-frame-dist");
        let app = "dev.pocket-nexus.first-frame";
        let js = dist.path().join(format!("{app}.js"));
        let pak = dist.path().join(format!("{app}.pak"));
        std::fs::write(&js, FIRST_FRAME_PROBE).unwrap();
        std::fs::write(&pak, b"").unwrap();

        let args = Args {
            app: app.to_string(),
            js: Some(js),
            pak: Some(pak),
            file: None,
            title: "first-frame".into(),
            viewport: (320, 240),
            fixed: false,
            native_text: false,
            editor: false,
            companions: Vec::new(),
            system: None,
            svc_connect: None,
            density: 1,
            script: Vec::new(),
            quit_after_ticks: None,
            storm: None,
            announce_ready: false,
            trace_frames: false,
        };
        let mut runtime = Runtime::boot(args).unwrap();
        let before = runtime.guest.heap_bytes().unwrap();
        let err = runtime.tick().unwrap_err();
        assert!(
            err.to_string().contains("out of memory"),
            "first frame was not refused by the armed memory limit: {err}"
        );
        let after = runtime.guest.heap_bytes().unwrap();
        assert!(
            after < before + 1024 * 1024,
            "heap grew {before} -> {after} for a refused first frame"
        );
        // No boundary collection ran: the allocator refused the block.
        let stats = runtime.guest.idle_gc_stats().unwrap();
        assert_eq!(stats.idle_collections, 0, "{stats:?}");
        assert_eq!(stats.forced_collections, 0, "{stats:?}");
    }

    #[test]
    fn app_supervisor_child_first_frame_is_bounded_by_the_armed_memory_limit() {
        // Production boot order for a child realm in `AppSupervisor::open`:
        // evaluate the bundle, check `has_frame`, arm the hard cap, insert
        // the instance, then run its first product frame in
        // `AppSupervisor::tick`. The probe runs on that first frame, before
        // any boundary collection, so the arm is the only thing bounding
        // it. Deleting `open`'s `arm_idle_gc` call makes this test fail:
        // the child's first frame runs unbounded and `tick` records no
        // failure.
        let dist = TempBase::new("supervisor-first-frame-dist");
        let app = "dev.pocket-nexus.child-first-frame";
        std::fs::write(dist.path().join(format!("{app}.js")), FIRST_FRAME_PROBE).unwrap();
        std::fs::write(dist.path().join(format!("{app}.pak")), b"").unwrap();
        let _dist_lock = DIST_ENV_LOCK.lock().unwrap();
        let _dist_guard = EnvGuard::set("POCKETJS_DIST", dist.path().to_str().unwrap());

        let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
            "system": {
                "id": "dev.pocket-nexus.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
            "roles": { "systemUI": "dev.pocket-nexus.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-nexus.shell", "dev.pocket-nexus.child-first-frame"]
            },
            "systemUI": {
                "package": "dev.pocket-nexus.shell",
                "source": "apps/shell/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-nexus.shell",
                        "output": "shell-main",
                        "title": "System UI",
                        "version": "0.1.0",
                        "entry": "apps/shell/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
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
            "applications": [{
                "package": "dev.pocket-nexus.child-first-frame",
                "source": "apps/child/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-nexus.child-first-frame",
                        "output": "dev.pocket-nexus.child-first-frame",
                        "title": "Child",
                        "version": "0.1.0",
                        "entry": "apps/child/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": HOST_ABI },
                    "viewport": {
                        "logical": [320, 240],
                        "physical": [320, 240],
                        "presentation": "native",
                        "rasterDensity": 1,
                        "policy": "dynamic"
                    },
                    "features": {},
                    "companions": [],
                    "planHash": "sha256:child"
                }
            }],
            "planHash": "sha256:system"
        }))
        .unwrap();

        let shell = UiSurface::new((800.0, 600.0));
        let mut supervisor = AppSupervisor::new(Some(&plan), &shell).unwrap();
        let handle = shell.register_compositor_surface(app).unwrap() as u32;
        assert!(supervisor.open(handle).unwrap());
        assert_eq!(supervisor.instances.len(), 1);

        let before = supervisor.instances[0].guest.heap_bytes().unwrap();
        // The first tick runs the child's first product frame; no boundary
        // collection has run yet.
        let failures = supervisor.tick();
        assert_eq!(
            failures.len(),
            1,
            "child first frame should have been refused: {failures:?}"
        );
        assert!(
            failures[0].1.contains("out of memory"),
            "child first frame was not refused by the armed memory limit: {:?}",
            failures[0].1
        );
        assert_eq!(supervisor.instances[0].state, AppInstanceState::Failed);
        let after = supervisor.instances[0].guest.heap_bytes().unwrap();
        assert!(
            after < before + 1024 * 1024,
            "child heap grew {before} -> {after} for a refused first frame"
        );
        let stats = supervisor.instances[0].guest.idle_gc_stats().unwrap();
        assert_eq!(stats.idle_collections, 0, "{stats:?}");
        assert_eq!(stats.forced_collections, 0, "{stats:?}");
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
                "id": "dev.pocket-nexus.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": 4 },
            "roles": { "systemUI": "dev.pocket-nexus.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-nexus.shell"]
            },
            "systemUI": {
                "package": "dev.pocket-nexus.shell",
                "source": "apps/shell/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-nexus.shell",
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

        assert_eq!(plan.roles.system_ui, "dev.pocket-nexus.shell");
        assert_eq!(plan.system_ui.package, "dev.pocket-nexus.shell");
        assert!(plan.validate_for_host().is_ok());
    }
}
