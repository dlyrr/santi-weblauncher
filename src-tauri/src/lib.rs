//! santi.weblauncher — a Roblox bootstrapper that installs and launches the
//! exact build you choose.
//!
//! Inspired by SirMeme's ExploitStrap / MrExLiveChannelForcer, which is itself a
//! Bloxstrap fork. The deployment-fetching half is a Rust port of RDD by Latte
//! Softworks (see `deploy.rs`). The settings layout follows WEAO RDD Launcher.
//!
//! Deliberately not implemented: MAC address spoofing, MachineGuid
//! randomisation and cookie wiping. Those exist to evade account-level
//! enforcement rather than to launch a game, so they're out of scope here.

mod activity;
mod config;
mod deploy;
mod discord;
mod roblox;
mod servers;
mod weao;

use anyhow::Result;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use config::{Profile, Settings, Theme};
use deploy::{BinaryType, InstallProgress, VersionInfo};

/// The Discord application this launcher presents itself as.
pub(crate) const DISCORD_APP_ID: &str = "1534870843799375993";

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
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
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
struct ProtocolStatus {
    player_ours: bool,
    player_registered: bool,
    studio_ours: bool,
    studio_registered: bool,
}

#[derive(Serialize)]
struct Snapshot {
    settings: Settings,
    /// The channel Roblox itself is currently pinned to, if any.
    system_channel: Option<String>,
    protocol: ProtocolStatus,
    autostart: bool,
    official_installs: Vec<String>,
    data_dir: String,
    app_version: String,
}

/* ── State ──────────────────────────────────────────────────── */

