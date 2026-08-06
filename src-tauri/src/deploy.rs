//! Roblox deployment fetching and installation.
//!
//! The binary type table, CDN blob directories and the package-to-directory
//! extraction roots below are taken from RDD (Roblox Deployment Downloader) by
//! Latte Softworks — <https://github.com/latte-soft/rdd>, MIT licensed,
//! Copyright (C) 2024-2026 Latte Softworks. Without that table the ~21 (Player)
//! or ~34 (Studio) loose package zips do not assemble into a working install.

use anyhow::{bail, Context, Result};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Only the AWS mirror is configured with usable CORS/range support.
pub const HOST: &str = "https://setup-aws.rbxcdn.com";
const CLIENT_SETTINGS: &str = "https://clientsettings.roblox.com/v2/client-version";

/// Roblox serves packages happily in parallel, but going wider than this mostly
/// buys connection churn and makes progress reporting jumpy.
const MAX_CONCURRENT: usize = 6;

const APP_SETTINGS_XML: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
    "<Settings>\n",
    "\t<ContentFolder>content</ContentFolder>\n",
    "\t<BaseUrl>http://www.roblox.com</BaseUrl>\n",
    "</Settings>\n"
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryType {
    WindowsPlayer,
    WindowsStudio64,
}

impl BinaryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BinaryType::WindowsPlayer => "WindowsPlayer",
            BinaryType::WindowsStudio64 => "WindowsStudio64",
        }
    }

    pub fn executable(&self) -> &'static str {
        match self {
            BinaryType::WindowsPlayer => "RobloxPlayerBeta.exe",
            BinaryType::WindowsStudio64 => "RobloxStudioBeta.exe",
        }
    }

    /// The package that identifies which kind of deployment a manifest describes.
    fn marker(&self) -> &'static str {
        match self {
            BinaryType::WindowsPlayer => "RobloxApp.zip",
            BinaryType::WindowsStudio64 => "RobloxStudio.zip",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub version: String,
    #[serde(rename = "clientVersionUpload")]
    pub client_version_upload: String,
    #[serde(rename = "bootstrapperVersion", default)]
    pub bootstrapper_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub phase: String,
    pub message: String,
    pub completed: usize,
    pub total: usize,
    pub bytes: u64,
}

/// `LIVE` lives at the CDN root; every other channel is namespaced.
pub fn channel_path(channel: &str) -> String {
    if channel.eq_ignore_ascii_case("live") {
        HOST.to_string()
    } else {
        format!("{HOST}/channel/{}", channel.to_lowercase())
    }
}

pub fn normalize_channel(channel: &str) -> String {
    let trimmed = channel.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("live") {
        "LIVE".to_string()
    } else {
        trimmed.to_lowercase()
    }
}

pub fn normalize_version(version: &str) -> String {
    let lowered = version.trim().to_lowercase();
    if lowered.starts_with("version-") {
        lowered
    } else {
        format!("version-{lowered}")
    }
}

/// Ask Roblox which build is current for a channel.
pub async fn resolve_version(
    client: &reqwest::Client,
    binary_type: BinaryType,
    channel: &str,
) -> Result<VersionInfo> {
    let channel = normalize_channel(channel);
    let url = format!("{CLIENT_SETTINGS}/{}/channel/{}", binary_type.as_str(), channel);

    let response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("requesting {url}"))?;

    if !response.status().is_success() {
        bail!(
            "Roblox returned {} for channel \"{}\" — does that channel exist?",
            response.status(),
            channel
        );
    }

    response.json::<VersionInfo>().await.context("parsing client-version response")
}

