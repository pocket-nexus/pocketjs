//! data.fs — the per-app file tree mounted as the guest's `globalThis.fs`.
//!
//! The module core is engine/crates/pocket-fs (the same reference core the
//! sim host and the ESP data-smoke exercise); this file only binds its port
//! point: the app's own data root on the host operating system. One module
//! instance per guest, so two apps cannot name each other's trees — the
//! vocabulary is relative paths and the bound root is the sandbox boundary
//! (docs/FS.md).
//!
//! Layout under the host data base:
//!
//! ```text
//! <base>/<app-id>/data   # the bound root the guest names
//! <base>/<app-id>/tmp    # host-private: atomic truncate-write temps,
//!                        # a sibling on the same filesystem so rename is
//!                        # atomic (the module owns and sweeps this dir)
//! ```
//!
//! `<base>` is `$XDG_DATA_HOME/pocketjs` on Linux (XDG default
//! `~/.local/share/pocketjs`) and `~/Library/Application Support/pocketjs`
//! on macOS; `--data-root` overrides the base for tests and portable runs.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{Result, anyhow};
use pocket_fs::{FsModule, Storage};

const DATA_DIR: &str = "data";
const TMP_DIR: &str = "tmp";

/// The two host directories one fs instance binds: `data` is the root the
/// guest names; `tmp` is host-private machinery, never visible inside it.
pub(crate) struct FsRoots {
    pub(crate) data: PathBuf,
    pub(crate) tmp: PathBuf,
}

/// An app id must be a single path segment. Resolved plans carry reverse-DNS
/// ids and command-line packages carry output basenames; anything that could
/// steer the join outside the base (`/`, `..`, a NUL) is a host error
/// instead of a directory name.
fn fs_safe_app_id(app_id: &str) -> Result<&str> {
    if app_id.is_empty()
        || app_id == "."
        || app_id == ".."
        || app_id.contains('/')
        || app_id.contains('\\')
        || app_id.contains('\0')
    {
        return Err(anyhow!("unsafe app id for fs data root: {app_id:?}"));
    }
    Ok(app_id)
}

/// Default host data base: XDG data home on Linux, Application Support on
/// macOS (the platform port points docs/FS.md names).
fn default_base() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home =
            std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME is unset; pass --data-root"))?;
        Ok(PathBuf::from(home).join("Library/Application Support/pocketjs"))
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME")
            && !xdg.is_empty()
        {
            return Ok(PathBuf::from(xdg).join("pocketjs"));
        }
        let home =
            std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME is unset; pass --data-root"))?;
        Ok(PathBuf::from(home).join(".local/share/pocketjs"))
    }
}

/// Canonicalize a pre-bound component that exists on disk. `canonicalize`
/// follows the whole chain, so a real component beneath a symlinked ancestor
/// is caught as well; a dangling or looping link errors here instead of
/// silently escaping.
fn confined_canonical(component: &Path, allowed: &Path) -> Result<PathBuf> {
    let resolved = std::fs::canonicalize(component).map_err(|e| {
        anyhow!("fs bind component {component:?} is a symlink that does not resolve: {e}")
    })?;
    if !resolved.starts_with(allowed) {
        return Err(anyhow!(
            "fs bind component {component:?} resolves to {resolved:?}, outside the app data root {allowed:?}"
        ));
    }
    Ok(resolved)
}

/// The canonical path a missing component will have after `data_roots`
/// creates it as a real directory under its already-validated parent.
fn planned_child(parent_real: &Path, segment: &str) -> PathBuf {
    parent_real.join(segment)
}

