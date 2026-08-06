//! Talking to the Roblox client: release channel, FFlag overrides, launching,
//! and optionally taking over the `roblox-player` protocol handler.

use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::deploy::BinaryType;

/// Where the Roblox player reads its assigned release channel from. Roblox
/// prefers this key when it exists, which is what makes channel pinning work at
/// all — otherwise you get whatever channel the A/B service hands you.
#[cfg(windows)]
const CHANNEL_KEY: &str = r"SOFTWARE\ROBLOX Corporation\Environments\RobloxPlayer\Channel";
#[cfg(windows)]
const CHANNEL_VALUE: &str = "www.roblox.com";

#[cfg(windows)]
const STUDIO_CHANNEL_KEY: &str = r"SOFTWARE\ROBLOX Corporation\Environments\RobloxStudio\Channel";

#[cfg(windows)]
const PROTOCOL_KEY: &str = r"Software\Classes\roblox-player";

/// Read the channel Roblox is currently pinned to, if any.
#[cfg(windows)]
pub fn read_channel() -> Result<Option<String>> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(CHANNEL_KEY, KEY_READ) {
        Ok(key) => key,
        // No key means Roblox has never been pinned — that is not an error.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).context("opening the Roblox channel key"),
    };

    match key.get_value::<String, _>(CHANNEL_VALUE) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).context("reading the Roblox channel value"),
    }
}

#[cfg(not(windows))]
pub fn read_channel() -> Result<Option<String>> {
    Ok(None)
}

/// Pin Roblox to a channel. Passing `LIVE` is the "stop putting me in A/B
/// branches" button — those reroutes are what break executors mid-session.
#[cfg(windows)]
pub fn set_channel(channel: &str) -> Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for key_path in [CHANNEL_KEY, STUDIO_CHANNEL_KEY] {
        let (key, _) = hkcu
            .create_subkey(key_path)
            .with_context(|| format!("creating {key_path}"))?;
        key.set_value(CHANNEL_VALUE, &channel)
            .with_context(|| format!("writing the channel value under {key_path}"))?;
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn set_channel(_channel: &str) -> Result<()> {
    bail!("Channel pinning is only available on Windows")
}

/// Remove the pin and let Roblox pick its own channel again.
#[cfg(windows)]
pub fn clear_channel() -> Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for key_path in [CHANNEL_KEY, STUDIO_CHANNEL_KEY] {
        if let Ok(key) = hkcu.open_subkey_with_flags(key_path, KEY_ALL_ACCESS) {
            // Deleting a value that was never set is a no-op, not a failure.
            let _ = key.delete_value(CHANNEL_VALUE);
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn clear_channel() -> Result<()> {
    Ok(())
}

/// Roblox's own install directory, so we can report what the official
/// bootstrapper has put on disk alongside our managed builds.
pub fn official_versions_dir() -> Option<PathBuf> {
    let local = dirs::data_local_dir()?;
    let path = local.join("Roblox").join("Versions");
    path.is_dir().then_some(path)
}

/// Every Roblox build the official bootstrapper currently has installed.
pub fn official_installs() -> Vec<(String, PathBuf)> {
    let Some(root) = official_versions_dir() else {
        return Vec::new();
    };

    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut found: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            // Only directories that actually contain a client are interesting.
            let has_client = path.join(BinaryType::WindowsPlayer.executable()).is_file()
                || path.join(BinaryType::WindowsStudio64.executable()).is_file();
            has_client.then_some((name, path))
        })
        .collect();

    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// Write FFlag overrides into an install. Roblox reads this file on startup;
/// an empty map is written as `{}` rather than deleting the file so the
/// override stays visible and obviously ours.
pub fn write_fflags(install_dir: &Path, flags: &Map<String, Value>) -> Result<()> {
    let dir = install_dir.join("ClientSettings");
    std::fs::create_dir_all(&dir).context("creating ClientSettings")?;
    let json = serde_json::to_string_pretty(flags)?;
    std::fs::write(dir.join("ClientAppSettings.json"), json).context("writing ClientAppSettings.json")?;
    Ok(())
}

pub fn read_fflags(install_dir: &Path) -> Map<String, Value> {
    let path = install_dir.join("ClientSettings").join("ClientAppSettings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Map<String, Value>>(&text).ok())
        .unwrap_or_default()
}

/// Start a managed install.
///
/// `launch_arg` is the `roblox-player:` URI produced by the website's Play
/// button. Without one the client opens to its own home screen — it cannot
/// join a game on its own, because joining requires an authentication ticket
/// that only Roblox issues.
pub fn launch(install_dir: &Path, binary_type: BinaryType, launch_arg: Option<&str>) -> Result<u32> {
    let exe = install_dir.join(binary_type.executable());
    if !exe.is_file() {
        bail!(
            "{} is not installed in {} — install the build first",
            binary_type.executable(),
            install_dir.display()
        );
    }

    let mut command = std::process::Command::new(&exe);
    command.current_dir(install_dir);

    match launch_arg {
        Some(arg) if !arg.trim().is_empty() => {
            let arg = arg.trim();
            if !arg.starts_with("roblox-player:") && !arg.starts_with("roblox:") {
                bail!("Launch argument must be a roblox-player: or roblox: URI");
            }
            command.arg(arg);
        }
        _ => {
            command.arg("--app");
        }
    }

    let child = command
        .spawn()
        .with_context(|| format!("starting {}", exe.display()))?;

    Ok(child.id())
}

/// Register this launcher as the handler for `roblox-player:` links, so the
/// website's Play button routes through the pinned build. Fully reversible via
/// [`unregister_protocol`].
#[cfg(windows)]
pub fn register_protocol(exe: &Path) -> Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(PROTOCOL_KEY)?;
    key.set_value("", &"URL:Roblox Protocol")?;
    key.set_value("URL Protocol", &"")?;

    let (icon, _) = hkcu.create_subkey(format!(r"{PROTOCOL_KEY}\DefaultIcon"))?;
    icon.set_value("", &format!("{},0", exe.display()))?;

    let (command, _) = hkcu.create_subkey(format!(r"{PROTOCOL_KEY}\shell\open\command"))?;
    command.set_value("", &format!("\"{}\" \"%1\"", exe.display()))?;

    Ok(())
}

#[cfg(not(windows))]
pub fn register_protocol(_exe: &Path) -> Result<()> {
    bail!("Protocol registration is only available on Windows")
}

/// Hand `roblox-player:` links back to whatever handled them before. Removing
/// the HKCU key falls through to the machine-wide registration Roblox's own
/// installer created.
#[cfg(windows)]
pub fn unregister_protocol() -> Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.delete_subkey_all(PROTOCOL_KEY) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).context("removing the roblox-player protocol key"),
    }
}

#[cfg(not(windows))]
pub fn unregister_protocol() -> Result<()> {
    Ok(())
}

/// Whether *we* currently own the protocol handler.
#[cfg(windows)]
pub fn owns_protocol(exe: &Path) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(format!(r"{PROTOCOL_KEY}\shell\open\command"), KEY_READ)
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok())
        .map(|command| command.contains(&exe.display().to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn owns_protocol(_exe: &Path) -> bool {
    false
}