#[tauri::command]
fn get_snapshot(app: AppHandle, state: State<AppState>) -> CommandResult<Snapshot> {
    let exe = std::env::current_exe().unwrap_or_default();
    let (player, studio) = roblox::protocol_state(&exe);

    Ok(Snapshot {
        settings: state.settings(),
        system_channel: roblox::read_channel().unwrap_or(None),
        protocol: ProtocolStatus {
            player_ours: player.0,
            player_registered: player.1,
            studio_ours: studio.0,
            studio_registered: studio.1,
        },
        autostart: roblox::autostart_enabled(),
        official_installs: roblox::official_installs()
            .into_iter()
            .map(|(name, _)| name)
            .collect(),
        data_dir: app
            .path()
            .app_data_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// Apply a whole settings object at once. Anything with a side effect outside
/// settings.json (autostart, channel pin, derived FFlags) is re-applied here so
/// the on-disk state can never drift from what the UI shows.
#[tauri::command]
fn apply_settings(state: State<AppState>, settings: Settings) -> CommandResult<Snapshot> {
    let previous = state.settings();

    if settings.pin_channel {
        roblox::set_channel(&settings.pinned_channel)?;
    } else if previous.pin_channel {
        roblox::clear_channel()?;
    }

    roblox::set_autostart(settings.launch_on_startup, settings.start_in_tray)?;

    // FPS cap and friends live in settings but land in ClientAppSettings.json,
    // so a change has to reach the installed build to take effect.
    let derived = settings.derived_fflags();
    for profile in &settings.profiles {
        if let Some(version) = &profile.installed_version {
            let dir = profile.install_dir(&state.root, version);
            if dir.is_dir() {
                let mut merged = profile.fflags.clone();
                for (key, value) in &derived {
                    merged.insert(key.clone(), value.clone());
                }
                roblox::write_fflags(&dir, &merged)?;
            }
        }
    }

    state.persist(settings)?;

    let exe = std::env::current_exe().unwrap_or_default();
    let (player, studio) = roblox::protocol_state(&exe);
    let current = state.settings();

    Ok(Snapshot {
        system_channel: roblox::read_channel().unwrap_or(None),
        protocol: ProtocolStatus {
            player_ours: player.0,
            player_registered: player.1,
            studio_ours: studio.0,
            studio_registered: studio.1,
        },
        autostart: roblox::autostart_enabled(),
        official_installs: roblox::official_installs().into_iter().map(|(n, _)| n).collect(),
        data_dir: state.root.display().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        settings: current,
    })
}

#[tauri::command]
fn reset_settings(state: State<AppState>) -> CommandResult<Settings> {
    let fresh = Settings::default();
    roblox::set_autostart(fresh.launch_on_startup, fresh.start_in_tray)?;
    state.persist(fresh.clone())?;
    Ok(fresh)
}

#[tauri::command]
fn set_theme(state: State<AppState>, theme: Theme) -> CommandResult<Settings> {
    let mut settings = state.settings();
    settings.theme = theme;
    state.persist(settings.clone())?;
    Ok(settings)
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
    settings.profiles.push(Profile::new(id.clone(), name, binary_type));
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
        .filter_map(std::result::Result::ok)
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

/// The build an executor targets, for the Exploit sync setting.
#[tauri::command]
async fn resolve_exploit_version(
    state: State<'_, AppState>,
    title: String,
) -> CommandResult<Option<String>> {
    let payload = weao::exploits(&state.http).await?;
    Ok(weao::target_version_for(&payload, &title))
}

/// Shared install path. Returns the version that ended up on disk.
async fn install_inner(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    version_override: Option<String>,
) -> Result<String> {
    let settings = state.settings();
    let Some(profile) = settings.profile(id).cloned() else {
        anyhow::bail!("No profile with id \"{id}\"");
    };

    // Priority: explicit override, then the profile's own pin, then an
    // exploit-sync target, then whatever is newest on the channel.
    let mut requested = version_override.or_else(|| profile.pinned_version.clone());

    if requested.is_none() {
        if let Some(title) = &profile.exploit_sync {
            if let Ok(payload) = weao::exploits(&state.http).await {
                requested = weao::target_version_for(&payload, title);
            }
        }
    }

    let version = match requested {
        Some(version) => deploy::normalize_version(&version),
        None => {
            let info = deploy::resolve_version(&state.http, profile.binary_type, &profile.channel).await?;
            deploy::normalize_version(&info.client_version_upload)
        }
    };

    let install_dir = profile.install_dir(&state.root, &version);

    let mut flags = profile.fflags.clone();
    for (key, value) in settings.derived_fflags() {
        flags.insert(key, value);
    }

    let already = deploy::is_installed(&install_dir, profile.binary_type);

    if !already {
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
    }

    if !flags.is_empty() {
        roblox::write_fflags(&install_dir, &flags)?;
    }

    let mut settings = state.settings();
    if let Some(entry) = settings.profile_mut(id) {
        entry.installed_version = Some(version.clone());
    }
    state.persist(settings)?;

    app.emit(
        "install-progress",
        InstallProgress {
            phase: "done".into(),
            message: if already {
                format!("{version} is already installed")
            } else {
                format!("Installed {version}")
            },
            completed: 1,
            total: 1,
            bytes: 0,
        },
    )
    .ok();

    Ok(version)
}

#[tauri::command]
async fn install_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    version_override: Option<String>,
) -> CommandResult<String> {
    Ok(install_inner(&app, &state, &id, version_override).await?)
}

/// Resolve the build a profile's synced executor needs, if it has one.
async fn synced_target(state: &AppState, profile: &Profile) -> Option<String> {
    let title = profile.exploit_sync.as_ref()?;
    let payload = weao::exploits(&state.http).await.ok()?;
    weao::target_version_for(&payload, title).map(|v| deploy::normalize_version(&v))
}

/// What a launch would do right now, without doing it.
#[derive(Serialize)]
struct LaunchPlan {
    needs_update: bool,
    installed: Option<String>,
    target: Option<String>,
    exploit: Option<String>,
}

#[tauri::command]
async fn launch_plan(state: State<'_, AppState>, id: String) -> CommandResult<LaunchPlan> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id).cloned() else {
        return Err(anyhow::anyhow!("No profile with id \"{id}\"").into());
    };

    let target = synced_target(&state, &profile).await;
    let installed = profile.installed_version.clone();

    Ok(LaunchPlan {
        needs_update: matches!((&target, &installed), (Some(t), i) if Some(t) != i.as_ref()),
        installed,
        target,
        exploit: profile.exploit_sync.clone(),
    })
}

/// The whole launch path: re-check the synced executor's build, install it if
/// the installed one no longer matches, then start Roblox.
#[tauri::command]
async fn launch_flow(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    launch_arg: Option<String>,
) -> CommandResult<u32> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id).cloned() else {
        return Err(anyhow::anyhow!("No profile with id \"{id}\"").into());
    };

    // An executor that has moved to a different Roblox build makes the installed
    // one useless, so re-check on every launch rather than only at sync time.
    if let Some(target) = synced_target(&state, &profile).await {
        if profile.installed_version.as_deref() != Some(target.as_str()) {
            app.emit(
                "install-progress",
                InstallProgress {
                    phase: "checking".into(),
                    message: format!(
                        "{} now needs {target} — updating",
                        profile.exploit_sync.clone().unwrap_or_default()
                    ),
                    completed: 0,
                    total: 0,
                    bytes: 0,
                },
            )
            .ok();

            install_inner(&app, &state, &id, Some(target)).await?;
        }
    }

    let settings = state.settings();
    let Some(profile) = settings.profile(&id).cloned() else {
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

    // Redirect the join to a chosen server, when the URI carries a place.
    let mut arg = launch_arg;
    if settings.server_mode != servers::ServerMode::Default {
        if let Some(uri) = arg.clone() {
            if let Some(place_id) = servers::place_id_from_uri(&uri) {
                let seed = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos() as u64)
                    .unwrap_or(0);

                match servers::pick(&state.http, &place_id, settings.server_mode, seed).await {
                    Ok(Some(job_id)) => arg = Some(servers::with_job_id(&uri, &job_id)),
                    // A server-list failure must not block the launch; Roblox
                    // picks for us instead.
                    Ok(None) => {}
                    Err(err) => eprintln!("server selection skipped: {err:#}"),
                }
            }
        }
    }

    if settings.launch_delay_enabled && settings.launch_delay_seconds > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(settings.launch_delay_seconds as u64)).await;
    }

    Ok(roblox::launch(&install_dir, profile.binary_type, arg.as_deref())?)
}

