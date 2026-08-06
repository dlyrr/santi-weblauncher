/*
    santi.weblauncher — frontend controller.

    Talks to the Rust side over Tauri's IPC. All state of record lives in Rust
    (settings.json); this file holds only the last snapshot it was handed.
*/

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { openUrl } = window.__TAURI__.opener;

const $ = (id) => document.getElementById(id);

let state = null;          // Snapshot from the backend
let liveVersion = null;    // Live Windows hash, from WEAO
let executors = [];
let executorQuery = "";
let busy = false;

const activeProfile = () =>
    state?.settings.profiles.find((p) => p.id === state.settings.active_profile)
    ?? state?.settings.profiles[0]
    ?? null;

/* ── Chrome ─────────────────────────────────────────────────── */

let toastTimer = null;
function toast(message, tone = null) {
    const el = $("toast");
    el.textContent = message;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function log(message, kind = "") {
    const el = $("log");
    const line = document.createElement("div");
    if (kind) line.className = kind;
    line.textContent = message;
    el.append(line);
    el.scrollTop = el.scrollHeight;
}

for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
        document.querySelectorAll(".pane").forEach((p) => p.classList.remove("is-active"));
        tab.classList.add("is-active");
        document.querySelector(`.pane[data-pane="${tab.dataset.tab}"]`).classList.add("is-active");

        if (tab.dataset.tab === "builds") refreshBuilds();
        if (tab.dataset.tab === "flags") loadFlags();
    });
}

// Links must open in the user's browser, not inside the app window.
document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-external], a[href^='http']");
    if (!link) return;
    event.preventDefault();
    openUrl(link.href).catch(() => toast("Could not open the link", "bad"));
});

function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** power;
    return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/* ── Rendering ──────────────────────────────────────────────── */

function renderProfiles() {
    const list = $("profileList");
    list.replaceChildren();

    for (const profile of state.settings.profiles) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "profile" + (profile.id === state.settings.active_profile ? " is-active" : "");

        const dot = document.createElement("span");
        dot.className = "profile__dot";

        const body = document.createElement("span");
        body.className = "profile__body";

        const name = document.createElement("span");
        name.className = "profile__name";
        name.textContent = profile.name;

        const meta = document.createElement("span");
        meta.className = "profile__meta";
        meta.textContent = `${profile.binary_type === "WindowsStudio64" ? "Studio" : "Player"} · ${profile.channel}`;

        body.append(name, meta);
        button.append(dot, body);

        button.addEventListener("click", async () => {
            state.settings = await invoke("set_active_profile", { id: profile.id });
            renderAll();
        });

        list.append(button);
    }
}

function renderHero() {
    const profile = activeProfile();
    if (!profile) return;

    $("heroProfile").textContent = profile.name;
    $("heroVersion").textContent = profile.installed_version || "No build installed";

    const pinned = profile.pinned_version;
    $("heroSub").textContent = profile.installed_version
        ? `${profile.binary_type === "WindowsStudio64" ? "Roblox Studio" : "Roblox Player"} · channel ${profile.channel} · ${pinned ? "pinned" : "tracking latest"}`
        : "Install a build to get started.";

    $("launchBtn").disabled = busy || !profile.installed_version;
    $("installBtn").disabled = busy;

    $("profileChannel").value = profile.channel;
    $("profileVersion").value = pinned || "";
}

function renderSystem() {
    const line = $("sysChannel");
    const text = line.querySelector(".sysline__text");
    const channel = state.system_channel;

    if (!channel) {
        delete line.dataset.state;
        text.textContent = "Channel not pinned";
    } else if (state.settings.pin_channel && channel === state.settings.pinned_channel) {
        line.dataset.state = "pinned";
        text.textContent = `Pinned to ${channel}`;
    } else {
        // Roblox (or another bootstrapper) moved the key out from under us.
        line.dataset.state = "drift";
        text.textContent = `Channel is ${channel}`;
    }

    $("pinChannel").checked = state.settings.pin_channel;
    $("pinnedChannel").value = state.settings.pinned_channel;
    $("protocolHandler").checked = state.owns_protocol;
    $("dataDir").textContent = state.data_dir || "—";
    $("deleteProfileName").textContent = activeProfile()?.name ?? "the active profile";
}

function renderAll() {
    renderProfiles();
    renderHero();
    renderSystem();
    renderExecutors();
}

/* ── Install / launch ───────────────────────────────────────── */

function setBusy(value) {
    busy = value;
    $("launchBtn").disabled = value || !activeProfile()?.installed_version;
    $("installBtn").disabled = value;
    $("statusBar").hidden = !value;
    if (!value) $("statusFill").style.width = "0%";
}

