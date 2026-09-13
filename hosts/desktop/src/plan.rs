#[cfg(target_os = "macos")]
const HOST_ID: &str = "macos-app";
#[cfg(target_os = "linux")]
const HOST_ID: &str = "linux-app";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("pocket-desktop-host supports macOS and Linux");
const HOST_ABI: u32 = 4;
const TICK_HZ: f64 = 60.0;

// spec BTN bits (contracts/spec/spec.ts) — console input mode.
const BTN_SELECT: u32 = 0x0001;
const BTN_START: u32 = 0x0008;
const BTN_UP: u32 = 0x0010;
const BTN_RIGHT: u32 = 0x0020;
const BTN_DOWN: u32 = 0x0040;
const BTN_LEFT: u32 = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_TRIANGLE: u32 = 0x1000;
const BTN_CIRCLE: u32 = 0x2000;
const BTN_CROSS: u32 = 0x4000;
const BTN_SQUARE: u32 = 0x8000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum ScriptEvent {
    /// Push typed characters at a tick (svc `ch` line).
    Type(u64, String),
    /// Press-and-release the pointer at logical (x, y) at a tick.
    Click(u64, f32, f32),
    /// Hold a console button for ~6 ticks starting at a tick.
    Press(u64, u32),
    /// Raw pointer line at a tick: kind 'd' presses, 'u' releases, 'm' moves
    /// with the current scripted button state (drag scripting).
    Mouse(u64, f32, f32, char),
    /// Named key with optional cmd+/alt+/ctl+/sh+ prefixes (svc `key` line).
    Key(u64, String, bool, bool, bool, bool),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // serde requires the complete package plan; not every field is consumed yet.
struct ResolvedAppPlan {
    id: String,
    output: String,
    title: String,
    version: String,
    entry: String,
    framework: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTargetPlan {
    id: String,
    host_abi: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResolvedViewportPlan {
    logical: [u32; 2],
    physical: [u32; 2],
    presentation: String,
    raster_density: u32,
    policy: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPackagePlan {
    app: ResolvedAppPlan,
    target: ResolvedTargetPlan,
    viewport: ResolvedViewportPlan,
    features: HashMap<String, bool>,
    companions: Vec<String>,
    plan_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)]
struct SystemIdentity {
    id: String,
    name: String,
    title: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SystemPackagePlan {
    package: String,
    source: String,
    required: bool,
    plan: ResolvedPackagePlan,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemInstallationPlan {
    installed_packages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemRolesPlan {
    #[serde(rename = "systemUI")]
    system_ui: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemLifecyclePlan {
    background_execution: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedSystemPlan {
    system: SystemIdentity,
    target: ResolvedTargetPlan,
    roles: SystemRolesPlan,
    lifecycle: SystemLifecyclePlan,
    #[allow(dead_code)]
    // The System owns installation state; AppSupervisor only runs its snapshot.
    installation: SystemInstallationPlan,
    #[serde(rename = "systemUI")]
    system_ui: SystemPackagePlan,
    applications: Vec<SystemPackagePlan>,
    #[allow(dead_code)]
    plan_hash: String,
}

impl ResolvedSystemPlan {
    fn validate_for_host(&self) -> Result<&SystemPackagePlan> {
        if self.target.id != HOST_ID || self.target.host_abi != HOST_ABI {
            return Err(anyhow!(
                "Pocket System targets {} ABI {}, host is {} ABI {}",
                self.target.id,
                self.target.host_abi,
                HOST_ID,
                HOST_ABI
            ));
        }
        if self.roles.system_ui != self.system_ui.package {
            return Err(anyhow!(
                "SystemUI role names {}, resolved package is {}",
                self.roles.system_ui,
                self.system_ui.package
            ));
        }
        let mut packages = HashSet::new();
        let mut outputs = HashSet::new();
        for package in std::iter::once(&self.system_ui).chain(self.applications.iter()) {
            if !packages.insert(package.package.clone()) {
                return Err(anyhow!("duplicate System package {}", package.package));
            }
            if !outputs.insert(package.plan.app.output.clone()) {
                return Err(anyhow!(
                    "duplicate System artifact output {}",
                    package.plan.app.output
                ));
            }
            if package.plan.app.id != package.package {
                return Err(anyhow!(
                    "package {} carries plan for {}",
                    package.package,
                    package.plan.app.id
                ));
            }
            if package.plan.target.id != self.target.id
                || package.plan.target.host_abi != self.target.host_abi
            {
                return Err(anyhow!(
                    "package {} resolved for {} ABI {}, not Pocket System target",
                    package.package,
                    package.plan.target.id,
                    package.plan.target.host_abi
                ));
            }
        }
        let installed: HashSet<String> = self
            .installation
            .installed_packages
            .iter()
            .cloned()
            .collect();
        if installed != packages {
            return Err(anyhow!(
                "resolved packages do not match the System installation snapshot"
            ));
        }
        if !self.system_ui.required {
            return Err(anyhow!("SystemUI package must be required"));
        }
        if self.system_ui.plan.features.get("ui.compositor-surfaces") != Some(&true) {
            return Err(anyhow!("SystemUI plan lacks ui.compositor-surfaces"));
        }
        for application in &self.applications {
            if !application.plan.companions.is_empty() {
                return Err(anyhow!(
                    "AppInstance {} declares unsupported companions",
                    application.package
                ));
            }
            if application.plan.features.get("ui.compositor-surfaces") == Some(&true) {
                return Err(anyhow!(
                    "AppInstance {} cannot host compositor surfaces",
                    application.package
                ));
            }
        }
        Ok(&self.system_ui)
    }
}

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    /// Editor-protocol document file (note-widget's --file).
    file: Option<PathBuf>,
    title: String,
    /// Logical viewport at boot (the plan's resolved size).
    viewport: (u32, u32),
    /// Fixed-viewport app: size-locked window, letterboxed canvas.
    fixed: bool,
    /// Install the native text measurer (plan feature text.layout.native).
    native_text: bool,
    /// svc editor protocol instead of console buttons.
    editor: bool,
    /// Companion service names from the plan (svcOpen allowlist).
    companions: Vec<String>,
    /// Complete Pocket System resolution. None runs one ordinary package.
    system: Option<ResolvedSystemPlan>,
    /// `host:port` of a companion that speaks the SVC WIRE (PKNT) protocol.
    /// Set by a companion that opens this window itself.
    svc_connect: Option<String>,
    density: u32,
    script: Vec<ScriptEvent>,
    quit_after_ticks: Option<u64>,
    /// Benchmark typing storm: (chars/sec, start tick, duration ticks) —
    /// svc `ch` lines through the same edit path real typing takes.
    storm: Option<(u32, u64, u64)>,
    /// Print "READY <epoch_ms>" on the first painted frame — the desktop
    /// benchmark runner's cold-start marker (PR #294). Off by default.
    announce_ready: bool,
    /// Emit CPU stage timestamps for native frame profiling.
    trace_frames: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "note-main".into(),
        js: None,
        pak: None,
        file: None,
        title: "PocketJS".into(),
        viewport: (720, 480),
        fixed: false,
        native_text: false,
        editor: false,
        companions: Vec::new(),
        system: None,
        svc_connect: None,
        density: 2,
        script: Vec::new(),
        quit_after_ticks: None,
        storm: None,
        announce_ready: false,
        trace_frames: false,
    };
    let mut system_plan_path = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--file" => args.file = Some(PathBuf::from(val("--file")?)),
            "--title" => args.title = val("--title")?,
            "--viewport" => {
                let v = val("--viewport")?;
                let (w, h) = v.split_once('x').ok_or_else(|| anyhow!("--viewport WxH"))?;
                args.viewport = (w.parse()?, h.parse()?);
            }
            "--fixed" => args.fixed = true,
            "--native-text" => args.native_text = true,
            "--editor" => args.editor = true,
            "--companions" => {
                args.companions = val("--companions")?
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            "--system-plan" => {
                system_plan_path = Some(PathBuf::from(val("--system-plan")?));
            }
            "--svc-connect" => args.svc_connect = Some(val("--svc-connect")?),
            "--density" => args.density = val("--density")?.parse::<u32>()?.clamp(1, 4),
            "--type" => {
                // --type TEXT@TICK
                let v = val("--type")?;
                let (s, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--type TEXT@TICK"))?;
                args.script
                    .push(ScriptEvent::Type(t.parse()?, s.to_string()));
            }
            "--click" => {
                // --click X,Y@TICK
                let v = val("--click")?;
                let (xy, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--click X,Y@TICK"))?;
                let (x, y) = xy
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click X,Y@TICK"))?;
                args.script
                    .push(ScriptEvent::Click(t.parse()?, x.parse()?, y.parse()?));
            }
            "--mouse" => {
                // --mouse X,Y[,d|u|r]@TICK — scripted pointer line (m = move,
                // r = right press+release).
                let v = val("--mouse")?;
                let (spec, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--mouse X,Y[,d|u]@TICK"))?;
                let parts: Vec<&str> = spec.split(',').collect();
                if parts.len() < 2 || parts.len() > 3 {
                    return Err(anyhow!("--mouse X,Y[,d|u]@TICK"));
                }
                let kind = parts
                    .get(2)
                    .map_or('m', |s| s.chars().next().unwrap_or('m'));
                args.script.push(ScriptEvent::Mouse(
                    t.parse()?,
                    parts[0].parse()?,
                    parts[1].parse()?,
                    kind,
                ));
            }
            "--key" => {
                // --key [cmd+][alt+][ctl+][sh+]NAME@TICK — scripted svc key line.
                let v = val("--key")?;
                let (mut name, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--key NAME@TICK"))?;
                let (mut cmd, mut alt, mut ctl, mut sh) = (false, false, false, false);
                loop {
                    if let Some(rest) = name.strip_prefix("cmd+") {
                        cmd = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("alt+") {
                        alt = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("ctl+") {
                        ctl = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("sh+") {
                        sh = true;
                        name = rest;
                    } else {
                        break;
                    }
                }
                args.script.push(ScriptEvent::Key(
                    t.parse()?,
                    name.to_string(),
                    cmd,
                    alt,
                    ctl,
                    sh,
                ));
            }
            "--quit-after" => args.quit_after_ticks = Some(val("--quit-after")?.parse()?),
            "--announce-ready" => args.announce_ready = true,
            "--trace-frames" => args.trace_frames = true,
            "--press" => {
                // --press NAME@TICK (console button script: up/down/left/
                // right/cross/circle/square/triangle/l/r/start/select)
                let v = val("--press")?;
                let (name, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--press NAME@TICK"))?;
                let bit =
                    button_for(name).ok_or_else(|| anyhow!("--press: unknown button {name}"))?;
                args.script.push(ScriptEvent::Press(t.parse()?, bit));
            }
            "--storm" => {
                // --storm CPS@START+DUR (ticks)
                let v = val("--storm")?;
                let (cps, rest) = v
                    .split_once('@')
                    .ok_or_else(|| anyhow!("--storm CPS@START+DUR"))?;
                let (start, dur) = rest
                    .split_once('+')
                    .ok_or_else(|| anyhow!("--storm CPS@START+DUR"))?;
                args.storm = Some((cps.parse()?, start.parse()?, dur.parse()?));
            }
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    if let Some(path) = system_plan_path {
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading Pocket System plan {}", path.display()))?;
        let system: ResolvedSystemPlan = serde_json::from_slice(&bytes)
            .with_context(|| format!("decoding Pocket System plan {}", path.display()))?;
        let shell = system.validate_for_host()?;
        args.app = shell.plan.app.output.clone();
        args.title = system.system.title.clone();
        args.viewport = (
            shell.plan.viewport.logical[0],
            shell.plan.viewport.logical[1],
        );
        args.fixed = shell.plan.viewport.policy == "fixed";
        args.native_text = shell
            .plan
            .features
            .get("text.layout.native")
            .copied()
            .unwrap_or(false);
        args.companions = shell.plan.companions.clone();
        args.editor = args.companions.iter().any(|companion| companion == "note");
        args.density = shell.plan.viewport.raster_density.clamp(1, 4);
        // System package assets are selected only by their resolved outputs;
        // command-line bundle overrides cannot replace the System UI shell.
        args.js = None;
        args.pak = None;
        args.system = Some(system);
    }
    Ok(args)
}

/// `<repo>/dist` — relative to this crate in the source tree, or
/// POCKETJS_DIST, or ./dist for standalone binaries.
fn dist_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("POCKETJS_DIST") {
        return Some(PathBuf::from(d));
    }
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../dist")
        .canonicalize()
        .ok();
    from_manifest.or_else(|| {
        let cwd = PathBuf::from("dist");
        cwd.is_dir().then_some(cwd)
    })
}

fn resolve_asset(explicit: Option<PathBuf>, app: &str, ext: &str) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return p
            .canonicalize()
            .with_context(|| format!("missing {}", p.display()));
    }
    let dist =
        dist_dir().ok_or_else(|| anyhow!("cannot find PocketJS dist/ (set POCKETJS_DIST)"))?;
    let candidates = [format!("{app}.{ext}"), format!("{app}-main.{ext}")];
    for c in &candidates {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} — build its resolved package artifacts first",
        dist.display()
    ))
}
