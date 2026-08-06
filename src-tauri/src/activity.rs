//! Watches Roblox's client logs to work out what game you're in.
//!
//! Roblox writes logs to `%LOCALAPPDATA%\Roblox\logs` regardless of where the
//! client itself is installed, so this works for our managed builds too. The
//! marker lines below are the stable ones third-party bootstrappers have used
//! for years; they carry the place id and job (server) id we need.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// `! Joining game '<jobId>' place <placeId> at <ip>`
const JOINING: &str = "! Joining game '";
/// Emitted once the connection is actually established.
const JOINED: &str = "[FLog::Network] serverId:";
/// Leaving to the app shell.
const LEAVING: &str = "[FLog::SingleSurfaceApp] leaveUGCGameInternal";
/// Connection torn down.
const DISCONNECTED: &str = "Time to disconnect replication data:";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameSession {
    pub place_id: String,
    pub job_id: String,
    /// Unix seconds when the join was observed.
    pub started: i64,
    /// Filled in from the Roblox web APIs once the join is seen.
    pub name: Option<String>,
    pub creator: Option<String>,
    pub icon: Option<String>,
    pub universe_id: Option<String>,
}

impl GameSession {
    pub fn place_url(&self) -> String {
        format!("https://www.roblox.com/games/{}", self.place_id)
    }
}

pub fn logs_dir() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("Roblox").join("logs");
    dir.is_dir().then_some(dir)
}

/// The log file Roblox is currently writing to.
pub fn newest_log() -> Option<PathBuf> {
    let dir = logs_dir()?;
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("log"))
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Pull the job id and place id out of a joining line.
///
/// `[..] ! Joining game 'abc-123' place 1818 at 1.2.3.4`
fn parse_joining(line: &str) -> Option<(String, String)> {
    let rest = line.split_once(JOINING)?.1;
    let (job_id, rest) = rest.split_once('\'')?;

    let place_marker = rest.find(" place ")? + " place ".len();
    let place_id: String = rest[place_marker..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();

    if job_id.is_empty() || place_id.is_empty() {
        return None;
    }
    Some((job_id.to_string(), place_id))
}

/// Incremental tail over the newest log file.
pub struct LogWatcher {
    path: Option<PathBuf>,
    offset: u64,
    pub session: Option<GameSession>,
    /// Set once the join has been confirmed, so presence isn't shown for a join
    /// that never completed.
    pub connected: bool,
}

impl LogWatcher {
    pub fn new() -> Self {
        Self { path: None, offset: 0, session: None, connected: false }
    }

    /// Read whatever is new. Returns true if the session or its state changed.
    pub fn poll(&mut self) -> bool {
        let Some(current) = newest_log() else {
            return false;
        };

        // Roblox opens a fresh log per launch; follow the switch and start from
        // the beginning of the new file.
        if self.path.as_deref() != Some(current.as_path()) {
            self.path = Some(current.clone());
            self.offset = 0;
            self.session = None;
            self.connected = false;
        }

        let Ok(file) = std::fs::File::open(&current) else {
            return false;
        };

        let Ok(length) = file.metadata().map(|m| m.len()) else {
            return false;
        };

        // Truncated or rotated underneath us.
        if length < self.offset {
            self.offset = 0;
        }
        if length == self.offset {
            return false;
        }

        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(self.offset)).is_err() {
            return false;
        }

        let mut changed = false;
        let mut consumed = self.offset;

        for line in reader.lines() {
            let Ok(line) = line else { break };
            consumed += line.len() as u64 + 1;

            if line.contains(JOINING) {
                if let Some((job_id, place_id)) = parse_joining(&line) {
                    self.session = Some(GameSession {
                        place_id,
                        job_id,
                        started: now_seconds(),
                        ..Default::default()
                    });
                    self.connected = false;
                    changed = true;
                }
            } else if line.contains(JOINED) {
                if self.session.is_some() && !self.connected {
                    self.connected = true;
                    changed = true;
                }
            } else if line.contains(LEAVING) || line.contains(DISCONNECTED) {
                if self.session.is_some() {
                    self.session = None;
                    self.connected = false;
                    changed = true;
                }
            }
        }

        self.offset = consumed;
        changed
    }
}

/* ── Roblox web lookups ─────────────────────────────────────── */

#[derive(Deserialize)]
struct UniverseIdResponse {
    #[serde(rename = "universeId")]
    universe_id: i64,
}

/// Fill in the game's name, creator and icon for a session.
pub async fn describe(client: &reqwest::Client, session: &mut GameSession) -> Result<()> {
    let universe: UniverseIdResponse = client
        .get(format!(
            "https://apis.roblox.com/universes/v1/places/{}/universe",
            session.place_id
        ))
        .send()
        .await?
        .json()
        .await?;

    session.universe_id = Some(universe.universe_id.to_string());

    let details: serde_json::Value = client
        .get(format!(
            "https://games.roblox.com/v1/games?universeIds={}",
            universe.universe_id
        ))
        .send()
        .await?
        .json()
        .await?;

    if let Some(entry) = details["data"].get(0) {
        session.name = entry["name"].as_str().map(str::to_string);
        session.creator = entry["creator"]["name"].as_str().map(str::to_string);
    }

    // The icon is best-effort: presence still works without it.
    if let Ok(thumbs) = client
        .get(format!(
            "https://thumbnails.roblox.com/v1/games/icons?universeIds={}&size=512x512&format=Png&isCircular=false",
            universe.universe_id
        ))
        .send()
        .await
    {
        if let Ok(body) = thumbs.json::<serde_json::Value>().await {
            if let Some(entry) = body["data"].get(0) {
                if entry["state"].as_str() == Some("Completed") {
                    session.icon = entry["imageUrl"].as_str().map(str::to_string);
                }
            }
        }
    }

    Ok(())
}