listen("install-progress", (event) => {
    const { phase, message, completed, total, bytes } = event.payload;

    $("statusMessage").textContent = message;
    $("statusCount").textContent = total ? `${completed}/${total} · ${formatBytes(bytes)}` : formatBytes(bytes);

    const percent = phase === "done" ? 100 : total ? (completed / total) * 96 : 4;
    $("statusFill").style.width = `${percent}%`;

    // Unpacking messages arrive per package and would drown the log.
    if (phase !== "downloading" || completed === total) log(message, phase === "done" ? "ok" : "");
});

async function install(versionOverride = null) {
    const profile = activeProfile();
    if (!profile || busy) return;

    setBusy(true);
    log(`Installing for "${profile.name}" (${profile.channel})…`);

    try {
        const version = await invoke("install_profile", { id: profile.id, versionOverride });
        state = await invoke("get_snapshot");
        renderAll();
        toast(`Installed ${version}`, "ok");
    } catch (err) {
        log(String(err), "err");
        toast(String(err), "bad");
    } finally {
        setBusy(false);
        refreshBuilds();
    }
}

$("installBtn").addEventListener("click", () => install());

$("launchBtn").addEventListener("click", async () => {
    const profile = activeProfile();
    if (!profile) return;

    const arg = $("launchArg").value.trim();
    try {
        const pid = await invoke("launch_profile", { id: profile.id, launchArg: arg || null });
        log(`Launched ${profile.installed_version} (pid ${pid})`, "ok");
        toast("Roblox launched", "ok");
        // Launching re-applies the channel pin, so the rail can be stale.
        state = await invoke("get_snapshot");
        renderSystem();
    } catch (err) {
        log(String(err), "err");
        toast(String(err), "bad");
    }
});

$("resolveBtn").addEventListener("click", async () => {
    const profile = activeProfile();
    if (!profile) return;

    try {
        const info = await invoke("resolve_latest", {
            binaryType: profile.binary_type,
            channel: $("profileChannel").value.trim() || "LIVE",
        });
        $("profileVersion").value = info.clientVersionUpload;
        await saveProfileFields();
        toast(`Latest is ${info.clientVersionUpload} (Roblox ${info.version})`);
    } catch (err) {
        toast(String(err), "bad");
    }
});

/* Persist the inline channel/version fields. */
async function saveProfileFields() {
    const profile = activeProfile();
    if (!profile) return;

    const updated = {
        ...profile,
        channel: $("profileChannel").value.trim() || "LIVE",
        pinned_version: $("profileVersion").value.trim() || null,
    };

    state.settings = await invoke("update_profile", { profile: updated });
    renderProfiles();
    renderHero();
}

$("profileChannel").addEventListener("change", saveProfileFields);
$("profileVersion").addEventListener("change", saveProfileFields);

$("addProfile").addEventListener("click", () => {
    $("newProfileName").value = "Executor";
    $("newProfileType").value = "WindowsPlayer";
    $("profileDialog").showModal();
    $("newProfileName").select();
});

$("profileForm").addEventListener("submit", async (event) => {
    // `returnValue` is the value of the button that submitted the form.
    if (event.submitter?.value !== "create") return;

    const name = $("newProfileName").value.trim();
    if (!name) return;

    try {
        state.settings = await invoke("create_profile", {
            name,
            binaryType: $("newProfileType").value,
        });
        renderAll();
        refreshBuilds();
        toast(`Created "${name}"`, "ok");
    } catch (err) {
        toast(String(err), "bad");
    }
});

/* ── Builds ─────────────────────────────────────────────────── */

