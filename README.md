# santi.weblauncher

A Roblox bootstrapper that installs and launches **the exact build you choose**, instead of whatever channel Roblox's A/B service decides to put you on today.

That reassignment is the cause of most "my executor broke after a Roblox update" situations: the executor is compiled against one client build, Roblox quietly moves you to another, and the injector no longer matches. This pins the channel, lets you hold or roll back to a specific version, and shows you — from live WEAO data — which build each executor is actually targeting.

Windows 10/11. Tauri v2 (Rust + a plain HTML/CSS/JS frontend, no framework).

---

## Credits

### SirMeme — [ExploitStrap](https://exploitstrap.com/) / MrExLiveChannelForcer

The launcher this takes its behaviour from: LIVE-channel locking, per-executor profiles, and version pinning for downgrades. ExploitStrap is itself a fork of [Bloxstrap](https://github.com/bloxstraplabs/bloxstrap), which deserves equal credit for establishing what a third-party Roblox bootstrapper does at all.

**The UI here is entirely original** — none of ExploitStrap's layout, visual design or assets were copied. Only the problem it solves was.

### Latte Softworks — [RDD](https://github.com/latte-soft/rdd)

`src-tauri/src/deploy.rs` is a Rust port of RDD's deployment logic: the binary type table, CDN blob directories, and the package-to-directory extraction roots. MIT licensed, © 2024-2026 Latte Softworks. Without that table the ~21 (Player) / ~34 (Studio) loose package zips do not assemble into a working install.

The companion web version lives at **[rdd.xocat.online](https://rdd.xocat.online)** ([source](https://github.com/dlyrr/santi-rdd)).

### WEAO — [What Exploits Are Online](https://weao.xyz)

Every version number and executor status comes from WEAO's [public API](https://docs.weao.xyz/).

---

## What it does

**Channel pinning.** Writes your chosen channel to `HKCU\SOFTWARE\ROBLOX Corporation\Environments\RobloxPlayer\Channel` (and the Studio equivalent), and re-applies it on app start and before every launch — because Roblox's own updater resets it. Turning the setting off deletes the key and hands channel selection back to Roblox.

**Profiles.** Each profile is an independent managed install with its own channel, pinned version and FFlags. Hold one profile on an older build for an executor that hasn't caught up, while another tracks LIVE for actually playing.

**Version pinning and downgrades.** Pin any `version-…` hash, or leave it blank to track the newest build on the channel. Previously installed builds stay on disk, so switching back is instant rather than a re-download.

**Executor compatibility.** The Executors tab lists what WEAO tracks, sorted by whether each one targets the live Roblox build. Anything behind gets an **Install this build** button that pins and installs the version it was compiled against.

**Fast flags.** A JSON editor writing `ClientSettings/ClientAppSettings.json` into the profile's install, validated before it is saved.

**Protocol handling (optional, off by default).** Registers the launcher for `roblox-player:` links under your user account, so the website's Play button opens games in your pinned build. Reversible from the same toggle.

## What it deliberately does not do

MrExLiveChannelForcer bundles "BanAsync" utilities — MAC address spoofing, MachineGuid randomisation and selective cookie wiping. Those are omitted here. They exist to evade account-level enforcement rather than to launch a game, which is outside what this tool is for.

## Building

```sh
npm install
npm run dev      # tauri dev
npm run build    # tauri build -> NSIS installer
```

Needs a Rust toolchain and WebView2 (preinstalled on Windows 11). Output lands in `src-tauri/target/release/bundle/nsis/`.

The produced installer is **unsigned**, so SmartScreen will warn on first run. Code signing certificates cost money; if that bothers you, build it yourself from source — that's why it's here.

## Layout

```
src/                     frontend (no framework, no build step)
  index.html
  styles.css
  main.js
src-tauri/src/
  lib.rs                 Tauri commands and app state
  deploy.rs              CDN download + extraction (Rust port of RDD)
  roblox.rs              registry channel, FFlags, launching, protocol handler
  config.rs              profiles and settings persistence
  weao.rs                WEAO API client
```

Settings and installs live under `%APPDATA%\online.xocat.weblauncher\` — the exact path is shown in Settings.

## Notes

- Launching without a `roblox-player:` URI opens the client to its own home screen. Joining a specific game needs an authentication ticket that only Roblox issues, which is what the Play button (and the protocol handler) provides.
- Installs go to a `.partial` staging directory and are renamed into place only once every package has landed, so an interrupted download can't leave a broken install that looks complete.
- Packages download 6 at a time. Going wider mostly buys connection churn.

## Licence

MIT. The ported deployment logic retains Latte Softworks' original copyright — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to Roblox Corporation.
