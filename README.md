# santi.weblauncher

A Roblox bootstrapper that installs and launches **the exact build you choose**, instead of whatever channel Roblox's A/B service decides to put you on today.

That reassignment is the cause of most "my executor broke after a Roblox update" situations: the executor is compiled against one client build, Roblox quietly moves you to another, and the injector no longer matches. This pins the channel, lets you hold or roll back to a specific version, and shows you — from live WEAO data — which build each executor is actually targeting.

Windows 10/11. Tauri v2 (Rust + a plain HTML/CSS/JS frontend, no framework).

---

## Credits

### SirMeme — [ExploitStrap](https://exploitstrap.com/) / MrExLiveChannelForcer

The launcher this takes its behaviour from: LIVE-channel locking, per-executor profiles, and version pinning for downgrades. ExploitStrap is itself a fork of [Bloxstrap](https://github.com/bloxstraplabs/bloxstrap), which deserves equal credit for establishing what a third-party Roblox bootstrapper does at all.

None of ExploitStrap's layout, visual design or assets were copied — only the problem it solves.

### WEAO RDD Launcher — design reference

The current UI follows [WEAO RDD Launcher](https://rdd.weao.gg): a compact launch window, and a settings view with an icon rail (Launch, Roblox, FFlags, Protocol, Themes, Advanced) over title/description setting rows. That layout was supplied as the design reference. No code or assets were taken.

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

**Exploit sync.** Pick an executor in Settings → Launch and the profile pins whatever Roblox build that executor was compiled against, so you land on a version it actually works with. Mobile-only executors are excluded — their builds aren't published on the desktop CDN.

**Fast flags.** A preset list plus a custom editor and JSON import, writing `ClientSettings/ClientAppSettings.json` into the profile's install. An FPS cap set under Roblox is merged in on top.

**Runs from the tray.** Closing the window hides it rather than quitting — quit from the tray menu. **Launch on Startup** is on by default, and when it's on a **Start in Tray** option appears so a Windows-initiated start can come up hidden.

**Themeable.** Every colour, the dot-grid overlay, UI scale and a background image are configurable under Settings → Themes. The nine WEAO presets are the same ones [rdd.xocat.online](https://rdd.xocat.online) ships — not just the palettes but the artwork that goes with them: the tinted backdrop glow each theme carries, Ball 2.0's tile across every surface, and the falling sprites on voxlis.NET and Sirmeme. Picking a preset in one place and the other gives you the same launcher and the same site. Editing any colour by hand drops the artwork and leaves you with exactly the colours you set.

**Protocol handling (optional, off by default).** Registers the launcher for `roblox-player:` and `roblox-studio:` links under your user account, so the website's Play button opens games in your pinned build. Reversible from the same toggle.

## What it deliberately does not do

MrExLiveChannelForcer bundles "BanAsync" utilities — MAC address spoofing, MachineGuid randomisation and selective cookie wiping. Those are omitted here. They exist to evade account-level enforcement rather than to launch a game, which is outside what this tool is for.

Server selection, activity watching and Discord Rich Presence are also absent. They'd need log tailing and a Discord IPC client; rather than ship switches that quietly do nothing, they're left out until they're actually built.

Every fast flag in the presets list is one whose name is established. A plausible-looking but wrong flag name produces a control that silently has no effect, so the list is shorter than it could be rather than padded.

## Building

```sh
npm install
npm run dev      # tauri dev
npm run build    # tauri build -> NSIS installer
```

Needs a Rust toolchain and WebView2 (preinstalled on Windows 11). Output lands in `src-tauri/target/release/bundle/nsis/`.

The UI is a small launch window that grows into a settings view with an icon rail — Launch, Roblox, FFlags, Protocol, Themes, Advanced. That layout follows the WEAO RDD Launcher, which the author supplied as the design reference.

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
  roblox.rs              registry channel, FFlags, launching, protocol, autostart
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