async function refreshBuilds() {
    const profile = activeProfile();
    const list = $("buildList");
    list.replaceChildren();

    if (!profile) return;

    const builds = await invoke("list_installs", { id: profile.id });

    if (builds.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No builds installed for this profile yet.";
        list.append(empty);
    }

    for (const build of builds) {
        const row = document.createElement("div");
        row.className = "build";

        const version = document.createElement("span");
        version.className = "build__version";
        version.textContent = build.version;
        row.append(version);

        if (build.version === profile.installed_version) {
            const tag = document.createElement("span");
            tag.className = "build__tag";
            tag.dataset.tone = "active";
            tag.textContent = "active";
            row.append(tag);
        }

        if (!build.complete) {
            const tag = document.createElement("span");
            tag.className = "build__tag";
            tag.dataset.tone = "bad";
            tag.textContent = "incomplete";
            row.append(tag);
        }

        const actions = document.createElement("div");
        actions.className = "build__actions";

        const use = document.createElement("button");
        use.className = "btn btn--small";
        use.textContent = "Use";
        use.addEventListener("click", async () => {
            $("profileVersion").value = build.version;
            await saveProfileFields();
            await install(build.version);
        });

        const remove = document.createElement("button");
        remove.className = "btn btn--small btn--danger";
        remove.textContent = "Delete";
        remove.addEventListener("click", async () => {
            await invoke("delete_install", { id: profile.id, version: build.version });
            refreshBuilds();
            toast(`Deleted ${build.version}`);
        });

        actions.append(use, remove);
        row.append(actions);
        list.append(row);
    }

    const official = $("officialList");
    official.replaceChildren();

    if (state.official_installs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No official Roblox install detected.";
        official.append(empty);
    }

    for (const version of state.official_installs) {
        const row = document.createElement("div");
        row.className = "build";
        const label = document.createElement("span");
        label.className = "build__version";
        label.textContent = version;
        const tag = document.createElement("span");
        tag.className = "build__tag";
        tag.dataset.tone = "ok";
        tag.textContent = "roblox";
        row.append(label, tag);
        official.append(row);
    }
}

$("refreshBuilds").addEventListener("click", refreshBuilds);

/* ── Fast flags ─────────────────────────────────────────────── */

async function loadFlags() {
    const profile = activeProfile();
    if (!profile) return;

    try {
        const flags = await invoke("get_fflags", { id: profile.id });
        $("flagEditor").value = JSON.stringify(flags, null, 2);
        setFlagStatus(
            profile.installed_version ? "Loaded from this profile's install." : "No install yet — showing saved flags.",
            null
        );
    } catch (err) {
        setFlagStatus(String(err), "bad");
    }
}

