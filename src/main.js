/*
    santi.weblauncher — frontend controller.

    All state of record lives in Rust (settings.json); this file holds the last
    snapshot it was handed. Setting rows are generated from a schema rather than
    hand-written markup, so adding a setting is one entry rather than three.
*/

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

/* The reference launcher is a small window that grows for settings. */
const SIZE_MAIN = [460, 300];
const SIZE_SETTINGS = [900, 560];

async function resizeTo([width, height]) {
    try {
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(width, height));
        await win.center();
    } catch {
        // Sizing is cosmetic; never let it block opening the panel.
    }
}

const $ = (id) => document.getElementById(id);

let snap = null;      // Snapshot from the backend
let busy = false;
let activeTab = "launch";
let executors = [];
let liveWindows = null;    // live Windows hash, for the outdated check
let pickerExpanded = false;
let session = null;        // current Roblox game, from the activity watcher

const profile = () =>
    snap?.settings.profiles.find((p) => p.id === snap.settings.active_profile)
    ?? snap?.settings.profiles[0]
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

$("closeApp").addEventListener("click", () => invoke("hide_to_tray"));
function openSettings() {
    $("settings").hidden = false;
    resizeTo(SIZE_SETTINGS);
    renderSettings();
}

function closeSettings() {
    $("settings").hidden = true;
    resizeTo(SIZE_MAIN);
}

$("openSettings").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", closeSettings);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("settings").hidden) closeSettings();
});

/* ── Icons ──────────────────────────────────────────────────── */

const ICONS = {
    launch: "M5.5 10.5 3 13l3 .5.5 3 2.5-2.5m-4-3.5L9 5a5.5 5.5 0 0 1 4.5-2.5A5.5 5.5 0 0 1 11 7l-5.5 4.5m0-1 1.5 1.5M9.5 6.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0",
    roblox: "M4 2.2 13.8 4.6 11.4 14.4 1.6 12l2.4-9.8Zm3 4.2-.8 3.2 3.2.8.8-3.2-3.2-.8Z",
    fflags: "M4 2v12M4 3h8l-1.5 2.5L12 8H4",
    protocol: "M6.5 9.5 4 12a2.5 2.5 0 0 1-3.5-3.5L3 6m6.5.5L12 4a2.5 2.5 0 0 1 3.5 3.5L13 10m-7-1 4-4",
    themes: "M5.5 10.5 3 13l3 .5.5 3 2.5-2.5m-4-3.5L9 5a5.5 5.5 0 0 1 4.5-2.5A5.5 5.5 0 0 1 11 7l-5.5 4.5",
    advanced: "M6.7 2.4 5.9 4a5.5 5.5 0 0 0-1.3.7l-1.7-.4-1.3 2.2 1.3 1.2a5.5 5.5 0 0 0 0 1.5L1.6 10.5l1.3 2.2 1.7-.4c.4.3.8.5 1.3.7l.8 1.6h2.6l.8-1.6c.5-.2.9-.4 1.3-.7l1.7.4 1.3-2.2-1.3-1.2a5.5 5.5 0 0 0 0-1.5l1.3-1.2-1.3-2.2-1.7.4a5.5 5.5 0 0 0-1.3-.7l-.8-1.6H6.7Z",
};

function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name] || ICONS.advanced);
    svg.append(path);
    return svg;
}

/* ── Executor pills (same treatment as rdd.xocat.online) ────── */

const LOGO_MANIFEST = "https://logos.xocat.online/manifest.json";
let logoIndex = new Map();

async function loadLogos() {
    try {
        const manifest = await fetch(LOGO_MANIFEST).then((r) => r.json());
        const base = manifest.baseUrl || "https://logos.xocat.online";
        logoIndex = new Map(
            Object.entries(manifest.logos || {}).map(([title, path]) => [
                title.trim().toLowerCase(),
                path.startsWith("http") ? path : base + path,
            ])
        );
    } catch {
        // Logos are decoration; the picker works without them.
        logoIndex = new Map();
    }
}

const logoFor = (title) => logoIndex.get(String(title || "").trim().toLowerCase()) || null;

/* Grouped by type, then per-group rank — WEAO's own ordering. */
const TYPE_ORDER = { wexecutor: 0, wexternal: 1, mexecutor: 2, aexecutor: 3, iexecutor: 4 };

function weaoOrder(a, b) {
    const ga = TYPE_ORDER[a.extype] ?? 9;
    const gb = TYPE_ORDER[b.extype] ?? 9;
    if (ga !== gb) return ga - gb;
    const ia = Number.isFinite(a.index) ? a.index : 999;
    const ib = Number.isFinite(b.index) ? b.index : 999;
    if (ia !== ib) return ia - ib;
    return (a.__pos ?? 0) - (b.__pos ?? 0);
}

