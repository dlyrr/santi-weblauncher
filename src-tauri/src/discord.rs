//! Discord Rich Presence over Discord's local IPC socket.
//!
//! Discord exposes a named pipe on Windows (`\\.\pipe\discord-ipc-N`, N in 0..9
//! — several can exist when more than one Discord client is installed). The
//! wire format is a 4-byte little-endian opcode, a 4-byte little-endian payload
//! length, then UTF-8 JSON.
//!
//! Implemented directly rather than pulled in as a dependency: it is about a
//! hundred lines, and the crates in this space tend to spawn their own runtimes.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;

/// What to show on a profile. `None` for any field simply omits it.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Activity {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    /// Unix seconds; Discord renders this as an elapsed timer.
    pub start: Option<i64>,
    /// Up to two link buttons.
    pub buttons: Vec<(String, String)>,
}

impl Activity {
    fn to_payload(&self) -> Value {
        let mut activity = serde_json::Map::new();

        if let Some(details) = &self.details {
            activity.insert("details".into(), json!(truncate(details, 128)));
        }
        if let Some(state) = &self.state {
            activity.insert("state".into(), json!(truncate(state, 128)));
        }
        if let Some(start) = self.start {
            activity.insert("timestamps".into(), json!({ "start": start }));
        }

        let mut assets = serde_json::Map::new();
        if let Some(v) = &self.large_image { assets.insert("large_image".into(), json!(v)); }
        if let Some(v) = &self.large_text { assets.insert("large_text".into(), json!(truncate(v, 128))); }
        if let Some(v) = &self.small_image { assets.insert("small_image".into(), json!(v)); }
        if let Some(v) = &self.small_text { assets.insert("small_text".into(), json!(truncate(v, 128))); }
        if !assets.is_empty() {
            activity.insert("assets".into(), Value::Object(assets));
        }

        if !self.buttons.is_empty() {
            // Discord rejects the whole payload if a button URL isn't http(s),
            // so anything else is dropped rather than risking the update.
            let buttons: Vec<Value> = self
                .buttons
                .iter()
                .filter(|(_, url)| url.starts_with("https://") || url.starts_with("http://"))
                .take(2)
                .map(|(label, url)| json!({ "label": truncate(label, 31), "url": url }))
                .collect();
            if !buttons.is_empty() {
                activity.insert("buttons".into(), Value::Array(buttons));
            }
        }

        Value::Object(activity)
    }
}

/// Discord counts in UTF-16 code units and rejects overlong fields, so cut on a
/// char boundary well inside the limit.
fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub struct DiscordIpc {
    client_id: String,
    pipe: Option<std::fs::File>,
    last: Option<Activity>,
}

impl DiscordIpc {
    pub fn new(client_id: impl Into<String>) -> Self {
        Self { client_id: client_id.into(), pipe: None, last: None }
    }

    pub fn is_connected(&self) -> bool {
        self.pipe.is_some()
    }

    /// Open the first available Discord pipe and complete the handshake.
    pub fn connect(&mut self) -> Result<()> {
        if self.pipe.is_some() {
            return Ok(());
        }

        let mut opened = None;
        for index in 0..10 {
            let path = pipe_path(index);
            if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                opened = Some(file);
                break;
            }
        }

        let Some(pipe) = opened else {
            bail!("Discord isn't running, or its IPC pipe isn't available");
        };

        self.pipe = Some(pipe);

        let handshake = json!({ "v": 1, "client_id": self.client_id });
        self.send(OP_HANDSHAKE, &handshake)
            .context("sending the Discord handshake")?;

        // Discord replies READY, or closes the pipe if it refuses the client id.
        match self.read_frame() {
            Ok(ready) => {
                if ready["evt"].as_str() == Some("ERROR") {
                    self.pipe = None;
                    let message = ready["data"]["message"].as_str().unwrap_or("handshake refused");
                    bail!("Discord refused the connection: {message}");
                }
            }
            Err(err) => {
                self.pipe = None;
                return Err(err).context("reading Discord's handshake reply");
            }
        }

        // Anything set before a reconnect should survive it. `last` has to be
        // cleared first or set_activity would treat it as a no-op.
        if let Some(activity) = self.last.take() {
            let _ = self.set_activity(&activity);
        }

