//! santi.weblauncher — a Roblox bootstrapper that installs and launches the
//! exact build you choose.
//!
//! Inspired by SirMeme's ExploitStrap / MrExLiveChannelForcer, which is itself a
//! Bloxstrap fork. The deployment-fetching half is a Rust port of RDD by Latte
//! Softworks (see `deploy.rs`). The UI is original.
//!
//! Deliberately not implemented: MAC address spoofing, MachineGuid
//! randomisation and cookie wiping. Those exist to evade account-level
//! enforcement rather than to launch a game, so they're out of scope here.

mod config;
mod deploy;
mod roblox;
mod weao;

use anyhow::Result;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use config::{Profile, Settings};
use deploy::{BinaryType, InstallProgress, VersionInfo};

/// Tauri commands must return a serialisable error, so anyhow gets flattened to
/// its full context chain — losing the causes makes install failures unreadable.
struct CommandError(String);

impl From<anyhow::Error> for CommandError {
    fn from(err: anyhow::Error) -> Self {
        let mut message = err.to_string();
        for cause in err.chain().skip(1) {
            message.push_str(&format!(" — {cause}"));
        }
        CommandError(message)
    }
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

type CommandResult<T> = std::result::Result<T, CommandError>;

struct AppState {
    root: PathBuf,
    settings: Mutex<Settings>,
    http: reqwest::Client,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().expect("settings lock poisoned").clone()
    }

    fn persist(&self, settings: Settings) -> Result<()> {
        config::save(&self.root, &settings)?;
        *self.settings.lock().expect("settings lock poisoned") = settings;
        Ok(())
    }
}

#[derive(Serialize)]
struct InstalledBuild {
    version: String,
    path: String,
    complete: bool,
}

#[derive(Serialize)]
struct Snapshot {
    settings: Settings,
    /// The channel Roblox itself is currently pinned to, if any.
    system_channel: Option<String>,
    owns_protocol: bool,
    official_installs: Vec<String>,
    data_dir: String,
}

/* ── State ──────────────────────────────────────────────────── */

#[tauri::command]
fn get_snapshot(app: AppHandle, state: State<AppState>) -> CommandResult<Snapshot> {
    let exe = std::env::current_exe().unwrap_or_default();
    Ok(Snapshot {
        settings: state.settings(),
        system_channel: roblox::read_channel().unwrap_or(None),
        owns_protocol: roblox::owns_protocol(&exe),
        official_installs: roblox::official_installs()
            .into_iter()
            .map(|(name, _)| name)
            .collect(),
        data_dir: app
            .path()
            .app_data_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    })
}

/* ── Profiles ───────────────────────────────────────────────── */

#[tauri::command]
fn create_profile(
    state: State<AppState>,
    name: String,
    binary_type: BinaryType,
) -> CommandResult<Settings> {
    let mut settings = state.settings();
    let id = settings.next_id(&name);
    let profile = Profile::new(id.clone(), name, binary_type);

    settings.profiles.push(profile);
    settings.active_profile = Some(id);
    state.persist(settings.clone())?;

    Ok(settings)
}

