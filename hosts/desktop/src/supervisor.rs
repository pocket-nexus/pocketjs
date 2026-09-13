struct AppCatalogEntry {
    package: SystemPackagePlan,
    /// Native compositor handle published to the shell as `ui.__surfaces`.
    surface_handle: u32,
}

struct AppInstance {
    generation: u64,
    package: SystemPackagePlan,
    surface_handle: u32,
    surface: UiSurface,
    guest: Guest,
    offload: OffloadWorker,
    buttons: u32,
    visible: bool,
    focused: bool,
    order: usize,
    state: AppInstanceState,
}

struct AppSupervisor {
    next_generation: u64,
    catalog: Vec<AppCatalogEntry>,
    instances: Vec<AppInstance>,
    suppressed: HashSet<u32>,
    background_execution: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppInstanceState {
    Running,
    Suspended,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SchedulingFact {
    visible: bool,
    focused: bool,
    order: usize,
    state: AppInstanceState,
}

fn focused_app_instance(facts: &[SchedulingFact]) -> Option<usize> {
    facts
        .iter()
        .enumerate()
        .filter(|(_, fact)| fact.visible && fact.focused && fact.state == AppInstanceState::Running)
        .max_by_key(|(_, fact)| fact.order)
        .map(|(index, _)| index)
}

fn scheduled_app_instances(facts: &[SchedulingFact]) -> Vec<usize> {
    let mut schedule: Vec<usize> = facts
        .iter()
        .enumerate()
        .filter(|(_, fact)| fact.state == AppInstanceState::Running)
        .map(|(index, _)| index)
        .collect();
    schedule.sort_by_key(|index| {
        let fact = facts[*index];
        (!fact.focused, Reverse(fact.order))
    });
    schedule
}

impl AppSupervisor {
    fn new(system: Option<&ResolvedSystemPlan>, shell: &UiSurface) -> Result<Self> {
        let Some(system) = system else {
            return Ok(Self {
                next_generation: 0,
                catalog: Vec::new(),
                instances: Vec::new(),
                suppressed: HashSet::new(),
                background_execution: "suspend".into(),
            });
        };
        system.validate_for_host()?;
        if system.lifecycle.background_execution != "suspend"
            && system.lifecycle.background_execution != "continue"
        {
            return Err(anyhow!("unknown System backgroundExecution policy"));
        }
        let mut catalog = Vec::new();
        for package in &system.applications {
            let surface_handle = shell
                .register_compositor_surface(package.package.clone())
                .ok_or_else(|| anyhow!("reserving compositor surface for {}", package.package))?;
            catalog.push(AppCatalogEntry {
                package: package.clone(),
                surface_handle: surface_handle as u32,
            });
        }
        Ok(Self {
            next_generation: 0,
            catalog,
            instances: Vec::new(),
            suppressed: HashSet::new(),
            background_execution: system.lifecycle.background_execution.clone(),
        })
    }

    fn open(&mut self, surface_handle: u32) -> Result<bool> {
        if self
            .instances
            .iter()
            .any(|instance| instance.surface_handle == surface_handle)
        {
            return Ok(false);
        }
        let entry = self
            .catalog
            .iter()
            .find(|entry| entry.surface_handle == surface_handle)
            .ok_or_else(|| anyhow!("unknown compositor surface handle {surface_handle}"))?;
        let plan = &entry.package.plan;
        let output = &plan.app.output;
        let js_path = resolve_asset(None, output, "js")?;
        let pak_path = resolve_asset(None, output, "pak")?;
        let bundle = std::fs::read_to_string(&js_path)
            .with_context(|| format!("reading {}", js_path.display()))?;
        let pak =
            std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

        let surface = UiSurface::new_with_density(
            (
                plan.viewport.logical[0] as f32,
                plan.viewport.logical[1] as f32,
            ),
            plan.viewport.raster_density,
        );
        surface.set_identity(&plan.target.id, plan.target.host_abi);
        surface.set_tick_rate(TICK_HZ as u32);
        surface.feed_pak(&pak);
        let guest = Guest::new()?;
        surface.mount(&guest)?;
        let offload = text_worker(pak);
        offload.mount(&guest)?;
        guest.eval(output, &bundle)?;
        if !guest.has_frame() {
            return Err(anyhow!("{output} evaluated but installed no frame()"));
        }

        self.next_generation += 1;
        self.instances.push(AppInstance {
            generation: self.next_generation,
            package: entry.package.clone(),
            surface_handle: entry.surface_handle,
            surface,
            guest,
            offload,
            buttons: 0,
            visible: false,
            focused: false,
            order: 0,
            state: AppInstanceState::Running,
        });
        log::info!(
            "pocket-desktop-host: started AppInstance {} ({}, {}x{}, plan={})",
            entry.package.package,
            plan.app.title,
            plan.viewport.logical[0],
            plan.viewport.logical[1],
            plan.plan_hash
        );
        Ok(true)
    }

    /// Reconcile AppInstance lifecycle and scheduling facts from the shell core.
    /// The companion protocol is not involved in this per-frame path.
    fn sync(&mut self, shell: &UiSurface) -> Vec<(String, String)> {
        let bindings = shell.with_ui(|ui| ui.compositor_surface_bindings());
        let frames = shell.with_ui(|ui| ui.compositor_surface_frames());
        let live: HashSet<u32> = bindings.iter().map(|(handle, _)| *handle).collect();

        let mut dropped = Vec::new();
        self.instances.retain(|instance| {
            let keep = live.contains(&instance.surface_handle);
            if !keep {
                dropped.push(instance.package.package.clone());
            }
            keep
        });
        for package in dropped {
            log::info!("pocket-desktop-host: removed AppInstance {package}");
        }
        self.suppressed.retain(|handle| live.contains(handle));

        let mut failures = Vec::new();
        for (handle, _) in &bindings {
            if self
                .instances
                .iter()
                .any(|instance| instance.surface_handle == *handle)
                || self.suppressed.contains(handle)
            {
                continue;
            }
            if let Err(error) = self.open(*handle) {
                let package = self
                    .catalog
                    .iter()
                    .find(|entry| entry.surface_handle == *handle)
                    .map_or_else(
                        || format!("surface:{handle}"),
                        |entry| entry.package.package.clone(),
                    );
                self.suppressed.insert(*handle);
                failures.push((package, error.to_string()));
            }
        }

        for instance in &mut self.instances {
            instance.visible = false;
            instance.focused = bindings
                .iter()
                .find(|(handle, _)| *handle == instance.surface_handle)
                .is_some_and(|(_, focused)| *focused);
            if !instance.focused {
                instance.buttons = 0;
            }
        }
        for frame in frames {
            if let Some(instance) = self
                .instances
                .iter_mut()
                .find(|instance| instance.surface_handle == frame.handle)
            {
                instance.visible = true;
                instance.focused = frame.focused;
                instance.order = frame.order;
                if !frame.focused {
                    instance.buttons = 0;
                }
            }
        }
        for instance in &mut self.instances {
            if !instance.visible {
                instance.focused = false;
            }
            if !instance.focused {
                instance.buttons = 0;
            }
            if instance.state != AppInstanceState::Failed {
                instance.state = if instance.visible || self.background_execution == "continue" {
                    AppInstanceState::Running
                } else {
                    AppInstanceState::Suspended
                };
            }
        }
        failures
    }

    /// Focus is a compositor fact. Route hardware-neutral buttons to the
    /// top focused visible surface and keep their held state across ticks.
    fn set_focused_button(&mut self, button: u32, down: bool) -> bool {
        let facts: Vec<SchedulingFact> = self
            .instances
            .iter()
            .map(|instance| SchedulingFact {
                visible: instance.visible,
                focused: instance.focused,
                order: instance.order,
                state: instance.state,
            })
            .collect();
        let Some(index) = focused_app_instance(&facts) else {
            return false;
        };
        let instance = &mut self.instances[index];
        if down {
            instance.buttons |= button;
        } else {
            instance.buttons &= !button;
        }
        true
    }

    /// Scheduling happens in the native compositor. The System lifecycle
    /// policy maps hidden instances to Running or Suspended; focused/top
    /// surfaces receive their turn first, then remaining running instances.
    fn tick(&mut self) -> Vec<(String, String)> {
        let mut failures = Vec::new();
        let facts: Vec<SchedulingFact> = self
            .instances
            .iter()
            .map(|instance| SchedulingFact {
                visible: instance.visible,
                focused: instance.focused,
                order: instance.order,
                state: instance.state,
            })
            .collect();
        let schedule = scheduled_app_instances(&facts);
        for index in schedule {
            let instance = &mut self.instances[index];
            instance.offload.begin_frame();
            if let Err(error) = instance.guest.frame(instance.buttons) {
                instance.state = AppInstanceState::Failed;
                failures.push((instance.package.package.clone(), error.to_string()));
                continue;
            }
            instance.surface.tick();
        }
        failures
    }

    fn visible_hash(&self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for instance in &self.instances {
            if !instance.visible || instance.state == AppInstanceState::Failed {
                continue;
            }
            instance.surface.with_ui(|ui| {
                let draw_hash = fnv1a64(&ui.draw().words) ^ instance.generation.rotate_left(23);
                let raster_revision = ui.raster_revision();
                mix_app_instance_repaint_hash(
                    &mut hash,
                    instance.surface_handle,
                    draw_hash,
                    raster_revision,
                );
            });
        }
        hash
    }
}

fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}
fn mix_app_instance_repaint_hash(
    hash: &mut u64,
    surface_handle: u32,
    draw_hash: u64,
    raster_revision: u64,
) {
    for byte in surface_handle
        .to_le_bytes()
        .into_iter()
        .chain(draw_hash.to_le_bytes())
        .chain(raster_revision.to_le_bytes())
    {
        *hash ^= byte as u64;
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}