/* Only Windows executors can be synced — mobile builds aren't on the CDN. */
const syncable = () =>
    executors
        .filter((e) => e && e.title && !e.hidden && String(e.rbxversion || "").startsWith("version-"))
        .sort(weaoOrder);

const isOutdated = (record) => Boolean(liveWindows) && record.rbxversion !== liveWindows;

function exploitPill(record, selected) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "epill";
    if (selected) pill.dataset.state = "selected";
    else if (isOutdated(record)) pill.dataset.state = "outdated";
    pill.setAttribute("aria-pressed", String(selected));
    pill.title = `${record.title} — targets ${record.rbxversion}`;

    const logo = logoFor(record.title);
    if (logo) {
        const img = document.createElement("img");
        img.className = "epill__logo";
        img.src = logo;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => { img.remove(); pill.classList.add("epill--nologo"); });
        pill.append(img);
    } else {
        pill.classList.add("epill--nologo");
    }

    const label = document.createElement("span");
    label.textContent = record.title;
    pill.append(label);

    if (selected) {
        const clear = document.createElement("span");
        clear.className = "epill__x";
        clear.setAttribute("aria-hidden", "true");
        clear.textContent = "×";
        pill.append(clear);
    }

    pill.addEventListener("click", () => chooseExploit(record));
    return pill;
}

async function chooseExploit(record) {
    const p = profile();
    if (!p) return;

    // Clicking the chosen one again clears the sync.
    if (p.exploit_sync === record.title) {
        await patchProfile({ exploit_sync: null, pinned_version: null });
        return;
    }

    await patchProfile({ exploit_sync: record.title, pinned_version: record.rbxversion });
    if (isOutdated(record)) showOutdated();
    toast(`Synced to ${record.title} — ${record.rbxversion}`, "ok");
}

function renderExploitPicker(host) {
    const p = profile();
    const all = syncable();

    if (all.length === 0) {
        const empty = document.createElement("span");
        empty.className = "epill__loading";
        empty.textContent = executors.length ? "No syncable executors." : "Loading executors…";
        host.append(empty);
        return;
    }

    // With one chosen the rest are noise, same as the website.
    const chosen = all.find((r) => r.title === p?.exploit_sync);
    if (chosen) {
        host.append(exploitPill(chosen, true));
        return;
    }

    const shown = pickerExpanded ? all : all.slice(0, 6);
    shown.forEach((record, index) => {
        const pill = exploitPill(record, false);
        pill.style.setProperty("--i", String(Math.min(index, 12)));
        host.append(pill);
    });

    const remaining = all.length - shown.length;
    if (remaining > 0 || pickerExpanded) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "epill epill--more";
        more.textContent = pickerExpanded ? "show fewer" : `+${remaining} more`;
        more.style.setProperty("--i", String(Math.min(shown.length, 12) + 1));
        more.addEventListener("click", () => { pickerExpanded = !pickerExpanded; renderSettings(); });
        host.append(more);
    }
}

function showOutdated() { $("outdatedModal").hidden = false; }

/* ── Preset fast flags ──────────────────────────────────────── */

/*
    Only flags whose names are well established are listed. Inventing a plausible
    flag name would produce a control that silently does nothing.
*/
const FLAG_PRESETS = [
    { group: "Geometry" },
    { flag: "DFIntCSGLevelOfDetailSwitchingDistance", title: "CSG LOD Distance", desc: "Base switching distance for CSG level of detail", kind: "int" },
    { flag: "DFIntCSGLevelOfDetailSwitchingDistanceL12", title: "CSG LOD L1→L2", desc: "LOD switching distance between levels 1 and 2", kind: "int" },
    { flag: "DFIntCSGLevelOfDetailSwitchingDistanceL23", title: "CSG LOD L2→L3", desc: "LOD switching distance between levels 2 and 3", kind: "int" },
    { flag: "DFIntCSGLevelOfDetailSwitchingDistanceL34", title: "CSG LOD L3→L4", desc: "LOD switching distance between levels 3 and 4", kind: "int" },

    { group: "Rendering" },
    { flag: "FFlagHandleAltEnterFullscreenManually", title: "Alt+Enter Fullscreen", desc: "Handle Alt+Enter fullscreen toggle manually", kind: "bool" },
    { flag: "DFFlagTextureQualityOverrideEnabled", title: "Texture Quality Override", desc: "Enable manual texture quality override", kind: "bool" },
    { flag: "DFIntTextureQualityOverride", title: "Texture Quality", desc: "Texture quality level (0=auto, 1=low, 2=med, 3=high)", kind: "int" },
    { flag: "FIntDebugForceMSAASamples", title: "MSAA Samples", desc: "Force MSAA sample count (0, 1, 2, 4, 8)", kind: "int" },
    { flag: "FFlagDebugGraphicsPreferD3D11", title: "Force DirectX 11", desc: "Prefer the Direct3D 11 renderer", kind: "bool" },
    { flag: "FFlagDebugGraphicsPreferVulkan", title: "Force Vulkan", desc: "Prefer the Vulkan renderer", kind: "bool" },
    { flag: "FFlagDebugGraphicsPreferOpenGL", title: "Force OpenGL", desc: "Prefer the OpenGL renderer", kind: "bool" },
    { flag: "FFlagDebugSkyGray", title: "Gray Sky", desc: "Replace the sky with flat gray", kind: "bool" },
    { flag: "DFFlagDebugPauseVoxelizer", title: "Pause Voxelizer", desc: "Freeze the voxel lighting system", kind: "bool" },
    { flag: "DFIntDebugFRMQualityLevelOverride", title: "FRM Quality Override", desc: "Force a specific future rendering quality level (1-21)", kind: "int" },
    { flag: "FIntFRMMaxGrassDistance", title: "Max Grass Distance", desc: "Maximum grass render distance", kind: "int" },
    { flag: "FIntFRMMinGrassDistance", title: "Min Grass Distance", desc: "Minimum grass render distance", kind: "int" },
    { flag: "FFlagDisablePostFx", title: "Disable Post FX", desc: "Turn off post-processing effects", kind: "bool" },
];

