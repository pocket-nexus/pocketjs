//! USB mailbox protocol and update admission, independent of Vita services.
use pocketjs_core::package::{self, Package};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u32 = 1;
pub const MAX_PACKAGE: usize = 32 * 1024 * 1024;
pub const MAX_NATIVE: usize = 64 * 1024 * 1024;
pub const MAX_CONTROL: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub version: u32,
    pub session: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Op {
    Status,
    Push,
    Reload,
    Capture,
    Menu,
    Native,
    Reset,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub version: u32,
    pub session: String,
    pub id: String,
    pub op: Op,
    #[serde(default)]
    pub size: usize,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub build: String,
    #[serde(default)]
    pub title_id: String,
}

pub fn hex_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Command {
    pub fn validate(&self, session: &Session) -> Result<(), String> {
        if self.version != VERSION
            || session.version != VERSION
            || !hex_id(&self.id)
            || !hex_id(&session.session)
            || self.session != session.session
        {
            return Err("invalid protocol, session or command id".into());
        }
        if matches!(self.op, Op::Push | Op::Native) {
            let cap = if self.op == Op::Native {
                MAX_NATIVE
            } else {
                MAX_PACKAGE
            };
            if self.size == 0
                || self.size > cap
                || self.hash.len() != 16
                || !self.hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("invalid upload size or checksum".into());
            }
        }
        if self.op == Op::Native
            && (!hex_id(&self.build)
                || self.title_id.len() != 9
                || !self.title_id.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            return Err("invalid native build identity".into());
        }
        Ok(())
    }

    pub fn check_payload(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() != self.size || format!("{:016x}", package::fnv1a64(&[bytes])) != self.hash {
            return Err("upload size/checksum mismatch; active guest retained".into());
        }
        Ok(())
    }
}

/// Changes to entry paths and display/version metadata do not change native services.
/// Every other plan field must match, including extensions and future fields.
pub fn native_contract(plan: &Value) -> Value {
    let mut result = plan.clone();
    if let Some(object) = result.as_object_mut() {
        object.remove("planHash");
    }
    if let Some(app) = result.get_mut("app").and_then(Value::as_object_mut) {
        for key in ["entry", "title", "version"] {
            app.remove(key);
        }
    }
    if let Some(presentation) = result
        .get_mut("presentation")
        .and_then(Value::as_object_mut)
    {
        presentation.remove("entry");
    }
    result
}

#[derive(Debug)]
pub struct Bundle {
    pub js: String,
    pub pak: std::sync::Arc<[u8]>,
    pub hash: String,
}

pub fn admit(bytes: &[u8], plan: &Value) -> Result<Bundle, String> {
    if bytes.len() > MAX_PACKAGE {
        return Err("package exceeds 32 MiB".into());
    }
    let guest =
        package::select_guest(bytes, "vita", 2, false).map_err(|e| format!("package: {e:?}"))?;
    let package = Package::parse(bytes, true).map_err(|e| format!("package: {e:?}"))?;
    let identity = package
        .find_variant("vita")
        .unwrap()
        .unwrap()
        .identity()
        .map_err(|e| format!("identity: {e:?}"))?
        .ok_or("missing identity")?;
    let next: Value = serde_json::from_slice(guest.plan).map_err(|e| format!("plan: {e}"))?;
    if plan.get("app").is_none()
        || identity.id != plan["app"]["id"].as_str().unwrap_or("")
        || identity.output != plan["app"]["output"].as_str().unwrap_or("")
        || native_contract(&next) != native_contract(plan)
    {
        return Err(
            "native contract or application identity changed; rebuild and push native runtime"
                .into(),
        );
    }
    let js = std::str::from_utf8(guest.js)
        .map_err(|_| "JavaScript is not UTF-8")?
        .to_string();
    if js[..js.len() - 1].contains('\0') {
        return Err("JavaScript contains an interior NUL".into());
    }
    Ok(Bundle {
        js,
        pak: guest.pak.into(),
        hash: format!(
            "{:016x}",
            package::fnv1a64(&[&guest.js[..guest.js.len() - 1], guest.pak])
        ),
    })
}
