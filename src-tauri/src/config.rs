//! Persisted settings and install profiles.
//!
//! A profile is one managed Roblox install: its own channel, its own pinned
//! version and its own FFlag overrides. That separation is the point — you can
//! hold one profile on an older build for an executor that hasn't updated while
//! another tracks LIVE.

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
    /// Executor title to keep this profile's pinned version in step with.
    #[serde(default)]
    pub exploit_sync: Option<String>,
}

fn default_binary_type() -> BinaryType {
    BinaryType::WindowsPlayer
}

fn default_channel() -> String {
    "LIVE".to_string()
}

fn default_true() -> bool {
    true
}

fn default_fps_cap() -> u32 {
    240
}

fn default_launch_delay() -> u32 {
    3
}

fn default_ui_scale() -> u32 {
    100
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
            exploit_sync: None,
        }
    }

    /// Where a given version lives for this profile. Versions are kept side by
    /// side so switching back to a previous build doesn't mean redownloading it.
    pub fn install_dir(&self, root: &Path, version: &str) -> PathBuf {
        root.join("profiles").join(&self.id).join(version)
    }
}

/// Colours and chrome for the launcher itself. Stored as hex strings and handed
/// straight to CSS custom properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    #[serde(default = "theme_background")]
    pub background: String,
    #[serde(default = "theme_surface")]
    pub surface: String,
    #[serde(default = "theme_glass")]
    pub glass: String,
    #[serde(default = "theme_text")]
    pub text: String,
    #[serde(default = "theme_description")]
    pub description: String,
    #[serde(default = "theme_buttons")]
    pub buttons: String,
    #[serde(default = "theme_inputs")]
    pub inputs: String,
    #[serde(default = "theme_accent")]
    pub accent: String,
    #[serde(default = "theme_loading")]
    pub loading: String,
    #[serde(default = "theme_danger")]
    pub danger: String,
    #[serde(default = "default_true")]
    pub grid_overlay: bool,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u32,
    #[serde(default)]
    pub background_image: Option<String>,
}

fn theme_background() -> String { "#161616".into() }
fn theme_surface() -> String { "#1c1e20".into() }
fn theme_glass() -> String { "#ffffff".into() }
fn theme_text() -> String { "#e8e8e8".into() }
fn theme_description() -> String { "#7a7a7a".into() }
fn theme_buttons() -> String { "#999999".into() }
fn theme_inputs() -> String { "#bbbbbb".into() }
fn theme_accent() -> String { "#3bea57".into() }
fn theme_loading() -> String { "#ffffff".into() }
fn theme_danger() -> String { "#ec3b47".into() }

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: theme_background(),
            surface: theme_surface(),
            glass: theme_glass(),
            text: theme_text(),
            description: theme_description(),
            buttons: theme_buttons(),
            inputs: theme_inputs(),
            accent: theme_accent(),
            loading: theme_loading(),
            danger: theme_danger(),
            grid_overlay: true,
            ui_scale: default_ui_scale(),
            background_image: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile: Option<String>,

    /* ── Launch ── */
    #[serde(default = "default_true")]
    pub bootstrapper: bool,
    #[serde(default)]
    pub studio_bootstrapper: bool,
    /// Resolve versions straight from Roblox rather than through WEAO.
    #[serde(default)]
    pub use_roblox_cdn: bool,
    #[serde(default = "default_true")]
    pub multi_instance: bool,
    #[serde(default)]
    pub prompt_on_new_instance: bool,
    #[serde(default)]
    pub launch_delay_enabled: bool,
    #[serde(default = "default_launch_delay")]
    pub launch_delay_seconds: u32,
    #[serde(default = "default_true")]
    pub notify_on_launch: bool,
    /// Start the launcher with Windows. On by default, per request.
    #[serde(default = "default_true")]
    pub launch_on_startup: bool,
    /// Only meaningful while `launch_on_startup` is set.
    #[serde(default)]
    pub start_in_tray: bool,
    /// Whether to hold Roblox on a fixed release channel.
    #[serde(default = "default_true")]
    pub pin_channel: bool,
    #[serde(default = "default_channel")]
    pub pinned_channel: String,

    /* ── Roblox ── */
    #[serde(default)]
    pub fps_cap_enabled: bool,
    #[serde(default = "default_fps_cap")]
    pub fps_cap: u32,

    /* ── Advanced ── */
    #[serde(default = "default_true")]
    pub auto_check_updates: bool,

    #[serde(default)]
    pub theme: Theme,
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
            bootstrapper: true,
            studio_bootstrapper: false,
            use_roblox_cdn: false,
            multi_instance: true,
            prompt_on_new_instance: false,
            launch_delay_enabled: false,
            launch_delay_seconds: default_launch_delay(),
            notify_on_launch: true,
            launch_on_startup: true,
            start_in_tray: false,
            pin_channel: true,
            pinned_channel: default_channel(),
            fps_cap_enabled: false,
            fps_cap: default_fps_cap(),
            auto_check_updates: true,
            theme: Theme::default(),
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

    /// FFlags that come from settings rather than the user's own list. These are
    /// merged over the profile's flags when writing ClientAppSettings.json.
    pub fn derived_fflags(&self) -> Map<String, Value> {
        let mut flags = Map::new();
        if self.fps_cap_enabled {
            flags.insert(
                "DFIntTaskSchedulerTargetFps".to_string(),
                Value::String(self.fps_cap.to_string()),
            );
        }
        flags
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