const THEME_KEYS = [
    ["background", "Background", "Main app background color"],
    ["surface", "Surface", "Dialog and card background"],
    ["glass", "Glass tint", "Tint color for buttons, inputs and toggles"],
    ["text", "Text", "Primary labels and setting row text"],
    ["description", "Description", "Secondary and hint text color"],
    ["buttons", "Buttons", "Button and icon text color"],
    ["inputs", "Inputs", "Text inside input fields"],
    ["accent", "Accent", "Toggles, active states and indicators"],
    ["loading", "Loading bar", "Progress and loading bar fill color"],
    ["danger", "Danger", "Kill button and bottom-bar highlight"],
];

/* ── Row builders ───────────────────────────────────────────── */

function row(title, desc, control, { disabled = false } = {}) {
    const el = document.createElement("div");
    el.className = "row" + (disabled ? " row--disabled" : "");

    const text = document.createElement("div");
    text.className = "row__text";

    const heading = document.createElement("div");
    heading.className = "row__title";
    heading.textContent = title;
    text.append(heading);

    if (desc) {
        const description = document.createElement("div");
        description.className = "row__desc";
        description.textContent = desc;
        text.append(description);
    }

    const holder = document.createElement("div");
    holder.className = "row__control";
    if (control) holder.append(...(Array.isArray(control) ? control : [control]));

    el.append(text, holder);
    return el;
}

function groupLabel(name) {
    const el = document.createElement("div");
    el.className = "group";
    el.textContent = name;
    return el;
}

function toggle(checked, onChange) {
    const label = document.createElement("label");
    label.className = "toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));

    const track = document.createElement("span");
    track.className = "toggle__track";
    const thumb = document.createElement("span");
    thumb.className = "toggle__thumb";
    track.append(thumb);

    label.append(input, track);
    return label;
}

function numberField(value, onChange, { width = 74, unit = null } = {}) {
    if (!unit) {
        const input = document.createElement("input");
        input.className = "field field--num";
        input.type = "text";
        input.inputMode = "numeric";
        input.value = value ?? "";
        input.style.width = `${width}px`;
        input.addEventListener("change", () => onChange(input.value.trim()));
        return input;
    }

    const wrap = document.createElement("span");
    wrap.className = "numgroup";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = value ?? "";
    input.addEventListener("change", () => onChange(input.value.trim()));
    const unitEl = document.createElement("span");
    unitEl.className = "unit";
    unitEl.textContent = unit;
    wrap.append(input, unitEl);
    return wrap;
}

function select(options, value, onChange) {
    const el = document.createElement("select");
    el.className = "pick";
    for (const option of options) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        el.append(opt);
    }
    el.value = value ?? "";
    el.addEventListener("change", () => onChange(el.value));
    return el;
}

function button(label, onClick, variant = "") {
    const el = document.createElement("button");
    el.className = "btn" + (variant ? ` btn--${variant}` : "");
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
}

function tag(text, tone = null) {
    const el = document.createElement("span");
    el.className = "tag";
    if (tone) el.dataset.tone = tone;
    el.textContent = text;
    return el;
}

function statusDot(tone) {
    const el = document.createElement("span");
    el.className = "dot";
    el.dataset.tone = tone;
    return el;
}

/* ── Settings mutation ──────────────────────────────────────── */

async function patch(changes) {
    const next = { ...snap.settings, ...changes };
    try {
        snap = await invoke("apply_settings", { settings: next });
        renderMain();
        renderSettings();
    } catch (err) {
        toast(String(err), "bad");
        snap = await invoke("get_snapshot");
        renderSettings();
    }
}