/* ── FFlags ─────────────────────────────────────────────────── */

#[tauri::command]
fn get_fflags(state: State<AppState>, id: String) -> CommandResult<Map<String, Value>> {
    let settings = state.settings();
    let Some(profile) = settings.profile(&id) else {
        return Ok(Map::new());
    };

    match &profile.installed_version {
        Some(version) => {
            let dir = profile.install_dir(&state.root, version);
            let on_disk = roblox::read_fflags(&dir);
            if on_disk.is_empty() { Ok(profile.fflags.clone()) } else { Ok(on_disk) }
        }
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

    let mut merged = fflags;
    for (key, value) in settings.derived_fflags() {
        merged.insert(key, value);
    }

    if let Some(version) = installed {
        let dir = profile.install_dir(&state.root, &version);
        if dir.is_dir() {
            roblox::write_fflags(&dir, &merged)?;
        }
    }

    state.persist(settings.clone())?;
    Ok(settings)
}

/* ── System integration ─────────────────────────────────────── */

#[tauri::command]
fn set_protocol_handler(enabled: bool, studio: bool) -> CommandResult<ProtocolStatus> {
    let exe = std::env::current_exe().map_err(anyhow::Error::from)?;

    if studio {
        if enabled { roblox::register_studio_protocol(&exe)?; } else { roblox::unregister_studio_protocol()?; }
    } else if enabled {
        roblox::register_protocol(&exe)?;
    } else {
        roblox::unregister_protocol()?;
    }

    let (player, studio_state) = roblox::protocol_state(&exe);
    Ok(ProtocolStatus {
        player_ours: player.0,
        player_registered: player.1,
        studio_ours: studio_state.0,
        studio_registered: studio_state.1,
    })
}

#[tauri::command]
fn open_path(app: AppHandle, which: String) -> CommandResult<String> {
    use tauri_plugin_opener::OpenerExt;

    let state = app.state::<AppState>();
    let target = match which.as_str() {
        "roblox" => roblox::roblox_root()
            .ok_or_else(|| anyhow::anyhow!("No Roblox installation found"))
            .map_err(CommandError::from)?,
        "versions" => state.root.join("profiles"),
        _ => state.root.clone(),
    };

    std::fs::create_dir_all(&target).ok();
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| CommandError(err.to_string()))?;

    Ok(target.display().to_string())
}

