//! Choosing which server a launch lands in.
//!
//! Roblox's public server list reports a `ping` per server, so "join the closest
//! one" is a real sort rather than a guess. Once a server is chosen, the
//! `roblox-player:` URI's embedded PlaceLauncher URL is rewritten from
//! `request=RequestGame` (Roblox picks) to `request=RequestGameJob&gameId=<jobId>`
//! (join this exact server).

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServerMode {
    /// Leave the choice to Roblox.
    #[default]
    Default,
    /// Lowest reported ping.
    Closest,
    /// Uniformly random among joinable servers.
    Random,
}

#[derive(Debug, Deserialize)]
struct ServerEntry {
    id: String,
    #[serde(rename = "maxPlayers")]
    max_players: u32,
    playing: u32,
    #[serde(default)]
    ping: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ServerPage {
    data: Vec<ServerEntry>,
    #[serde(rename = "nextPageCursor")]
    next_cursor: Option<String>,
}

/// Pick a server for a place. Returns `None` when the mode is Default or there
/// is nothing joinable, in which case the launch is left untouched.
pub async fn pick(
    client: &reqwest::Client,
    place_id: &str,
    mode: ServerMode,
    seed: u64,
) -> Result<Option<String>> {
    if mode == ServerMode::Default {
        return Ok(None);
    }

    let mut candidates: Vec<ServerEntry> = Vec::new();
    let mut cursor: Option<String> = None;

    // Two pages is plenty to choose from without making launching feel slow.
    for _ in 0..2 {
        let mut url = format!(
            "https://games.roblox.com/v1/games/{place_id}/servers/Public?sortOrder=Asc&limit=100"
        );
        if let Some(cursor) = &cursor {
            url.push_str(&format!("&cursor={cursor}"));
        }

        let response = client.get(&url).send().await.context("listing servers")?;
        if !response.status().is_success() {
            bail!("Roblox returned {} for the server list", response.status());
        }

        let page: ServerPage = response.json().await.context("parsing the server list")?;
        candidates.extend(page.data);

        match page.next_cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => break,
        }
    }

    // A full server can't be joined, so it isn't a candidate.
    candidates.retain(|server| server.playing < server.max_players);

    if candidates.is_empty() {
        return Ok(None);
    }

    let chosen = match mode {
        ServerMode::Closest => {
            // Servers without a ping reading sort last rather than winning by
            // default — an absent value is unknown, not zero.
            candidates
                .iter()
                .min_by(|a, b| {
                    let left = a.ping.unwrap_or(f64::MAX);
                    let right = b.ping.unwrap_or(f64::MAX);
                    left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|server| server.id.clone())
        }
        ServerMode::Random => {
            // No rand dependency for one pick: the caller passes a varying seed.
            let index = (seed % candidates.len() as u64) as usize;
            Some(candidates[index].id.clone())
        }
        ServerMode::Default => None,
    };

    Ok(chosen)
}

/// Extract the place id from a `roblox-player:` URI, if it carries one.
pub fn place_id_from_uri(uri: &str) -> Option<String> {
    let launcher = placelauncher_url(uri)?;
    let marker = launcher.find("placeId=")? + "placeId=".len();
    let value: String = launcher[marker..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    (!value.is_empty()).then_some(value)
}

/// The `placelauncherurl:` segment, percent-decoded.
fn placelauncher_url(uri: &str) -> Option<String> {
    let start = uri.find("placelauncherurl:")? + "placelauncherurl:".len();
    let rest = &uri[start..];
    // Segments are separated by '+', and the encoded URL contains none.
    let encoded = rest.split('+').next()?;
    Some(percent_decode(encoded))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Rewrite a launch URI so it joins a specific server.
///
/// Returns the URI unchanged if it has no PlaceLauncher segment to rewrite.
pub fn with_job_id(uri: &str, job_id: &str) -> String {
    let Some(start) = uri.find("placelauncherurl:") else {
        return uri.to_string();
    };
    let value_start = start + "placelauncherurl:".len();
    let rest = &uri[value_start..];
    let encoded = rest.split('+').next().unwrap_or("");
    let value_end = value_start + encoded.len();

    let decoded = percent_decode(encoded);
    if !decoded.contains("request=RequestGame") {
        return uri.to_string();
    }

    let mut rewritten = decoded.replace("request=RequestGame", "request=RequestGameJob");

    // Don't stack a second gameId if one is somehow already present.
    if !rewritten.contains("gameId=") {
        rewritten.push_str(&format!("&gameId={job_id}"));
    }

    format!(
        "{}{}{}",
        &uri[..value_start],
        percent_encode(&rewritten),
        &uri[value_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str = "roblox-player:1+launchmode:play+gameinfo:TICKET+launchtime:1+placelauncherurl:https%3A%2F%2Fassetgame.roblox.com%2Fgame%2FPlaceLauncher.ashx%3Frequest%3DRequestGame%26placeId%3D1818+browsertrackerid:5";

    #[test]
    fn reads_the_place_id() {
        assert_eq!(place_id_from_uri(URI).as_deref(), Some("1818"));
    }

    #[test]
    fn rewrites_to_a_specific_job() {
        let out = with_job_id(URI, "job-abc");
        let decoded = placelauncher_url(&out).unwrap();
        assert!(decoded.contains("request=RequestGameJob"));
        assert!(decoded.contains("gameId=job-abc"));
        // The segments around it must survive untouched.
        assert!(out.starts_with("roblox-player:1+launchmode:play+gameinfo:TICKET"));
        assert!(out.ends_with("+browsertrackerid:5"));
    }

    #[test]
    fn leaves_unrelated_uris_alone() {
        assert_eq!(with_job_id("roblox-player:1+launchmode:app", "j"), "roblox-player:1+launchmode:app");
    }
}