async function patchProfile(changes) {
    const current = profile();
    if (!current) return;
    try {
        snap.settings = await invoke("update_profile", { profile: { ...current, ...changes } });
        renderMain();
        renderSettings();
    } catch (err) {
        toast(String(err), "bad");
    }
}

/* ── Tabs ───────────────────────────────────────────────────── */

const TABS = [
    ["launch", "Launch"],
    ["roblox", "Roblox"],
    ["fflags", "FFlags"],
    ["protocol", "Protocol"],
    ["themes", "Themes"],
    ["advanced", "Advanced"],
];

function renderRail() {
    const rail = $("settingsRail");
    rail.replaceChildren();

    for (const [id, label] of TABS) {
        const btn = document.createElement("button");
        btn.className = "railbtn" + (id === activeTab ? " is-active" : "");
        btn.type = "button";
        btn.append(icon(id));
        const text = document.createElement("span");
        text.textContent = label;
        btn.append(text);
        btn.addEventListener("click", () => {
            activeTab = id;
            renderSettings();
            $("settingsPane").scrollTop = 0;
        });
        rail.append(btn);
    }
}

function renderSettings() {
    if ($("settings").hidden || !snap) return;
    renderRail();

    const pane = $("settingsPane");
    pane.replaceChildren();

    const s = snap.settings;
    const p = profile();

    if (activeTab === "launch") {
        pane.append(row(
            "Roblox Bootstrapper",
            "Automatically downloads and updates the Roblox client",
            toggle(s.bootstrapper, (v) => patch({ bootstrapper: v }))
        ));

        pane.append(groupLabel("Version options"));

        /* Exploit sync — the same pill picker the website uses. */
        const pickerHost = document.createElement("div");
        pickerHost.className = "epills";
        renderExploitPicker(pickerHost);

        const syncRow = row(
            "Exploit sync",
            "Pin the Roblox build your chosen executor was made for. Re-checked on every launch.",
            null
        );
        syncRow.classList.add("row--stack");
        syncRow.querySelector(".row__control").remove();
        syncRow.append(pickerHost);
        pane.append(syncRow);

        const pinned = p?.pinned_version;
        pane.append(row(
            pinned ? `Pinned to ${pinned}` : "No version pinned",
            pinned
                ? "This profile installs exactly this build"
                : "Tracks the newest build on the channel",
            pinned
                ? button("Unpin", () => patchProfile({ pinned_version: null, exploit_sync: null }))
                : tag(p?.exploit_sync ? "synced" : "latest", p?.exploit_sync ? "ok" : null)
        ));

        pane.append(row(
            "Use Roblox CDN instead",
            "Resolve versions straight from Roblox rather than through WEAO",
            toggle(s.use_roblox_cdn, (v) => patch({ use_roblox_cdn: v }))
        ));

        pane.append(row(
            "Studio Bootstrapper",
            "Automatically downloads and updates Roblox Studio",
            toggle(s.studio_bootstrapper, (v) => patch({ studio_bootstrapper: v }))
        ));

        pane.append(row(
            "Multi instance",
            "Allows the launcher to open multiple Roblox clients",
            toggle(s.multi_instance, (v) => patch({ multi_instance: v }))
        ));

        pane.append(row(
            "Prompt on new instance",
            "Confirm before launching when Roblox is already running",
            toggle(s.prompt_on_new_instance, (v) => patch({ prompt_on_new_instance: v }))
        ));

        pane.append(row(
            "Launch delay",
            "Wait before launching the Roblox client",
            [
                s.launch_delay_enabled
                    ? numberField(s.launch_delay_seconds, (v) => patch({ launch_delay_seconds: Math.max(0, parseInt(v, 10) || 0) }), { unit: "sec" })
                    : document.createComment(""),
                toggle(s.launch_delay_enabled, (v) => patch({ launch_delay_enabled: v })),
            ].filter((n) => n.nodeType !== Node.COMMENT_NODE)
        ));

        pane.append(row(
            "Notify on launch",
            "Show a Windows notification with the Roblox process ID on launch",
            toggle(s.notify_on_launch, (v) => patch({ notify_on_launch: v }))
        ));

        pane.append(groupLabel("Startup"));

        pane.append(row(
            "Launch on Startup",
            "Start santi.weblauncher automatically when you sign in to Windows",
            toggle(s.launch_on_startup, (v) => patch({ launch_on_startup: v }))
        ));

        // Only meaningful while autostart is on, so it only appears then.
        if (s.launch_on_startup) {
            pane.append(row(
                "Start in Tray",
                "When Windows starts it, come up hidden in the system tray",
                toggle(s.start_in_tray, (v) => patch({ start_in_tray: v }))
            ));
        }

        pane.append(groupLabel("Channel"));

        pane.append(row(
            "Pin the release channel",
            "Holds Roblox on one channel and re-applies it before every launch",
            toggle(s.pin_channel, (v) => patch({ pin_channel: v }))
        ));

        if (s.pin_channel) {
            const input = document.createElement("input");
            input.className = "field field--wide";
            input.value = s.pinned_channel;
            input.spellcheck = false;
            input.addEventListener("change", () => patch({ pinned_channel: input.value.trim() || "LIVE" }));
            pane.append(row("Channel", "Which channel to hold Roblox on", input));
        }
        return;
    }

    if (activeTab === "roblox") {
        pane.append(row(
            "FPS cap",
            "Limit the Roblox client frame rate",
            [
                s.fps_cap_enabled
                    ? numberField(s.fps_cap, (v) => patch({ fps_cap: Math.max(1, parseInt(v, 10) || 60) }), { unit: "fps" })
                    : document.createComment(""),
                toggle(s.fps_cap_enabled, (v) => patch({ fps_cap_enabled: v })),
            ].filter((n) => n.nodeType !== Node.COMMENT_NODE)
        ));

        pane.append(row(
            "Server selection",
            "Which server a launch joins. Closest sorts Roblox's public server list by reported ping.",
            select(
                [
                    { value: "default", label: "Roblox decides" },
                    { value: "closest", label: "Closest" },
                    { value: "random", label: "Random" },
                ],
                s.server_mode || "default",
                (v) => patch({ server_mode: v })
            )
        ));

        pane.append(groupLabel("Activity"));

        pane.append(row(
            "Activity Watcher",
            "Read Roblox's log files to track your current game session",
            toggle(s.activity_watcher, (v) => patch({ activity_watcher: v }))
        ));

        pane.append(row(
            "Discord Rich Presence",
            "Show the game you're in on your Discord profile",
            toggle(s.discord_rpc, (v) => patch({ discord_rpc: v })),
            { disabled: !s.activity_watcher }
        ));

        pane.append(row(
            "Show join buttons",
            'Add a "See game page" button to your presence',
            toggle(s.show_join_buttons, (v) => patch({ show_join_buttons: v })),
            { disabled: !s.activity_watcher || !s.discord_rpc }
        ));

        if (session) {
            pane.append(groupLabel("Right now"));
            pane.append(row(
                session.name || `Place ${session.place_id}`,
                session.creator ? `by ${session.creator}` : "In game",
                tag("in game", "ok")
            ));
        }

        return;
    }

    if (activeTab === "fflags") {
        renderFlags(pane);
        return;
    }

    if (activeTab === "protocol") {
        const pr = snap.protocol;

        pane.append(row(
            "Registration status",
            pr.player_ours ? "Registered to this launcher"
                : pr.player_registered ? "Another bootstrapper is registered"
                : "Not registered",
            statusDot(pr.player_ours ? "ok" : pr.player_registered ? "warn" : "off")
        ));

        pane.append(row(
            "Re-register handler",
            "Re-apply this launcher as the roblox-player:// handler",
            button("Re-register", () => setProtocol(true, false))
        ));

        pane.append(row(
            "Remove handler",
            "Remove the roblox-player:// and roblox:// handlers entirely",
            button("Remove", () => setProtocol(false, false))
        ));

        pane.append(row(
            "Studio Registration status",
            pr.studio_ours ? "Registered to this launcher"
                : pr.studio_registered ? "Another bootstrapper is registered"
                : "Not registered",
            statusDot(pr.studio_ours ? "ok" : pr.studio_registered ? "warn" : "off")
        ));

        pane.append(row(
            "Register Studio handler",
            "Set this launcher as the roblox-studio:// handler",
            button("Register", () => setProtocol(true, true))
        ));

        pane.append(row(
            "Remove Studio handler",
            "Remove the roblox-studio:// handler entirely",
            button("Remove", () => setProtocol(false, true))
        ));
        return;
    }

    if (activeTab === "themes") {
        for (const [key, title, desc] of THEME_KEYS) {
            const swatch = document.createElement("button");
            swatch.className = "swatch";
            swatch.style.background = s.theme[key];

            const picker = document.createElement("input");
            picker.type = "color";
            picker.value = s.theme[key];
            swatch.append(picker);
            swatch.addEventListener("click", () => picker.click());

            const hex = document.createElement("input");
            hex.className = "field hex";
            hex.value = s.theme[key];
            hex.spellcheck = false;

            const commit = (value) => {
                if (!/^#[0-9a-f]{6}$/i.test(value)) { hex.value = s.theme[key]; return; }
                setTheme({ [key]: value.toLowerCase() });
            };
            picker.addEventListener("change", () => commit(picker.value));
            hex.addEventListener("change", () => commit(hex.value.trim()));

            pane.append(row(title, desc, [swatch, hex]));
        }

        pane.append(row(
            "Grid overlay",
            "Show dot-grid texture on background",
            toggle(s.theme.grid_overlay, (v) => setTheme({ grid_overlay: v }))
        ));

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "slider";
        slider.min = "80"; slider.max = "140"; slider.step = "5";
        slider.value = String(s.theme.ui_scale);
        const scaleLabel = document.createElement("span");
        scaleLabel.className = "tag";
        scaleLabel.textContent = `${s.theme.ui_scale}%`;
        slider.addEventListener("input", () => { scaleLabel.textContent = `${slider.value}%`; });
        slider.addEventListener("change", () => setTheme({ ui_scale: Number(slider.value) }));
        pane.append(row("UI scale", "Make text and controls larger", [slider, scaleLabel]));

        pane.append(row(
            "Background image",
            s.theme.background_image ? s.theme.background_image : "None",
            [
                button("Browse", async () => {
                    const file = await openDialog({
                        multiple: false,
                        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
                    });
                    if (file) setTheme({ background_image: file });
                }),
                s.theme.background_image ? button("Clear", () => setTheme({ background_image: null })) : document.createComment(""),
            ].filter((n) => n.nodeType !== Node.COMMENT_NODE)
        ));

        pane.append(row(
            "Reset theme",
            "Restore all colors and background to defaults",
            button("Reset", () => setTheme(null), "danger")
        ));
        return;
    }

    if (activeTab === "advanced") {
        pane.append(row(
            "Auto check for updates",
            "Check for santi.weblauncher updates on startup",
            toggle(s.auto_check_updates, (v) => patch({ auto_check_updates: v }))
        ));

        const updateBtn = button("Check", () => checkForUpdate(updateBtn, true));
        pane.append(row(
            "Check for updates",
            "Download and install a newer santi.weblauncher if one is published",
            updateBtn
        ));

        pane.append(row(
            "Open Roblox installation folder",
            "Roblox's own install directory",
            button("Open", () => openFolder("roblox"))
        ));

        pane.append(row(
            "Versions folder",
            snap.data_dir || "AppData",
            button("Open", () => openFolder("versions"))
        ));

        pane.append(row(
            "Reset settings",
            "Restore every setting to its default. Installed builds are kept.",
            button("Reset", async () => {
                snap.settings = await invoke("reset_settings");
                snap = await invoke("get_snapshot");
                applyTheme();
                renderMain();
                renderSettings();
                toast("Settings reset", "ok");
            }, "danger")
        ));

        const credits = document.createElement("p");
        credits.className = "pane__empty";
        credits.textContent =
            `santi.weblauncher v${snap.app_version} · MIT · `
            + "Behaviour after SirMeme's ExploitStrap, installer ported from Latte Softworks' RDD, "
            + "data from WEAO. Settings layout after WEAO RDD Launcher. Not affiliated with Roblox.";
        pane.append(credits);
    }
}

/* ── Fast flags tab ─────────────────────────────────────────── */

function renderFlags(pane) {
    const p = profile();
    const flags = { ...(p?.fflags || {}) };

    const commit = async (next) => {
        try {
            snap.settings = await invoke("set_fflags", { id: p.id, fflags: next });
            renderSettings();
        } catch (err) {
            toast(String(err), "bad");
        }
    };

    for (const preset of FLAG_PRESETS) {
        if (preset.group) { pane.append(groupLabel(preset.group)); continue; }

        const raw = flags[preset.flag];

        if (preset.kind === "bool") {
            const on = raw === true || raw === "true";
            pane.append(row(preset.title, `› ${preset.desc}`, toggle(on, (v) => {
                const next = { ...flags };
                if (v) next[preset.flag] = "True"; else delete next[preset.flag];
                commit(next);
            })));
        } else {
            pane.append(row(preset.title, `› ${preset.desc}`, numberField(
                raw ?? "",
                (value) => {
                    const next = { ...flags };
                    if (value === "") delete next[preset.flag];
                    else next[preset.flag] = value;
                    commit(next);
                },
                { width: 82 }
            )));
        }
    }

    pane.append(groupLabel("Custom"));

    const editor = document.createElement("div");
    editor.className = "customflag";

    const name = document.createElement("input");
    name.className = "field customflag__name";
    name.placeholder = "FFlagName";
    name.spellcheck = false;

    const value = document.createElement("input");
    value.className = "field customflag__value";
    value.placeholder = "value";
    value.spellcheck = false;

    const add = button("+", () => {
        const key = name.value.trim();
        if (!key) return;
        commit({ ...flags, [key]: value.value.trim() || "True" });
        name.value = ""; value.value = "";
    });
    add.classList.add("customflag__add");

    const importBtn = button("Import JSON", async () => {
        const file = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (!file) return;
        try {
            // Read through the backend rather than granting the webview fs access.
            const text = await invoke("read_text_file", { path: file });
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                commit({ ...flags, ...parsed });
                toast(`Imported ${Object.keys(parsed).length} flags`, "ok");
            } else {
                toast("That file isn't a JSON object of flags", "bad");
            }
        } catch (err) {
            toast(`Could not import: ${err}`, "bad");
        }
    });

    editor.append(name, value, add, importBtn);
    pane.append(editor);

    const custom = Object.keys(flags).filter(
        (key) => !FLAG_PRESETS.some((preset) => preset.flag === key)
    );

    if (custom.length === 0) {
        const empty = document.createElement("p");
        empty.className = "pane__empty";
        empty.textContent = "No custom flags. Add one above.";
        pane.append(empty);
        return;
    }

    for (const key of custom) {
        const line = document.createElement("div");
        line.className = "flagrow";

        const label = document.createElement("span");
        label.className = "flagrow__name";
        label.textContent = key;

        const val = document.createElement("span");
        val.className = "flagrow__value";
        val.textContent = String(flags[key]);

        const remove = button("Remove", () => {
            const next = { ...flags };
            delete next[key];
            commit(next);
        }, "danger");

        line.append(label, val, remove);
        pane.append(line);
    }
}