/// Bind-time symlink boundary for the pre-bound components. The module core
/// lstat-checks every segment *inside* the bound root, but its walk starts at
/// the already-bound `data` path, so a symlink planted at `<base>/<app-id>`
/// (or at the `data`/`tmp` children themselves) would steer the whole tree
/// past the sandbox before a single op runs. A link is accepted only when its
/// resolved target stays inside the app's own subtree, `<base>/<app-id>`; a
/// link to another app's tree, outside the base, or one that dangles or
/// loops is a host error (docs/FS.md, "The storage rule").
///
/// Two further conditions keep the bound tree and the host-private temp
/// directory apart. First, their canonical trees must be disjoint: the
/// module constructor sweeps `tmp`, so an aliased overlap (for example
/// `data -> tmp`) would delete player saves on mount. Second, the canonical
/// paths verified here are the paths the module binds — returning the lexical
/// alias would leave an accepted link free to retarget at another app after
/// the check.
fn bind_roots(base: &Path, app_id: &str) -> Result<FsRoots> {
    // The base is host-chosen policy (XDG data home or `--data-root`); make
    // sure it exists, then resolve it so symlinked ancestors (/tmp on macOS,
    // a linked home) are absorbed into the comparison prefix.
    std::fs::create_dir_all(base)
        .map_err(|e| anyhow!("cannot create fs data base {base:?}: {e}"))?;
    let allowed = std::fs::canonicalize(base)
        .map_err(|e| anyhow!("cannot resolve fs data base {base:?}: {e}"))?
        .join(app_id);

    let app_root = base.join(app_id);
    let data = app_root.join(DATA_DIR);
    let tmp = app_root.join(TMP_DIR);

    // Validate the lexical plan before creating anything. app-root first: it
    // is the ancestor the core's resolver never sees. A missing component is
    // created afterwards as a real directory under its validated parent, so
    // its canonical path is the parent's resolved path plus its own segment.
    let app_real = if std::fs::symlink_metadata(&app_root).is_ok() {
        confined_canonical(&app_root, &allowed)?
    } else {
        allowed.clone()
    };
    let data_real = if std::fs::symlink_metadata(&data).is_ok() {
        confined_canonical(&data, &allowed)?
    } else {
        planned_child(&app_real, DATA_DIR)
    };
    let tmp_real = if std::fs::symlink_metadata(&tmp).is_ok() {
        confined_canonical(&tmp, &allowed)?
    } else {
        planned_child(&app_real, TMP_DIR)
    };

    // Equal roots, or either canonical tree containing the other, all put
    // guest data where the tmp sweep (or a truncate-write temp) reaches it.
    // Path::starts_with compares whole components, so `tmp` cannot match a
    // sibling named `tmp2`.
    if data_real == tmp_real || data_real.starts_with(&tmp_real) || tmp_real.starts_with(&data_real)
    {
        return Err(anyhow!(
            "fs bind data and tmp roots overlap: data resolves to {data_real:?}, tmp resolves to {tmp_real:?}"
        ));
    }

    // Only data is created at bind time; tmp stays absent until the core
    // needs it for a truncate write, so mounting never creates a directory
    // through a tmp path that was not part of this plan.
    std::fs::create_dir_all(&data)
        .map_err(|e| anyhow!("cannot create fs data root {data:?}: {e}"))?;

    Ok(FsRoots {
        data: data_real,
        tmp: tmp_real,
    })
}

/// Resolve (and create) the per-app data/tmp roots. The returned paths are
/// canonical: they name the directories checked here, not lexical aliases a
/// host actor could retarget after the bind.
pub(crate) fn data_roots(base: Option<&Path>, app_id: &str) -> Result<FsRoots> {
    let app_id = fs_safe_app_id(app_id)?;
    let base = base.map_or_else(default_base, |dir| Ok(dir.to_path_buf()))?;
    bind_roots(&base, app_id)
}

/// Strong handle the host keeps beside the guest; the mount closures hold
/// their own clones, but the host struct owning one makes the lifetime
/// explicit (the way it owns the text offload worker).
pub(crate) type FsMount = Rc<RefCell<FsModule>>;

/// Construct the fs module bound to a guest's data root and mount it as
/// `globalThis.fs`. Returns the handle the host keeps for the guest's life.
pub(crate) fn mount_fs(guest: &pocket_mod::Guest, roots: &FsRoots) -> Result<FsMount> {
    let module = Rc::new(RefCell::new(FsModule::new(Storage::Dir {
        root: roots.data.clone(),
        tmp: roots.tmp.clone(),
    })));
    pocket_fs::mount(guest, module.clone())?;
    Ok(module)
}