/// Package name -> directory it unpacks into, relative to the install root.
fn extract_roots(binary_type: BinaryType) -> HashMap<&'static str, &'static str> {
    let pairs: &[(&str, &str)] = match binary_type {
        BinaryType::WindowsPlayer => &[
            ("RobloxApp.zip", ""),
            ("redist.zip", ""),
            ("shaders.zip", "shaders/"),
            ("ssl.zip", "ssl/"),
            ("WebView2.zip", ""),
            ("WebView2RuntimeInstaller.zip", "WebView2RuntimeInstaller/"),
            ("content-avatar.zip", "content/avatar/"),
            ("content-configs.zip", "content/configs/"),
            ("content-fonts.zip", "content/fonts/"),
            ("content-sky.zip", "content/sky/"),
            ("content-sounds.zip", "content/sounds/"),
            ("content-textures2.zip", "content/textures/"),
            ("content-models.zip", "content/models/"),
            ("content-platform-fonts.zip", "PlatformContent/pc/fonts/"),
            ("content-platform-dictionaries.zip", "PlatformContent/pc/shared_compression_dictionaries/"),
            ("content-terrain.zip", "PlatformContent/pc/terrain/"),
            ("content-textures3.zip", "PlatformContent/pc/textures/"),
            ("extracontent-luapackages.zip", "ExtraContent/LuaPackages/"),
            ("extracontent-translations.zip", "ExtraContent/translations/"),
            ("extracontent-models.zip", "ExtraContent/models/"),
            ("extracontent-textures.zip", "ExtraContent/textures/"),
            ("extracontent-places.zip", "ExtraContent/places/"),
        ],
        BinaryType::WindowsStudio64 => &[
            ("RobloxStudio.zip", ""),
            ("RibbonConfig.zip", "RibbonConfig/"),
            ("redist.zip", ""),
            ("Libraries.zip", ""),
            ("LibrariesQt5.zip", ""),
            ("WebView2.zip", ""),
            ("WebView2RuntimeInstaller.zip", ""),
            ("shaders.zip", "shaders/"),
            ("ssl.zip", "ssl/"),
            ("Qml.zip", "Qml/"),
            ("Plugins.zip", "Plugins/"),
            ("StudioFonts.zip", "StudioFonts/"),
            ("BuiltInPlugins.zip", "BuiltInPlugins/"),
            ("ApplicationConfig.zip", "ApplicationConfig/"),
            ("BuiltInStandalonePlugins.zip", "BuiltInStandalonePlugins/"),
            ("content-qt_translations.zip", "content/qt_translations/"),
            ("content-sky.zip", "content/sky/"),
            ("content-fonts.zip", "content/fonts/"),
            ("content-avatar.zip", "content/avatar/"),
            ("content-models.zip", "content/models/"),
            ("content-sounds.zip", "content/sounds/"),
            ("content-configs.zip", "content/configs/"),
            ("content-api-docs.zip", "content/api_docs/"),
            ("content-textures2.zip", "content/textures/"),
            ("content-studio_svg_textures.zip", "content/studio_svg_textures/"),
            ("content-platform-fonts.zip", "PlatformContent/pc/fonts/"),
            ("content-platform-dictionaries.zip", "PlatformContent/pc/shared_compression_dictionaries/"),
            ("content-terrain.zip", "PlatformContent/pc/terrain/"),
            ("content-textures3.zip", "PlatformContent/pc/textures/"),
            ("extracontent-translations.zip", "ExtraContent/translations/"),
            ("extracontent-luapackages.zip", "ExtraContent/LuaPackages/"),
            ("extracontent-textures.zip", "ExtraContent/textures/"),
            ("extracontent-scripts.zip", "ExtraContent/scripts/"),
            ("extracontent-models.zip", "ExtraContent/models/"),
            ("studiocontent-models.zip", "StudioContent/models/"),
            ("studiocontent-textures.zip", "StudioContent/textures/"),
        ],
    };

    pairs.iter().copied().collect()
}

/// Reject absolute paths, drive letters and `..` before writing anything from a
/// downloaded archive — a malformed package must not be able to escape the
/// install directory.
fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let normalized = relative.replace('\\', "/");
    let candidate = Path::new(&normalized);

    if candidate.is_absolute() {
        return None;
    }

    let mut out = root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }

    Some(out)
}

async fn fetch_manifest(
    client: &reqwest::Client,
    channel: &str,
    version: &str,
) -> Result<(String, String)> {
    let mut base = format!("{}/{}-", channel_path(channel), version);
    let mut response = client.get(format!("{base}rbxPkgManifest.txt")).send().await?;

    // Some channels only publish under /channel/common/.
    if !response.status().is_success() {
        base = format!("{HOST}/channel/common/{version}-");
        response = client.get(format!("{base}rbxPkgManifest.txt")).send().await?;
    }

    if !response.status().is_success() {
        bail!(
            "No package manifest for {} on channel \"{}\" ({})",
            version,
            channel,
            response.status()
        );
    }

    Ok((base, response.text().await?))
}