/* ── Actions ────────────────────────────────────────────────── */

async function setProtocol(enabled, studio) {
    try {
        snap.protocol = await invoke("set_protocol_handler", { enabled, studio });
        renderSettings();
        toast(enabled ? "Handler registered" : "Handler removed", "ok");
    } catch (err) {
        toast(String(err), "bad");
    }
}

async function openFolder(which) {
    try {
        await invoke("open_path", { which });
    } catch (err) {
        toast(String(err), "bad");
    }
}

async function setTheme(changes) {
    const next = changes === null ? defaultTheme() : { ...snap.settings.theme, ...changes };
    try {
        snap.settings = await invoke("set_theme", { theme: next });
        applyTheme();
        renderSettings();
    } catch (err) {
        toast(String(err), "bad");
    }
}

function defaultTheme() {
    return {
        background: "#161616", surface: "#1c1e20", glass: "#ffffff",
        text: "#e8e8e8", description: "#7a7a7a", buttons: "#999999",
        inputs: "#bbbbbb", accent: "#3bea57", loading: "#ffffff", danger: "#ec3b47",
        grid_overlay: true, ui_scale: 100, background_image: null,
    };
}

function applyTheme() {
    const t = snap?.settings?.theme;
    if (!t) return;

    const root = document.documentElement;
    for (const [key] of THEME_KEYS) root.style.setProperty(`--${key}`, t[key]);
    root.style.setProperty("--grid-opacity", t.grid_overlay ? "1" : "0");
    root.style.fontSize = `${(t.ui_scale / 100) * 16}px`;

    if (t.background_image) {
        // Inlined as a data URL by the backend, so no asset protocol or
        // filesystem scope has to be opened up for it.
        invoke("read_image_data_url", { path: t.background_image })
            .then((url) => {
                root.style.setProperty("--background-image", `url("${url}")`);
                document.body.classList.add("has-bg");
            })
            .catch((err) => {
                document.body.classList.remove("has-bg");
                toast(String(err), "bad");
            });
    } else {
        document.body.classList.remove("has-bg");
    }
}