/* ── Window / tray ──────────────────────────────────────────── */

/// Read a small text file the user picked in a dialog. Going through a command
/// keeps the filesystem capability off the webview — the only readable paths are
/// ones the user explicitly chose.
#[tauri::command]
fn read_text_file(path: String) -> CommandResult<String> {
    const MAX: u64 = 4 * 1024 * 1024;

    let meta = std::fs::metadata(&path).map_err(anyhow::Error::from)?;
    if meta.len() > MAX {
        return Err(anyhow::anyhow!("That file is larger than 4 MB").into());
    }

    Ok(std::fs::read_to_string(&path).map_err(anyhow::Error::from)?)
}

/// Inline an image as a data URL, so a themed background needs no asset
/// protocol and no filesystem scope.
#[tauri::command]
fn read_image_data_url(path: String) -> CommandResult<String> {
    const MAX: u64 = 12 * 1024 * 1024;

    let meta = std::fs::metadata(&path).map_err(anyhow::Error::from)?;
    if meta.len() > MAX {
        return Err(anyhow::anyhow!("Background images must be under 12 MB").into());
    }

    let bytes = std::fs::read(&path).map_err(anyhow::Error::from)?;
    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        other => return Err(anyhow::anyhow!("Unsupported image type \".{other}\"").into()),
    };

    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Minimal base64 encoder — not worth a dependency for one call site.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;

        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }

    out
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Where the launcher publishes its update manifest, shown in Advanced.
#[tauri::command]
fn update_feed() -> String {
    "https://rdd.xocat.online/weblauncher/latest.json".to_string()
}

/* ── WEAO ───────────────────────────────────────────────────── */

#[tauri::command]
async fn weao_versions(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(weao::current_versions(&state.http).await?)
}

#[tauri::command]
async fn weao_exploits(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(weao::exploits(&state.http).await?)
}


/* ── Activity watcher + Discord presence ────────────────────── */