#[tauri::command]
fn update_profile(state: State<AppState>, profile: Profile) -> CommandResult<Settings> {
    let mut settings = state.settings();

    if let Some(existing) = settings.profile_mut(&profile.id) {
        // installed_version is owned by the installer, not the UI — keeping the
        // client's copy here would let a stale form wipe it.
        let installed = existing.installed_version.clone();
        *existing = profile;
        existing.installed_version = installed;
    }

    state.persist(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
fn delete_profile(state: State<AppState>, id: String) -> CommandResult<Settings> {
    let mut settings = state.settings();
    settings.profiles.retain(|profile| profile.id != id);

    if settings.profiles.is_empty() {
        settings.profiles.push(Profile::new(
            "default".to_string(),
            "Default".to_string(),
            BinaryType::WindowsPlayer,
        ));
    }

    if settings.active_profile.as_deref() == Some(id.as_str()) {
        settings.active_profile = settings.profiles.first().map(|profile| profile.id.clone());
    }

    // Reclaim the disk this profile was using.
    let dir = state.root.join("profiles").join(&id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).ok();
    }

    state.persist(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
fn set_active_profile(state: State<AppState>, id: String) -> CommandResult<Settings> {
    let mut settings = state.settings();
    if settings.profile(&id).is_some() {
        settings.active_profile = Some(id);
        state.persist(settings.clone())?;
    }
    Ok(settings)
}

/// Every build currently on disk for a profile, newest-first by name.
#[tauri::command]
fn list_installs(state: State<AppState>, id: String) -> CommandResult<Vec<InstalledBuild>> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id) else {
        return Ok(Vec::new());
    };

    let dir = state.root.join("profiles").join(&profile.id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut builds: Vec<InstalledBuild> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let path = entry.path();
            let version = path.file_name()?.to_string_lossy().to_string();
            // Skip staging directories from interrupted installs.
            if version.ends_with(".partial") {
                return None;
            }
            Some(InstalledBuild {
                complete: deploy::is_installed(&path, profile.binary_type),
                version,
                path: path.display().to_string(),
            })
        })
        .collect();

    builds.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(builds)
}

#[tauri::command]
fn delete_install(state: State<AppState>, id: String, version: String) -> CommandResult<()> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id) else {
        return Ok(());
    };

    let dir = profile.install_dir(&state.root, &deploy::normalize_version(&version));
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(anyhow::Error::from)?;
    }

    Ok(())
}

/* ── Versions and installing ────────────────────────────────── */

#[tauri::command]
async fn resolve_latest(
    state: State<'_, AppState>,
    binary_type: BinaryType,
    channel: String,
) -> CommandResult<VersionInfo> {
    Ok(deploy::resolve_version(&state.http, binary_type, &channel).await?)
}

#[tauri::command]
async fn install_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    // Overrides the profile's own pin, for one-click "install what this
    // executor targets" from the executor list.
    version_override: Option<String>,
) -> CommandResult<String> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id).cloned() else {
        return Err(anyhow::anyhow!("No profile with id \"{id}\"").into());
    };

    let requested = version_override.or_else(|| profile.pinned_version.clone());

    let version = match requested {
        Some(version) => deploy::normalize_version(&version),
        None => {
            let info = deploy::resolve_version(&state.http, profile.binary_type, &profile.channel).await?;
            deploy::normalize_version(&info.client_version_upload)
        }
    };

    let install_dir = profile.install_dir(&state.root, &version);

    // Already on disk and complete — nothing to download.
    if deploy::is_installed(&install_dir, profile.binary_type) {
        let mut settings = state.settings();
        if let Some(entry) = settings.profile_mut(&id) {
            entry.installed_version = Some(version.clone());
        }
        state.persist(settings)?;

        app.emit(
            "install-progress",
            InstallProgress {
                phase: "done".into(),
                message: format!("{version} is already installed"),
                completed: 1,
                total: 1,
                bytes: 0,
            },
        )
        .ok();

        return Ok(version);
    }

    let emitter = app.clone();
    deploy::install(
        state.http.clone(),
        profile.binary_type,
        &profile.channel,
        &version,
        &install_dir,
        move |progress| {
            emitter.emit("install-progress", progress).ok();
        },
    )
    .await?;

    // Re-apply the profile's FFlags — a fresh install has none.
    if !profile.fflags.is_empty() {
        roblox::write_fflags(&install_dir, &profile.fflags)?;
    }

    let mut settings = state.settings();
    if let Some(entry) = settings.profile_mut(&id) {
        entry.installed_version = Some(version.clone());
    }
    state.persist(settings)?;

    Ok(version)
}

#[tauri::command]
fn launch_profile(
    state: State<AppState>,
    id: String,
    launch_arg: Option<String>,
) -> CommandResult<u32> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id) else {
        return Err(anyhow::anyhow!("No profile with id \"{id}\"").into());
    };

    let Some(version) = profile.installed_version.clone() else {
        return Err(anyhow::anyhow!("This profile has no installed build yet").into());
    };

    let install_dir = profile.install_dir(&state.root, &version);

    // Pin the channel right before launching, so a Roblox update or another
    // bootstrapper can't have quietly moved it since the last launch.
    if settings.pin_channel {
        roblox::set_channel(&settings.pinned_channel)?;
    }

    Ok(roblox::launch(&install_dir, profile.binary_type, launch_arg.as_deref())?)
}

