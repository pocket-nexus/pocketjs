//! Codex sign-in state copied from a signed-in computer. The access token is a
//! JWT with its own expiry; it refreshes through the same OAuth client the Codex
//! CLI uses, and the rotated tokens land back in this file atomically.
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Refresh this long before the token's own expiry.
const MARGIN_SECONDS: i64 = 300;

pub struct Auth {
    path: PathBuf,
    state: Value,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs() as i64)
}

/// The `exp` claim of a JWT, without verifying it: the server does that.
pub fn jwt_expiry(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["exp"].as_i64()
}

impl Auth {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("{}: no Codex sign-in on this device", path.display()))?;
        let state: Value = serde_json::from_str(&text).context("auth.json")?;
        anyhow::ensure!(
            state["tokens"]["access_token"].is_string(),
            "auth.json holds no ChatGPT tokens"
        );
        Ok(Self {
            path: path.to_owned(),
            state,
        })
    }

    pub fn account(&self) -> &str {
        self.state["tokens"]["account_id"].as_str().unwrap_or("")
    }

    pub fn access(&self) -> &str {
        self.state["tokens"]["access_token"].as_str().unwrap_or("")
    }

    pub fn seconds_left(&self) -> Option<i64> {
        jwt_expiry(self.access()).map(|expiry| expiry - now())
    }

    pub fn needs_refresh(&self) -> bool {
        self.seconds_left().is_none_or(|left| left < MARGIN_SECONDS)
    }

    /// Exchange the refresh token. The server rotates it: the old one stops
    /// working here and on the computer this file was copied from.
    pub fn refresh(&mut self, agent: &ureq::Agent) -> Result<()> {
        let refresh = self.state["tokens"]["refresh_token"]
            .as_str()
            .ok_or_else(|| anyhow!("no refresh token"))?
            .to_owned();
        let body = json!({ "client_id": CLIENT_ID, "grant_type": "refresh_token", "refresh_token": refresh, "scope": "openid profile email" });
        let mut response = agent
            .post(TOKEN_URL)
            .header("content-type", "application/json")
            .send(body.to_string())
            .map_err(|error| anyhow!("token refresh: {error}"))?;
        let reply: Value = serde_json::from_reader(response.body_mut().as_reader())
            .context("token refresh reply")?;
        self.apply(&reply)?;
        self.save()
    }

    pub fn apply(&mut self, reply: &Value) -> Result<()> {
        let access = reply["access_token"]
            .as_str()
            .ok_or_else(|| anyhow!("token refresh: {reply}"))?;
        let tokens = &mut self.state["tokens"];
        tokens["access_token"] = json!(access);
        if let Some(id) = reply["id_token"].as_str() {
            tokens["id_token"] = json!(id);
        }
        if let Some(refresh) = reply["refresh_token"].as_str() {
            tokens["refresh_token"] = json!(refresh);
        }
        self.state["last_refresh"] = json!(now());
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&self.state)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(exp: i64) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(json!({ "exp": exp }).to_string());
        format!("h.{payload}.s")
    }

    #[test]
    fn reads_expiry_and_decides_refresh() {
        assert_eq!(jwt_expiry(&token(1234)), Some(1234));
        assert_eq!(jwt_expiry("not-a-jwt"), None);
        let directory = std::env::temp_dir().join(format!("pocket-auth-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("auth.json");
        let write = |access: String| {
            std::fs::write(&path, json!({ "tokens": { "access_token": access, "refresh_token": "r", "account_id": "a" } }).to_string()).unwrap()
        };
        write(token(now() + 3600));
        assert!(!Auth::load(&path).unwrap().needs_refresh());
        write(token(now() + 30));
        assert!(Auth::load(&path).unwrap().needs_refresh());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_refresh_reply_rotates_tokens_and_persists() {
        let directory =
            std::env::temp_dir().join(format!("pocket-auth-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("auth.json");
        std::fs::write(&path, json!({ "tokens": { "access_token": "old", "refresh_token": "r1", "id_token": "i1", "account_id": "a" } }).to_string()).unwrap();
        let mut auth = Auth::load(&path).unwrap();
        auth.apply(&json!({ "access_token": token(99), "refresh_token": "r2", "id_token": "i2" }))
            .unwrap();
        auth.save().unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["tokens"]["refresh_token"], "r2");
        assert_eq!(saved["tokens"]["id_token"], "i2");
        assert_eq!(saved["tokens"]["account_id"], "a");
        assert!(auth.apply(&json!({ "error": "invalid_grant" })).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
