//! Package-scoped native loading. Guest messages cannot choose a library path.
use anyhow::{Context, Result, anyhow, ensure};
use pocket_desktop_native::{ABI, Api, BUILD, Event, Frame, Gpu, Init};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::c_void,
    path::{Component, Path, PathBuf},
    ptr::NonNull,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Extension {
    kind: String,
    version: u32,
    payload_hash: String,
    payload: Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Module {
    pub library: String,
    pub sha256: String,
    #[serde(default)]
    pub config: Value,
}
impl Extension {
    pub fn module(&self) -> Result<Module> {
        ensure!(
            self.kind == "desktop-native" && self.version == 1,
            "unsupported desktop host extension"
        );
        let hash = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&self.payload)?)
        );
        ensure!(
            self.payload_hash == hash,
            "native extension payload hash mismatch"
        );
        let module: Module = serde_json::from_value(self.payload.clone())?;
        ensure!(
            module.library.len() <= 1024
                && module.sha256.len() == 64
                && module.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid native module descriptor"
        );
        relative_path(&module.library)?;
        ensure!(
            serde_json::to_vec(&module.config)?.len() <= 16384,
            "native module config exceeds budget"
        );
        Ok(module)
    }
}
fn relative_path(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    ensure!(
        !value.is_empty()
            && !value.contains('\\')
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "native library must be package-relative"
    );
    Ok(path)
}
fn library_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let path = root.join(relative_path(relative)?).canonicalize()?;
    ensure!(
        path.starts_with(&root) && path.is_file(),
        "native library escapes package root"
    );
    Ok(path)
}
fn checked_api(api: &Api, package: &str) -> Result<()> {
    ensure!(
        api.abi == ABI && api.size as usize == std::mem::size_of::<Api>(),
        "native module ABI mismatch"
    );
    ensure!(
        api.build == BUILD.as_bytes(),
        "native module build mismatch; rebuild host and module from the same SDK, compiler and profile"
    );
    ensure!(
        api.graph == env!("POCKET_NATIVE_GRAPH").as_bytes(),
        "native GPU dependency graph mismatch; rebuild with the host dependency versions and features"
    );
    let id = std::str::from_utf8(&api.package)?.trim_end_matches('\0');
    ensure!(id == package, "native module package identity mismatch");
    ensure!(
        api.flags & !pocket_desktop_native::POINTER_LOCK == 0,
        "unsupported native module flags"
    );
    Ok(())
}
#[derive(Default)]
pub struct Modules {
    loaded: HashMap<PathBuf, (String, Api)>,
}
impl Modules {
    pub fn open(
        &mut self,
        module: &Module,
        root: &Path,
        package: &str,
        gpu: &Gpu,
        logical: [u32; 2],
        density: u32,
    ) -> Result<Instance> {
        let path = library_path(root, &module.library)?;
        if !self.loaded.contains_key(&path) {
            ensure!(
                self.loaded.len() < 64,
                "native module image budget exceeded"
            );
            let hash = format!("{:x}", Sha256::digest(std::fs::read(&path)?));
            ensure!(
                hash == module.sha256,
                "native library content hash mismatch"
            );
            // Only validated installation artifacts reach dlopen. Constructors,
            // like the rest of native code, belong to the trusted application.
            let library =
                unsafe { libloading::Library::new(&path) }.context("loading native application")?;
            let entry: libloading::Symbol<unsafe extern "C" fn() -> *const Api> =
                unsafe { library.get(b"pocket_native_app_v1\0") }?;
            let raw = unsafe { entry() };
            ensure!(!raw.is_null(), "native module returned no API");
            // Read the fixed two-word header before accessing any later field.
            let header = unsafe { std::ptr::read_unaligned(raw.cast::<[u32; 2]>()) };
            ensure!(
                header == [ABI, std::mem::size_of::<Api>() as u32],
                "native module ABI mismatch"
            );
            let api = unsafe { &*raw };
            checked_api(api, package)?;
            self.loaded.insert(path.clone(), (hash, *api));
            // GPU submissions and driver resources can outlive a closed app.
            // Keep executable code mapped until process exit; app contexts are
            // still destroyed on close. Catalog and image counts are bounded.
            std::mem::forget(library);
            log::info!("loaded native module {package}");
        }
        let (hash, api) = self.loaded.get(&path).unwrap();
        ensure!(
            *hash == module.sha256,
            "native module changed; restart the host"
        );
        checked_api(api, package)?;
        let resources = path
            .parent()
            .context("native resources directory missing")?
            .to_string_lossy();
        let config = serde_json::to_string(&module.config)?;
        let init = Init {
            gpu: (gpu as *const Gpu).cast(),
            root: resources.as_ptr(),
            root_len: resources.len(),
            config: config.as_ptr(),
            config_len: config.len(),
            width: logical[0],
            height: logical[1],
            density,
        };
        let mut error = [0; 2048];
        let state = NonNull::new(unsafe { (api.create)(&init, error.as_mut_ptr(), error.len()) })
            .ok_or_else(|| failure(&error))?;
        Ok(Instance {
            api: *api,
            state,
            revision: 0,
        })
    }
}
fn failure(error: &[u8]) -> anyhow::Error {
    anyhow!("{}", String::from_utf8_lossy(error).trim_end_matches('\0'))
}
pub struct Instance {
    api: Api,
    state: NonNull<c_void>,
    pub revision: u64,
}
impl Instance {
    pub fn pointer_lock(&self) -> bool {
        self.api.flags & pocket_desktop_native::POINTER_LOCK != 0
    }
    pub fn event(&mut self, event: Event) -> Result<()> {
        let mut error = [0; 2048];
        ensure!(
            unsafe {
                (self.api.event)(self.state.as_ptr(), &event, error.as_mut_ptr(), error.len())
            },
            "{}",
            failure(&error)
        );
        Ok(())
    }
    pub fn tick(&mut self) -> Result<()> {
        let mut error = [0; 2048];
        ensure!(
            unsafe {
                (self.api.tick)(
                    self.state.as_ptr(),
                    1.0 / 60.0,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            "{}",
            failure(&error)
        );
        self.revision = self.revision.wrapping_add(1);
        Ok(())
    }
    pub fn render(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        linear_target: &wgpu::TextureView,
        size: (u32, u32),
    ) -> Result<()> {
        let frame = Frame {
            gpu: (gpu as *const Gpu).cast(),
            encoder: (encoder as *mut wgpu::CommandEncoder).cast(),
            target: (target as *const wgpu::TextureView).cast(),
            linear_target: (linear_target as *const wgpu::TextureView).cast(),
            width: size.0,
            height: size.1,
        };
        let mut error = [0; 2048];
        ensure!(
            unsafe {
                (self.api.render)(self.state.as_ptr(), &frame, error.as_mut_ptr(), error.len())
            },
            "{}",
            failure(&error)
        );
        Ok(())
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            (self.api.destroy)(self.state.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escaping_paths_and_tampered_payloads() {
        for path in [
            "",
            "/tmp/module.dylib",
            "../module.so",
            "apps/../../module.so",
            "apps\\module.so",
        ] {
            assert!(relative_path(path).is_err());
        }
        assert!(relative_path("apps/example/libexample.dylib").is_ok());
        let payload = serde_json::json!({"library":"apps/example/libexample.dylib","sha256":"a".repeat(64),"config":{}});
        let mut ext = Extension {
            kind: "desktop-native".into(),
            version: 1,
            payload_hash: format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&payload).unwrap())
            ),
            payload,
        };
        assert!(ext.module().is_ok());
        ext.payload["library"] = "different.so".into();
        assert!(ext.module().is_err());
    }
    #[test]
    #[ignore = "requires POCKET_NATIVE_FIXTURE, built with the same SDK and profile"]
    fn dynamic_module_owns_independent_state_and_releases_it() -> Result<()> {
        let source = PathBuf::from(std::env::var("POCKET_NATIVE_FIXTURE")?);
        let root = std::env::temp_dir().join(format!("pocket-native-{}", std::process::id()));
        std::fs::create_dir_all(&root)?;
        let name = source.file_name().unwrap().to_str().unwrap();
        std::fs::copy(&source, root.join(name))?;
        let _ = std::fs::remove_file(root.join("events.log"));
        let module = Module {
            library: name.into(),
            sha256: format!("{:x}", Sha256::digest(std::fs::read(&source)?)),
            config: Value::Null,
        };
        let gpu = Gpu::new_headless()?;
        let mut modules = Modules::default();
        let id = "dev.pocket-stack.native-fixture";
        let mut broken = module.clone();
        broken.sha256 = "0".repeat(64);
        assert!(modules.open(&broken, &root, id, &gpu, [32, 32], 1).is_err());
        assert!(
            modules
                .open(&module, &root, "wrong.package", &gpu, [32, 32], 1)
                .is_err()
        );
        let mut a = modules.open(&module, &root, id, &gpu, [32, 32], 1)?;
        let mut incompatible = a.api;
        incompatible.abi += 1;
        assert!(checked_api(&incompatible, id).is_err());
        incompatible = a.api;
        incompatible.build[0] ^= 1;
        assert!(checked_api(&incompatible, id).is_err());
        incompatible = a.api;
        incompatible.graph[0] ^= 1;
        assert!(checked_api(&incompatible, id).is_err());
        let mut b = modules.open(&module, &root, id, &gpu, [32, 32], 1)?;
        a.event(Event::key("w", true))?;
        a.tick()?;
        a.tick()?;
        b.tick()?;
        let target = pocket3d::gpu::OffscreenTarget::new(&gpu, 32, 32);
        for (instance, pixel) in [(&mut a, [255, 0, 0, 255]), (&mut b, [0, 0, 255, 255])] {
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            instance.render(&gpu, &mut encoder, &target.view, &target.view, (32, 32))?;
            gpu.queue.submit([encoder.finish()]);
            assert_eq!(&target.read_rgba(&gpu)?[..4], &pixel);
        }
        a.event(Event {
            kind: pocket_desktop_native::RESET,
            ..Default::default()
        })?;
        drop(a);
        drop(b);
        let mut reopened = modules.open(&module, &root, id, &gpu, [32, 32], 1)?;
        reopened.tick()?;
        drop(reopened);
        let journal = std::fs::read_to_string(root.join("events.log"))?;
        assert_eq!(journal.lines().filter(|v| *v == "create").count(), 3);
        assert_eq!(journal.lines().filter(|v| *v == "destroy").count(), 3);
        assert_eq!(journal.lines().filter(|v| *v == "tick:1").count(), 3);
        assert!(journal.contains("reset"));
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
