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
    fn resolved_system_plan_uses_the_exact_system_ui_wire_key() {
        let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
            "system": {
                "id": "dev.pocket-nexus.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": pocket_spec::BINDING_GENERATION },
            "roles": { "systemUI": "dev.pocket-nexus.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-nexus.shell"]
            },
            "systemUI": {
                "package": "dev.pocket-nexus.shell",
                "source": "apps/shell/pocket.app.json",
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
                    "profile": { "id": HOST_ID, "tickHz": 60 },
                    "target": { "id": HOST_ID, "hostAbi": pocket_spec::BINDING_GENERATION },
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