/// Download every package in a deployment and unpack it into `install_dir`.
pub async fn install<F>(
    client: reqwest::Client,
    binary_type: BinaryType,
    channel: &str,
    version: &str,
    install_dir: &Path,
    on_progress: F,
) -> Result<()>
where
    F: Fn(InstallProgress) + Send + Sync + 'static,
{
    let channel = normalize_channel(channel);
    let version = normalize_version(version);
    let on_progress = Arc::new(on_progress);

    on_progress(InstallProgress {
        phase: "manifest".into(),
        message: format!("Fetching package manifest for {version}"),
        completed: 0,
        total: 0,
        bytes: 0,
    });

    let (base, manifest) = fetch_manifest(&client, &channel, &version).await?;
    let lines: Vec<&str> = manifest.lines().map(str::trim).collect();

    match lines.first() {
        Some(&"v0") => {}
        Some(other) => bail!("Unknown manifest format \"{other}\" — expected \"v0\""),
        None => bail!("Package manifest was empty"),
    }

    if !lines.contains(&binary_type.marker()) {
        bail!(
            "Manifest does not contain {} — this deployment is not a {}",
            binary_type.marker(),
            binary_type.as_str()
        );
    }

    let roots = extract_roots(binary_type);
    let packages: Vec<String> = lines
        .iter()
        .filter(|line| line.ends_with(".zip"))
        .map(|line| line.to_string())
        .collect();

    // Install into a staging directory so an interrupted install never leaves a
    // half-populated directory that looks complete.
    let staging = install_dir.with_extension("partial");
    if staging.exists() {
        tokio::fs::remove_dir_all(&staging).await.ok();
    }
    tokio::fs::create_dir_all(&staging).await?;

    let total = packages.len();
    let completed = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));

    on_progress(InstallProgress {
        phase: "downloading".into(),
        message: format!("Downloading {total} packages"),
        completed: 0,
        total,
        bytes: 0,
    });

    let results = stream::iter(packages.into_iter().map(|package| {
        let client = client.clone();
        let base = base.clone();
        let staging = staging.clone();
        let root = roots.get(package.as_str()).copied().map(str::to_string);
        let completed = Arc::clone(&completed);
        let bytes = Arc::clone(&bytes);
        let on_progress = Arc::clone(&on_progress);

        async move {
            let url = format!("{base}{package}");
            let response = client.get(&url).send().await.with_context(|| format!("GET {url}"))?;
            if !response.status().is_success() {
                bail!("{} returned {}", package, response.status());
            }

            let data = response.bytes().await?;
            let size = data.len() as u64;
            bytes.fetch_add(size, Ordering::Relaxed);

            let Some(root) = root else {
                bail!(
                    "Package \"{}\" has no known extraction root for {} — refusing to produce a broken install",
                    package,
                    binary_type.as_str()
                );
            };

            // Unzipping is CPU- and IO-bound and the zip crate is synchronous,
            // so it goes on the blocking pool rather than stalling the runtime.
            let package_for_task = package.clone();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let mut archive = zip::ZipArchive::new(Cursor::new(data))
                    .with_context(|| format!("opening {package_for_task}"))?;

                for index in 0..archive.len() {
                    let mut entry = archive.by_index(index)?;
                    let raw_name = entry.name().to_string();

                    // Roblox packages use backslash separators; directory entries
                    // end in one and carry no data.
                    if entry.is_dir() || raw_name.ends_with('\\') || raw_name.ends_with('/') {
                        continue;
                    }

                    let relative = format!("{root}{}", raw_name.replace('\\', "/"));
                    let Some(target) = safe_join(&staging, &relative) else {
                        bail!("Unsafe path \"{relative}\" in {package_for_task}");
                    };

                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent)?;
                    }

                    let mut buffer = Vec::with_capacity(entry.size() as usize);
                    entry.read_to_end(&mut buffer)?;
                    std::fs::write(&target, buffer)?;
                }

                Ok(())
            })
            .await??;

            let done = completed.fetch_add(1, Ordering::Relaxed) as usize + 1;
            on_progress(InstallProgress {
                phase: "downloading".into(),
                message: format!("Unpacked {package}"),
                completed: done,
                total,
                bytes: bytes.load(Ordering::Relaxed),
            });

            Ok(())
        }
    }))
    .buffer_unordered(MAX_CONCURRENT)
    .collect::<Vec<Result<()>>>()
    .await;

    for result in results {
        if let Err(err) = result {
            tokio::fs::remove_dir_all(&staging).await.ok();
            return Err(err);
        }
    }

    // Roblox refuses to start without this file.
    tokio::fs::write(staging.join("AppSettings.xml"), APP_SETTINGS_XML).await?;

    on_progress(InstallProgress {
        phase: "finalising".into(),
        message: "Finalising install".into(),
        completed: total,
        total,
        bytes: bytes.load(Ordering::Relaxed),
    });

    if install_dir.exists() {
        tokio::fs::remove_dir_all(install_dir).await.ok();
    }
    if let Some(parent) = install_dir.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(&staging, install_dir).await?;

    on_progress(InstallProgress {
        phase: "done".into(),
        message: format!("Installed {version}"),
        completed: total,
        total,
        bytes: bytes.load(Ordering::Relaxed),
    });

    Ok(())
}

/// An install is only usable if the executable actually landed.
pub fn is_installed(install_dir: &Path, binary_type: BinaryType) -> bool {
    install_dir.join(binary_type.executable()).is_file()
}