async function syncToExploit(title) {
    try {
        const version = await invoke("resolve_exploit_version", { title });
        if (!version) {
            toast(`${title} has no downloadable Windows build listed`, "bad");
            return;
        }
        await patchProfile({ pinned_version: version, exploit_sync: title });
        toast(`Synced to ${title} — ${version}`, "ok");
    } catch (err) {
        toast(String(err), "bad");
    }
}

/* ── Main view ──────────────────────────────────────────────── */

function renderMain() {
    if (!snap) return;
    const p = profile();

    $("versionChip").textContent = `v${snap.app_version}`;
    $("buildVersion").textContent = p?.installed_version || "no build installed";
    $("channelState").textContent = snap.system_channel ? `channel ${snap.system_channel}` : "channel unpinned";

    const ready = Boolean(p?.installed_version);

    if (session) {
        $("stageTitle").textContent = session.name || `Place ${session.place_id}`;
        $("stageSub").textContent = session.creator ? `Playing — by ${session.creator}` : "Playing";
    } else {
        $("stageTitle").textContent = ready ? "Ready to launch" : "No build installed";
        $("stageSub").textContent = ready
            ? "Head to Roblox.com and join a game to get started"
            : "Install a Roblox build to get started";
    }

    $("launchBtn").textContent = ready ? "Launch Roblox" : "Install Roblox";
    $("launchBtn").disabled = busy;

    const sync = p?.exploit_sync;
    $("syncChip").hidden = !sync;
    if (sync) $("syncChip").textContent = `sync: ${sync}`;
}

