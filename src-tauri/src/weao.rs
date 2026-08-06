//! WEAO client — <https://weao.xyz>, docs at <https://docs.weao.xyz>.
//!
//! WEAO requires the `WEAO-3PService` user-agent on every request. A native app
//! can just set it, so unlike the web version there's no proxy involved here.

use anyhow::{bail, Context, Result};
use serde_json::Value;

const BASE: &str = "https://weao.xyz/api";
pub const USER_AGENT: &str = "WEAO-3PService";

async fn get(client: &reqwest::Client, path: &str) -> Result<Value> {
    let url = format!("{BASE}/{path}");
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .with_context(|| format!("requesting {url}"))?;

    let status = response.status();
    let body = response.text().await.context("reading the WEAO response")?;

    if status.as_u16() == 429 {
        // WEAO returns how long to wait; surfacing that beats a bare "429".
        let wait = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value["rateLimitInfo"]["remainingTime"].as_i64());
        match wait {
            Some(seconds) => bail!("Rate limited by WEAO — retry in about {seconds}s"),
            None => bail!("Rate limited by WEAO"),
        }
    }

    if !status.is_success() {
        bail!("WEAO returned {status} for {path}");
    }

    serde_json::from_str(&body).with_context(|| format!("parsing the WEAO response for {path}"))
}

pub async fn current_versions(client: &reqwest::Client) -> Result<Value> {
    get(client, "versions/current").await
}

pub async fn future_versions(client: &reqwest::Client) -> Result<Value> {
    get(client, "versions/future").await
}

pub async fn past_versions(client: &reqwest::Client) -> Result<Value> {
    get(client, "versions/past").await
}

pub async fn exploits(client: &reqwest::Client) -> Result<Value> {
    get(client, "status/exploits").await
}