/* ── FFlags ─────────────────────────────────────────────────── */

/// Read the FFlags that are actually on disk for a profile's current install,
/// which is the only way to confirm a write landed where Roblox will read it.
#[tauri::command]
fn get_fflags(state: State<AppState>, id: String) -> CommandResult<Map<String, Value>> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id) else {
        return Ok(Map::new());
    };

    match &profile.installed_version {
        Some(version) => {
            let dir = profile.install_dir(&state.root, version);
            Ok(roblox::read_fflags(&dir))
        }
        // Nothing installed yet, so the profile's own copy is all there is.
        None => Ok(profile.fflags.clone()),
    }
}

#[tauri::command]
fn set_fflags(
    state: State<AppState>,
    id: String,
    fflags: Map<String, Value>,
) -> CommandResult<Settings> {
    let mut settings = state.settings();

    let Some(profile) = settings.profile_mut(&id) else {
        return Err(anyhow::anyhow!("No profile with id \"{id}\"").into());
    };

    profile.fflags = fflags.clone();
    let installed = profile.installed_version.clone();
    let profile = profile.clone();

    // Write straight through to the install so the change takes effect on the
    // next launch rather than the next reinstall.
    if let Some(version) = installed {
        let dir = profile.install_dir(&state.root, &version);
        if dir.is_dir() {
            roblox::write_fflags(&dir, &fflags)?;
        }
    }

    state.persist(settings.clone())?;
    Ok(settings)
}

/* ── System integration ─────────────────────────────────────── */

#[tauri::command]
fn set_channel_pin(state: State<AppState>, enabled: bool, channel: String) -> CommandResult<Settings> {
    let mut settings = state.settings();
    settings.pin_channel = enabled;
    settings.pinned_channel = deploy::normalize_channel(&channel);

    if enabled {
        roblox::set_channel(&settings.pinned_channel)?;
    } else {
        roblox::clear_channel()?;
    }

    state.persist(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
fn set_protocol_handler(enabled: bool) -> CommandResult<bool> {
    let exe = std::env::current_exe().map_err(anyhow::Error::from)?;

    if enabled {
        roblox::register_protocol(&exe)?;
    } else {
        roblox::unregister_protocol()?;
    }

    Ok(roblox::owns_protocol(&exe))
}

/* ── WEAO ───────────────────────────────────────────────────── */

#[tauri::command]
async fn weao_versions(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(weao::current_versions(&state.http).await?)
}

#[tauri::command]
async fn weao_version_history(state: State<'_, AppState>) -> CommandResult<Value> {
    // Future and past are independently useful; one failing shouldn't blank both.
    let future = weao::future_versions(&state.http).await.unwrap_or(Value::Null);
    let past = weao::past_versions(&state.http).await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "future": future, "past": past }))
}

#[tauri::command]
async fn weao_exploits(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(weao::exploits(&state.http).await?)
}

/* ── Entry point ────────────────────────────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root).ok();

            let settings = config::load(&root);

            // Re-assert the channel pin on startup: Roblox's own updater resets
            // it, which is exactly the "my executor broke after an update" case.
            if settings.pin_channel {
                if let Err(err) = roblox::set_channel(&settings.pinned_channel) {
                    eprintln!("could not pin the Roblox channel: {err:#}");
                }
            }

            let http = reqwest::Client::builder()
                .user_agent(concat!("santi.weblauncher/", env!("CARGO_PKG_VERSION")))
                .build()?;

            app.manage(AppState {
                root,
                settings: Mutex::new(settings),
                http,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            create_profile,
            update_profile,
            delete_profile,
            set_active_profile,
            list_installs,
            delete_install,
            resolve_latest,
            install_profile,
            launch_profile,
            get_fflags,
            set_fflags,
            set_channel_pin,
            set_protocol_handler,
            weao_versions,
            weao_version_history,
            weao_exploits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running santi.weblauncher");
}