listen("install-progress", (event) => {
    const { phase, message, completed, total } = event.payload;
    $("progressLine").hidden = false;
    $("progressLabel").textContent = message;
    const percent = phase === "done" ? 100 : total ? (completed / total) * 96 : 6;
    $("progressFill").style.width = `${percent}%`;
});

$("launchBtn").addEventListener("click", async () => {
    const p = profile();
    if (!p || busy) return;

    busy = true;
    renderMain();
    $("stageHint").textContent = "";

    try {
        if (!p.installed_version) {
            await invoke("install_profile", { id: p.id, versionOverride: null });
            snap = await invoke("get_snapshot");
            toast("Build installed", "ok");
        } else {
            // launch_flow re-checks the synced executor's build and installs the
            // right one first, emitting install-progress as it goes.
            const pid = await invoke("launch_flow", { id: p.id, launchArg: null });
            snap = await invoke("get_snapshot");
            $("stageHint").textContent = `Roblox started (pid ${pid})`;

            if (snap.settings.notify_on_launch) {
                const { isPermissionGranted, requestPermission, sendNotification } = window.__TAURI__.notification;
                let granted = await isPermissionGranted();
                if (!granted) granted = (await requestPermission()) === "granted";
                if (granted) sendNotification({ title: "santi.weblauncher", body: `Roblox started (pid ${pid})` });
            }
        }
    } catch (err) {
        $("stageHint").textContent = "";
        toast(String(err), "bad");
    } finally {
        busy = false;
        setTimeout(() => { $("progressLine").hidden = true; $("progressFill").style.width = "0%"; }, 700);
        renderMain();
        renderSettings();
    }
});