/// Polls Roblox's logs and mirrors the current game onto Discord.
///
/// Runs for the app's lifetime. Everything it touches is read from settings on
/// each tick, so toggling the watcher or presence takes effect immediately
/// without restarting anything.
fn spawn_activity_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut watcher = activity::LogWatcher::new();
        let mut rpc = discord::DiscordIpc::new(DISCORD_APP_ID);
        let mut described: Option<String> = None;
        let mut ticks: u64 = 0;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            ticks += 1;

            let (watch, presence, buttons) = {
                let state = app.state::<AppState>();
                let settings = state.settings();
                (settings.activity_watcher, settings.discord_rpc, settings.show_join_buttons)
            };

            if !watch {
                if rpc.is_connected() {
                    rpc.disconnect();
                }
                if watcher.session.is_some() {
                    watcher.session = None;
                    app.emit("activity", Value::Null).ok();
                }
                continue;
            }

            let changed = watcher.poll();

            // Enrich a newly seen session once, not on every tick.
            if let Some(session) = watcher.session.clone() {
                if described.as_deref() != Some(session.job_id.as_str()) {
                    let mut enriched = session.clone();
                    let state = app.state::<AppState>();
                    let client = state.http.clone();
                    drop(state);

                    if activity::describe(&client, &mut enriched).await.is_ok() {
                        described = Some(enriched.job_id.clone());
                        watcher.session = Some(enriched.clone());
                        app.emit("activity", &enriched).ok();
                    }
                } else if changed {
                    app.emit("activity", &session).ok();
                }
            } else if changed {
                described = None;
                app.emit("activity", Value::Null).ok();
            }

            // Discord's pipe is blocking, so every interaction with it runs on
            // the blocking pool. Doing it inline would park a runtime worker for
            // the length of each round trip.
            let target = match watcher.session.clone() {
                Some(session) if watcher.connected && presence => {
                    let mut activity = discord::Activity {
                        details: Some(session.name.clone().unwrap_or_else(|| "Playing Roblox".into())),
                        state: session.creator.clone().map(|c| format!("by {c}")),
                        large_image: session.icon.clone(),
                        large_text: session.name.clone(),
                        small_image: None,
                        small_text: Some("santi.weblauncher".into()),
                        start: Some(session.started),
                        buttons: Vec::new(),
                    };
                    if buttons {
                        activity.buttons.push(("See game page".into(), session.place_url()));
                    }
                    Some(activity)
                }
                _ => None,
            };

            let should_connect = presence && !rpc.is_connected() && ticks % 5 == 0;
            let should_ping = presence && target.is_none() && ticks % 15 == 0;

            let mut client = rpc;
            client = tokio::task::spawn_blocking(move || {
                if !presence {
                    if client.is_connected() {
                        let _ = client.clear_activity();
                        client.disconnect();
                    }
                    return client;
                }

                // Retrying every tick would hammer the pipe while Discord is
                // closed, so reconnects are attempted every ~10s.
                if should_connect {
                    if let Err(err) = client.connect() {
                        eprintln!("discord: {err:#}");
                    }
                }

                if !client.is_connected() {
                    return client;
                }

                match target {
                    Some(activity) => { let _ = client.set_activity(&activity); }
                    None => {
                        let _ = client.clear_activity();
                        if should_ping {
                            let _ = client.ping();
                        }
                    }
                }

                client
            })
            .await
            .unwrap_or_else(|_| discord::DiscordIpc::new(DISCORD_APP_ID));

            rpc = client;
        }
    });
}

/* ── Entry point ────────────────────────────────────────────── */

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started by the Windows Run entry with --tray: come up hidden.
    let started_in_tray = std::env::args().any(|arg| arg == roblox::TRAY_ARG);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
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

            // Keep the Run entry in step with the saved preference, in case it
            // was removed outside the app.
            if let Err(err) = roblox::set_autostart(settings.launch_on_startup, settings.start_in_tray) {
                eprintln!("could not update the autostart entry: {err:#}");
            }

            let hide_now = started_in_tray && settings.start_in_tray;

            let http = reqwest::Client::builder()
                .user_agent(concat!("santi.weblauncher/", env!("CARGO_PKG_VERSION")))
                .build()?;

            app.manage(AppState {
                root,
                settings: Mutex::new(settings),
                http,
            });

            /* Tray icon: closing the window hides to here rather than exiting. */
            let show = MenuItem::with_id(app, "show", "Open santi.weblauncher", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("santi.weblauncher")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click restores, which is what people expect from a
                    // tray app; right click still opens the menu.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                if hide_now {
                    let _ = window.hide();
                }
            }

            spawn_activity_watcher(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // X hides to the tray instead of quitting. Quit is on the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            apply_settings,
            reset_settings,
            set_theme,
            create_profile,
            update_profile,
            delete_profile,
            set_active_profile,
            list_installs,
            delete_install,
            resolve_latest,
            resolve_exploit_version,
            install_profile,
            launch_plan,
            launch_flow,
            get_fflags,
            set_fflags,
            set_protocol_handler,
            open_path,
            read_text_file,
            read_image_data_url,
            hide_to_tray,
            quit_app,
            update_feed,
            weao_versions,
            weao_exploits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running santi.weblauncher");
}