        Ok(())
    }

    pub fn disconnect(&mut self) {
        if self.pipe.is_some() {
            let _ = self.send(OP_CLOSE, &json!({}));
        }
        self.pipe = None;
    }

    fn send(&mut self, opcode: u32, payload: &Value) -> Result<()> {
        let Some(pipe) = self.pipe.as_mut() else {
            bail!("not connected to Discord");
        };

        let body = serde_json::to_vec(payload)?;
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&opcode.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);

        pipe.write_all(&frame)?;
        pipe.flush()?;
        Ok(())
    }

    fn read_frame(&mut self) -> Result<Value> {
        let Some(pipe) = self.pipe.as_mut() else {
            bail!("not connected to Discord");
        };

        let mut header = [0u8; 8];
        pipe.read_exact(&mut header)?;
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;

        // A sane cap: real frames are small, and a corrupt length would
        // otherwise allocate wildly.
        if length > 64 * 1024 {
            bail!("Discord sent an implausible frame length ({length})");
        }

        let mut body = vec![0u8; length];
        pipe.read_exact(&mut body)?;
        Ok(serde_json::from_slice(&body)?)
    }

    /// Push an activity. Repeated identical updates are skipped — Discord rate
    /// limits SET_ACTIVITY to roughly one update every 15 seconds.
    pub fn set_activity(&mut self, activity: &Activity) -> Result<()> {
        if self.last.as_ref() == Some(activity) && self.is_connected() {
            return Ok(());
        }

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": nonce(),
            "args": {
                "pid": std::process::id(),
                "activity": activity.to_payload(),
            }
        });

        match self.command(&payload) {
            Ok(reply) => {
                // Discord reports a rejected payload in the frame, not at the
                // socket level, so a write that "succeeded" can still have been
                // thrown away.
                if reply["evt"].as_str() == Some("ERROR") {
                    let message = reply["data"]["message"].as_str().unwrap_or("unknown reason");
                    bail!("Discord rejected the activity: {message}");
                }
                self.last = Some(activity.clone());
                Ok(())
            }
            Err(err) => {
                // A broken pipe means Discord went away; drop it so the next
                // tick reconnects instead of failing forever.
                self.pipe = None;
                Err(err)
            }
        }
    }

    /// Send a frame and consume its reply.
    ///
    /// Discord answers every frame. Writing without reading leaves those replies
    /// in the pipe, and a long-running session eventually fills the buffer and
    /// blocks on a write that looks like a hang.
    fn command(&mut self, payload: &Value) -> Result<Value> {
        self.send(OP_FRAME, payload)?;
        self.read_frame()
    }

    /// Remove the presence without dropping the connection.
    pub fn clear_activity(&mut self) -> Result<()> {
        if self.last.is_none() && self.is_connected() {
            return Ok(());
        }

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": nonce(),
            "args": { "pid": std::process::id() }
        });

        self.last = None;
        match self.command(&payload) {
            Ok(_) => Ok(()),
            Err(err) => {
                self.pipe = None;
                Err(err)
            }
        }
    }

    /// Cheap liveness probe, so a dead pipe is noticed between game events.
    pub fn ping(&mut self) -> Result<()> {
        let result = self.send(OP_PING, &json!({})).and_then(|()| self.read_frame());
        if result.is_err() {
            self.pipe = None;
        }
        result.map(|_| ())
    }
}

#[cfg(windows)]
fn pipe_path(index: u32) -> String {
    format!(r"\\.\pipe\discord-ipc-{index}")
}

#[cfg(not(windows))]
fn pipe_path(index: u32) -> String {
    // Unix sockets, kept only so the module compiles off Windows.
    let base = std::env::var("XDG_RUNTIME_DIR")
        .or_else(|_| std::env::var("TMPDIR"))
        .unwrap_or_else(|_| "/tmp".to_string());
    format!("{base}/discord-ipc-{index}")
}

/// Discord only requires the nonce to be unique per request.
fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("santi-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to the Discord client actually running on this machine.
    ///
    /// Ignored by default because it needs Discord open. Run with:
    ///   cargo test --lib discord -- --ignored --nocapture
    #[test]
    #[ignore]
    fn handshake_and_set_activity_against_real_discord() {
        let mut ipc = DiscordIpc::new(crate::DISCORD_APP_ID);

        ipc.connect().expect("connecting to Discord");
        assert!(ipc.is_connected(), "pipe should be open after connect");

        // connect() consumes the READY frame, so probe the link with a ping and
        // read what comes back.
        ipc.ping().expect("ping round trip");
        println!("ping round-tripped");

        let activity = Activity {
            details: Some("santi.weblauncher self-test".into()),
            state: Some("verifying rich presence".into()),
            small_text: Some("santi.weblauncher".into()),
            start: Some(1_785_000_000),
            buttons: vec![("See game page".into(), "https://www.roblox.com/games/1818".into())],
            ..Default::default()
        };

        // set_activity now consumes its own reply and turns a rejection into an
        // Err, so a plain expect() is the whole assertion.
        ipc.set_activity(&activity).expect("Discord accepted the activity");
        println!("activity accepted");

        std::thread::sleep(std::time::Duration::from_secs(3));

        ipc.clear_activity().expect("clearing the activity");
        println!("activity cleared");

        // Prove the pipe is still usable after several round trips — the bug
        // this guards against only shows up once replies pile up unread.
        for i in 0..5 {
            let a = Activity { details: Some(format!("round trip {i}")), ..Default::default() };
            ipc.set_activity(&a).expect("repeated updates keep working");
        }
        println!("5 further updates round-tripped cleanly");
        ipc.clear_activity().ok();

        ipc.disconnect();
    }
}