function setFlagStatus(message, tone) {
    const el = $("flagStatus");
    el.textContent = message;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

$("reloadFlags").addEventListener("click", loadFlags);

$("saveFlags").addEventListener("click", async () => {
    const profile = activeProfile();
    if (!profile) return;

    let parsed;
    try {
        parsed = JSON.parse($("flagEditor").value || "{}");
    } catch (err) {
        setFlagStatus(`Not valid JSON — ${err.message}`, "bad");
        return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setFlagStatus("Fast flags must be a JSON object, not an array or literal.", "bad");
        return;
    }

    try {
        state.settings = await invoke("set_fflags", { id: profile.id, fflags: parsed });
        const count = Object.keys(parsed).length;
        setFlagStatus(`Saved ${count} flag${count === 1 ? "" : "s"}. Takes effect on the next launch.`, "ok");
        toast("Fast flags saved", "ok");
    } catch (err) {
        setFlagStatus(String(err), "bad");
    }
});

/* ── Settings ───────────────────────────────────────────────── */

async function applyChannelPin() {
    try {
        state.settings = await invoke("set_channel_pin", {
            enabled: $("pinChannel").checked,
            channel: $("pinnedChannel").value.trim() || "LIVE",
        });
        state = await invoke("get_snapshot");
        renderSystem();
        toast(state.settings.pin_channel ? `Pinned to ${state.settings.pinned_channel}` : "Channel pin removed", "ok");
    } catch (err) {
        toast(String(err), "bad");
        // The write failed, so reflect what is really on the system.
        state = await invoke("get_snapshot");
        renderSystem();
    }
}

$("pinChannel").addEventListener("change", applyChannelPin);
$("applyChannel").addEventListener("click", applyChannelPin);

$("protocolHandler").addEventListener("change", async (event) => {
    try {
        const owns = await invoke("set_protocol_handler", { enabled: event.target.checked });
        event.target.checked = owns;
        toast(owns ? "Now handling roblox-player: links" : "Protocol handler released", "ok");
    } catch (err) {
        toast(String(err), "bad");
        event.target.checked = !event.target.checked;
    }
});

$("deleteProfile").addEventListener("click", async () => {
    const profile = activeProfile();
    if (!profile || busy) return;

    const { ask } = window.__TAURI__.dialog;
    const confirmed = await ask(
        `Delete "${profile.name}" and every build installed under it? This cannot be undone.`,
        { title: "Delete profile", kind: "warning", okLabel: "Delete", cancelLabel: "Keep" }
    );
    if (!confirmed) return;

    try {
        state.settings = await invoke("delete_profile", { id: profile.id });
        renderAll();
        refreshBuilds();
        toast(`Deleted "${profile.name}"`, "ok");
    } catch (err) {
        toast(String(err), "bad");
    }
});

/* ── WEAO ───────────────────────────────────────────────────── */

function compatibility(record) {
    if (!record.rbxversion || !liveVersion) return { state: "unknown", label: "Unknown" };
    if (record.rbxversion.toLowerCase() === liveVersion.toLowerCase()) {
        return record.updateStatus
            ? { state: "current", label: "On live" }
            : { state: "patched", label: "Marked down" };
    }
    return { state: "behind", label: "Behind" };
}

function renderExecutors() {
    const list = $("execList");
    if (!list) return;

    const query = executorQuery.trim().toLowerCase();
    const visible = executors
        .filter((record) => !record.hidden && record.title)
        .filter((record) => !query || record.title.toLowerCase().includes(query));

    list.replaceChildren();

    if (visible.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = executors.length ? "Nothing matches that filter." : "Loading executor data…";
        list.append(empty);
        return;
    }

    const rank = { current: 0, behind: 1, patched: 2, unknown: 3 };
    visible.sort((a, b) => {
        const diff = rank[compatibility(a).state] - rank[compatibility(b).state];
        return diff !== 0 ? diff : a.title.localeCompare(b.title);
    });

    for (const record of visible) {
        const compat = compatibility(record);

        const card = document.createElement("div");
        card.className = "exec";

        const top = document.createElement("div");
        top.className = "exec__top";

        const id = document.createElement("div");
        id.className = "exec__id";

        const logoUrl = record.slug && record.slug.logo;
        if (logoUrl) {
            const logo = document.createElement("img");
            logo.className = "exec__logo";
            logo.src = logoUrl;
            logo.alt = "";
            logo.loading = "lazy";
            logo.addEventListener("error", () => logo.remove());
            id.append(logo);
        }

        const names = document.createElement("div");
        const name = document.createElement("span");
        name.className = "exec__name";
        name.textContent = record.title;
        const ver = document.createElement("span");
        ver.className = "exec__ver";
        ver.textContent = `${record.version || "—"} · ${record.free ? "free" : record.cost || "paid"}`;
        names.append(name, ver);
        id.append(names);

        const pill = document.createElement("span");
        pill.className = "pill";
        pill.dataset.state = compat.state;
        pill.textContent = compat.label;

        top.append(id, pill);

        const stats = document.createElement("div");
        stats.className = "exec__stats";
        for (const [label, value] of [["UNC", record.uncPercentage], ["sUNC", record.suncPercentage]]) {
            const stat = document.createElement("span");
            stat.innerHTML = `${label} <b></b>`;
            stat.querySelector("b").textContent = `${Math.round(Number(value) || 0)}%`;
            stats.append(stat);
        }
        if (record.detected) {
            const flag = document.createElement("span");
            flag.textContent = "detected";
            flag.style.color = "var(--bad)";
            if (record.detectionReason) flag.title = record.detectionReason;
            stats.append(flag);
        }

        const foot = document.createElement("div");
        foot.className = "exec__foot";

        const target = document.createElement("span");
        target.className = "exec__target";
        target.textContent = record.rbxversion || "target unknown";
        foot.append(target);

        // The whole point of this list: one click to get onto the build an
        // executor was actually compiled against.
        if (record.rbxversion && record.rbxversion.startsWith("version-") && compat.state !== "current") {
            const button = document.createElement("button");
            button.className = "btn btn--small";
            button.textContent = "Install this build";
            button.addEventListener("click", async () => {
                $("profileVersion").value = record.rbxversion;
                await saveProfileFields();
                document.querySelector('.tab[data-tab="launch"]').click();
                await install(record.rbxversion);
            });
            foot.append(button);
        }

        card.append(top, stats, foot);
        list.append(card);
    }
}

$("execSearch").addEventListener("input", (event) => {
    executorQuery = event.target.value;
    renderExecutors();
});

async function loadWeao() {
    try {
        const versions = await invoke("weao_versions");
        liveVersion = versions.Windows || null;
        const build = versions.WindowsResponse && versions.WindowsResponse.version;
        $("liveChip").textContent = `live · ${build || liveVersion || "unknown"}`;
        $("liveChip").title = liveVersion || "";
    } catch (err) {
        $("liveChip").textContent = "live · unavailable";
        $("liveChip").title = String(err);
    }

    try {
        const payload = await invoke("weao_exploits");
        executors = Array.isArray(payload) ? payload : Object.values(payload || {});
    } catch (err) {
        executors = [];
        log(`WEAO executor data unavailable: ${err}`, "warn");
    }

    renderExecutors();
}

/* ── Boot ───────────────────────────────────────────────────── */

(async function boot() {
    try {
        state = await invoke("get_snapshot");
    } catch (err) {
        toast(`Could not load settings: ${err}`, "bad");
        return;
    }

    renderAll();
    refreshBuilds();
    loadWeao();
})();