$("outdatedOk").addEventListener("click", () => { $("outdatedModal").hidden = true; });
$("outdatedModal").addEventListener("click", (event) => {
    if (event.target === $("outdatedModal")) $("outdatedModal").hidden = true;
});

/* ── Updates ────────────────────────────────────────────────── */

/*
    Signed updates via the Tauri updater. The manifest lives on
    rdd.xocat.online and each installer is minisign-signed, so an update can
    only install if it was built with our private key.
*/
async function checkForUpdate(btn, interactive) {
    const { check } = window.__TAURI__.updater;
    const setLabel = (text) => { if (btn) btn.textContent = text; };

    try {
        setLabel("Checking…");
        const update = await check();

        if (!update) {
            setLabel("Check");
            if (interactive) toast(`You're on the latest version (v${snap.app_version})`, "ok");
            return;
        }

        if (interactive) {
            const { ask } = window.__TAURI__.dialog;
            const go = await ask(
                `Version ${update.version} is available. Install it now? The launcher will restart.`,
                { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" }
            );
            if (!go) { setLabel("Check"); return; }
        }

        setLabel("Updating…");
        $("progressLine").hidden = false;
        $("progressLabel").textContent = `Downloading v${update.version}…`;

        let total = 0;
        let received = 0;
        await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
                total = event.data.contentLength || 0;
            } else if (event.event === "Progress") {
                received += event.data.chunkLength || 0;
                const pct = total ? Math.min((received / total) * 100, 100) : 40;
                $("progressFill").style.width = `${pct}%`;
            } else if (event.event === "Finished") {
                $("progressFill").style.width = "100%";
                $("progressLabel").textContent = "Restarting…";
            }
        });

        await window.__TAURI__.process.relaunch();
    } catch (err) {
        setLabel("Check");
        $("progressLine").hidden = true;
        if (interactive) toast(`Update failed: ${err}`, "bad");
    }
}

/* ── Activity ───────────────────────────────────────────────── */

listen("activity", (event) => {
    session = event.payload || null;
    renderMain();
    if (activeTab === "roblox") renderSettings();
});

/* ── Boot ───────────────────────────────────────────────────── */

(async function boot() {
    try {
        snap = await invoke("get_snapshot");
    } catch (err) {
        toast(`Could not load settings: ${err}`, "bad");
        return;
    }

    applyTheme();
    renderMain();

    await loadLogos();

    try {
        const [payload, versions] = await Promise.all([
            invoke("weao_exploits"),
            invoke("weao_versions").catch(() => null),
        ]);
        const list = Array.isArray(payload) ? payload : Object.values(payload || {});
        // Keep the API's own order available as a tiebreaker.
        executors = list.map((entry, index) => ({ ...entry, __pos: index }));
        liveWindows = versions?.Windows || null;
    } catch {
        executors = [];
    }

    renderMain();
    renderSettings();

    if (snap.settings.auto_check_updates) {
        // Quiet on startup: only speaks up if an update actually installs.
        checkForUpdate(null, false);
    }
})();
