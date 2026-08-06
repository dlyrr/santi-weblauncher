//! Persisted settings and install profiles.
//!
//! A profile is one managed Roblox install: its own channel, its own pinned
//! version and its own FFlag overrides. That separation is the point — you can
//! hold one profile on an older build for an executor that hasn't updated while
//! another tracks LIVE for actually playing.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::deploy::BinaryType;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default = "default_binary_type")]
    pub binary_type: BinaryType,
    #[serde(default = "default_channel")]
    pub channel: String,
    /// `None` means "track whatever is newest on the channel".
    #[serde(default)]
    pub pinned_version: Option<String>,
    /// The version currently on disk for this profile, if any.
    #[serde(default)]
    pub installed_version: Option<String>,
    #[serde(default)]
    pub fflags: Map<String, Value>,
}

fn default_binary_type() -> BinaryType {
    BinaryType::WindowsPlayer
}

fn default_channel() -> String {
    "LIVE".to_string()
}

impl Profile {
    pub fn new(id: String, name: String, binary_type: BinaryType) -> Self {
        Self {
            id,
            name,
            binary_type,
            channel: default_channel(),
            pinned_version: None,
            installed_version: None,
            fflags: Map::new(),
        }
    }

    /// Where a given version lives for this profile. Versions are kept side by
    /// side so switching back to a previous build doesn't mean redownloading it.
    pub fn install_dir(&self, root: &Path, version: &str) -> PathBuf {
        root.join("profiles").join(&self.id).join(version)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile: Option<String>,
    /// Whether to hold Roblox on a fixed release channel.
    #[serde(default = "default_true")]
    pub pin_channel: bool,
    #[serde(default = "default_channel")]
    pub pinned_channel: String,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        let profile = Profile::new(
            "default".to_string(),
            "Default".to_string(),
            BinaryType::WindowsPlayer,
        );
        Self {
            active_profile: Some(profile.id.clone()),
            profiles: vec![profile],
            pin_channel: true,
            pinned_channel: default_channel(),
        }
    }
}

impl Settings {
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn profile_mut(&mut self, id: &str) -> Option<&mut Profile> {
        self.profiles.iter_mut().find(|profile| profile.id == id)
    }

    /// Generate an id that does not collide with an existing profile.
    pub fn next_id(&self, seed: &str) -> String {
        let base: String = seed
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let base = base.trim_matches('-').to_string();
        let base = if base.is_empty() { "profile".to_string() } else { base };

        if self.profile(&base).is_none() {
            return base;
        }

        (2..)
            .map(|n| format!("{base}-{n}"))
            .find(|candidate| self.profile(candidate).is_none())
            .expect("an unused id always exists")
    }
}

fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

pub fn load(root: &Path) -> Settings {
    let path = settings_path(root);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };

    // A corrupt settings file should cost you your preferences, not the app.
    serde_json::from_str(&text).unwrap_or_else(|_| Settings::default())
}

pub fn save(root: &Path, settings: &Settings) -> Result<()> {
    std::fs::create_dir_all(root).context("creating the app data directory")?;
    let json = serde_json::to_string_pretty(settings)?;

    // Write-then-rename so a crash mid-write can't truncate the real file.
    let temporary = settings_path(root).with_extension("json.tmp");
    std::fs::write(&temporary, json).context("writing settings")?;
    std::fs::rename(&temporary, settings_path(root)).context("replacing settings")?;

    Ok(())
}
