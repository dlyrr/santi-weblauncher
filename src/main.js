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

/* ── Window chrome ──────────────────────────────────────────── */

/*
    Native decorations are off, so the frame is ours: dragging, minimising and
    the resize borders all have to be provided here.

    Dragging is done manually rather than with `data-tauri-drag-region` because
    that also maps double-click to maximise, which makes no sense for a launcher
    laid out for a 460x300 window.
*/
const appWindow = getCurrentWindow();

for (const region of document.querySelectorAll("[data-tauri-drag-region]")) {
    region.addEventListener("pointerdown", (event) => {
        // Only a plain left-press on empty chrome starts a drag.
        if (event.button !== 0) return;
        if (event.target.closest("button, input, select, a")) return;
        appWindow.startDragging().catch(() => {});
    });
}

for (const handle of document.querySelectorAll(".rz")) {
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        appWindow.startResizeDragging(handle.dataset.dir).catch(() => {});
    });
}

const minimise = () => appWindow.minimize().catch(() => {});
$("minimizeApp").addEventListener("click", minimise);
$("minimizeSettings").addEventListener("click", minimise);

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
    if (event.key !== "Escape") return;
    if (!$("updateModal").hidden) { hideUpdateModal(); return; }
    if (!$("outdatedModal").hidden) { $("outdatedModal").hidden = true; return; }
    if (!$("settings").hidden) closeSettings();
});

/* ── Icons ──────────────────────────────────────────────────── */

const ICONS = {
    launch: "M5.5 10.5 3 13l3 .5.5 3 2.5-2.5m-4-3.5L9 5a5.5 5.5 0 0 1 4.5-2.5A5.5 5.5 0 0 1 11 7l-5.5 4.5m0-1 1.5 1.5M9.5 6.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0",
    fflags: "M4 2v12M4 3h8l-1.5 2.5L12 8H4",
    protocol: "M6.5 9.5 4 12a2.5 2.5 0 0 1-3.5-3.5L3 6m6.5.5L12 4a2.5 2.5 0 0 1 3.5 3.5L13 10m-7-1 4-4",
    themes: "M5.5 10.5 3 13l3 .5.5 3 2.5-2.5m-4-3.5L9 5a5.5 5.5 0 0 1 4.5-2.5A5.5 5.5 0 0 1 11 7l-5.5 4.5",
    advanced: "M6.7 2.4 5.9 4a5.5 5.5 0 0 0-1.3.7l-1.7-.4-1.3 2.2 1.3 1.2a5.5 5.5 0 0 0 0 1.5L1.6 10.5l1.3 2.2 1.7-.4c.4.3.8.5 1.3.7l.8 1.6h2.6l.8-1.6c.5-.2.9-.4 1.3-.7l1.7.4 1.3-2.2-1.3-1.2a5.5 5.5 0 0 0 0-1.5l1.3-1.2-1.3-2.2-1.7.4a5.5 5.5 0 0 0-1.3-.7l-.8-1.6H6.7Z",
};

/*
    The official Roblox mark, from Wikimedia Commons. It is a filled compound
    path with an even-odd hole rather than a stroked outline, so it cannot go
    through the stroked path used by every other icon.
*/
const ROBLOX_MARK = "M120.5,271.7c-110.9-28.6-120-31-119.9-31.5 C0.7,239.6,62.1,0.5,62.2,0.4c0,0,54,13.8,119.9,30.8s120,30.8,120.1,30.8c0.2,0,0.2,0.4,0.1,0.9c-0.2,1.5-61.5,239.3-61.7,239.5 C240.6,302.5,186.5,288.7,120.5,271.7z M174.9,158c3.2-12.6,5.9-23.1,6-23.4c0.1-0.5-2.3-1.2-23.2-6.6c-12.8-3.3-23.5-5.9-23.6-5.8 c-0.3,0.3-12.1,46.6-12,46.7c0.2,0.2,46.7,12.2,46.8,12.1C168.9,180.9,171.6,170.6,174.9,158L174.9,158z";

function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    if (name === "roblox") {
        svg.setAttribute("viewBox", "0 0 302.7 302.7");
        const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
        mark.setAttribute("d", ROBLOX_MARK);
        mark.setAttribute("fill", "currentColor");
        mark.setAttribute("fill-rule", "evenodd");
        svg.append(mark);
        return svg;
    }

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
        more.addEventListener("click", () => { pickerExpanded = !pickerExpanded; refreshPicker(); });
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

/*
    Theme presets imported from WEAO (https://weao.xyz).

    WEAO's tokens are mostly translucent, layered over the page background. The
    launcher paints with solid colours and derives its own translucency from
    `glass`, so each token is composited over its theme's background here rather
    than carried across as rgba.
*/
const WEAO_PRESETS = [
    { id: "dark", name: "Dark", theme: { background: "#1a1a1a", surface: "#1a1a1a", glass: "#ffffff", text: "#ffffff", description: "#767676", buttons: "#a3a3a3", inputs: "#d1d1d1", accent: "#3bea57", loading: "#3bea57", danger: "#ec3b47" } },
    { id: "light", name: "Light", theme: { background: "#f5f5f5", surface: "#ffffff", glass: "#121212", text: "#121212", description: "#939393", buttons: "#626262", inputs: "#313131", accent: "#3bea57", loading: "#3bea57", danger: "#ec3b47" } },
    { id: "revision", name: "Revision", theme: { background: "#0f0f14", surface: "#0f0f14", glass: "#e0e0e0", text: "#e0e0e0", description: "#636366", buttons: "#8c8c8e", inputs: "#b6b6b7", accent: "#3bea57", loading: "#3bea57", danger: "#ec3b47" } },
    { id: "voxlis", name: "voxlis.NET", theme: { background: "#000000", surface: "#000000", glass: "#ffffff", text: "#ffffff", description: "#666666", buttons: "#999999", inputs: "#cccccc", accent: "#dc2626", loading: "#dc2626", danger: "#dc2626" } },
    { id: "pulsery", name: "Pulsery", theme: { background: "#0a0a0f", surface: "#0a0a0f", glass: "#ffffff", text: "#ffffff", description: "#6c6c6f", buttons: "#9d9d9f", inputs: "#cececf", accent: "#6366f1", loading: "#6366f1", danger: "#6366f1" } },
    { id: "amoled", name: "Amoled", theme: { background: "#000000", surface: "#000000", glass: "#ffffff", text: "#ffffff", description: "#535353", buttons: "#7d7d7d", inputs: "#a6a6a6", accent: "#808080", loading: "#808080", danger: "#808080" } },
    { id: "kyoto", name: "Kyoto", theme: { background: "#171821", surface: "#171821", glass: "#d1d9f9", text: "#d1d9f9", description: "#333440", buttons: "#414350", inputs: "#4f515f", accent: "#b8bed7", loading: "#d1d9f9", danger: "#d1d9f9" } },
    { id: "sirmeme", name: "Sirmeme", theme: { background: "#000000", surface: "#000000", glass: "#ffffff", text: "#ffffff", description: "#666666", buttons: "#999999", inputs: "#cccccc", accent: "#ff00d8", loading: "#ff00d8", danger: "#35ff03" } },
    { id: "ball20", name: "Ball 2.0", theme: { background: "#ffffff", surface: "#ffffff", glass: "#000000", text: "#000000", description: "#999999", buttons: "#666666", inputs: "#333333", accent: "#000000", loading: "#000000", danger: "#000000" } },
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

/* ── Reactive bindings ──────────────────────────────────────── */

/*
    Settings rows used to be thrown away and rebuilt on every click, which reset
    the scroll position, replayed entrance animations and made a toggle feel like
    the whole app blinked. Instead each row registers a small `apply` closure
    that reads current state and mutates only its own DOM. A change runs every
    closure for the visible tab — cheap, and nothing is destroyed.

    Cleared whenever the pane is genuinely rebuilt (tab switch).
*/
let bindings = [];

function bind(apply) {
    bindings.push(apply);
    apply();
}

function syncUI() {
    for (const apply of bindings) apply();
}

/* ── Row builders ───────────────────────────────────────────── */

function row(title, desc, control, { disabled = false, when = null, dim = null } = {}) {
    const el = document.createElement("div");
    el.className = "row" + (disabled ? " row--disabled" : "");

    // `when` rows stay in the DOM and collapse instead of being added and
    // removed, so showing one can animate rather than pop.
    if (when) {
        bind(() => {
            const show = when();
            if (show === !el.classList.contains("row--collapsed")) return;
            el.classList.toggle("row--collapsed", !show);
        });
    }

    if (dim) bind(() => el.classList.toggle("row--disabled", dim()));

    const text = document.createElement("div");
    text.className = "row__text";

    const heading = document.createElement("div");
    heading.className = "row__title";
    heading.textContent = title;
    text.append(heading);

    // An empty string still creates the element — callers that fill it from a
    // binding need something to write into. Only `null` omits it entirely.
    if (desc !== null && desc !== undefined) {
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

/* Wrap a control so it can collapse in place instead of being removed. */
function collapsible(node, when) {
    const holder = document.createElement("span");
    holder.className = "collapsible";
    holder.append(node);
    bind(() => holder.classList.toggle("collapsible--hidden", !when()));
    return holder;
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

    // A function keeps the control honest when something else changes it —
    // a reset, or the backend rejecting the write.
    const read = typeof checked === "function" ? checked : () => checked;
    bind(() => { input.checked = Boolean(read()); });

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
    const read = typeof value === "function" ? value : () => value;

    if (!unit) {
        const input = document.createElement("input");
        input.className = "field field--num";
        input.type = "text";
        input.inputMode = "numeric";
        input.style.width = `${width}px`;
        // Never overwrite what someone is halfway through typing.
        bind(() => { if (document.activeElement !== input) input.value = read() ?? ""; });
        input.addEventListener("change", () => onChange(input.value.trim()));
        return input;
    }

    const wrap = document.createElement("span");
    wrap.className = "numgroup";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    bind(() => { if (document.activeElement !== input) input.value = read() ?? ""; });
    input.addEventListener("change", () => onChange(input.value.trim()));
    const unitEl = document.createElement("span");
    unitEl.className = "unit";
    unitEl.textContent = unit;
    wrap.append(input, unitEl);
    return wrap;
}

/*
    Custom dropdown. The native <select> can't be styled to match the rest of the
    panel, and its popup ignores the app's theme entirely.

    The menu is portalled to <body> with fixed positioning: the settings pane is
    an overflow container, so a menu nested inside it would be clipped by the
    first row it tried to overlap.
*/
let openMenu = null;

function closeOpenMenu() {
    if (!openMenu) return;
    const { menu, control } = openMenu;
    openMenu = null;
    control.dataset.open = "false";
    control.setAttribute("aria-expanded", "false");
    menu.classList.add("dd__menu--closing");
    menu.addEventListener("animationend", () => menu.remove(), { once: true });
    // Belt and braces: if the animation never fires, still clean up.
    setTimeout(() => menu.remove(), 300);
}

document.addEventListener("pointerdown", (event) => {
    if (!openMenu) return;
    if (openMenu.menu.contains(event.target) || openMenu.control.contains(event.target)) return;
    closeOpenMenu();
});
document.addEventListener("keydown", (event) => {
    if (openMenu && event.key === "Escape") {
        event.stopPropagation();
        closeOpenMenu();
    }
});
// A scrolling pane would leave the menu floating over the wrong row.
window.addEventListener("scroll", () => closeOpenMenu(), true);
window.addEventListener("resize", () => closeOpenMenu());

function select(options, value, onChange) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "dd";
    control.dataset.open = "false";
    control.setAttribute("aria-haspopup", "listbox");
    control.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "dd__label";

    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("class", "dd__chevron");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 6.5 8 10.5 12 6.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    chevron.append(path);

    control.append(label, chevron);

    const read = typeof value === "function" ? value : () => value;
    bind(() => {
        const current = read();
        const match = options.find((option) => option.value === current);
        label.textContent = match ? match.label : String(current ?? "");
    });

    control.addEventListener("click", () => {
        if (openMenu && openMenu.control === control) {
            closeOpenMenu();
            return;
        }
        closeOpenMenu();

        const menu = document.createElement("div");
        menu.className = "dd__menu";
        menu.setAttribute("role", "listbox");

        const current = read();
        for (const option of options) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "dd__opt";
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option.value === current));
            item.textContent = option.label;
            item.addEventListener("click", () => {
                closeOpenMenu();
                if (option.value !== read()) onChange(option.value);
            });
            menu.append(item);
        }

        document.body.append(menu);

        // Position under the control, flipping above when there isn't room.
        const rect = control.getBoundingClientRect();
        const height = menu.offsetHeight;
        const below = window.innerHeight - rect.bottom;
        const flip = below < height + 12 && rect.top > height + 12;

        menu.style.minWidth = `${Math.max(rect.width, 150)}px`;
        menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 10)}px`;
        menu.style.top = flip ? `${rect.top - height - 6}px` : `${rect.bottom + 6}px`;
        if (flip) menu.classList.add("dd__menu--above");

        control.dataset.open = "true";
        control.setAttribute("aria-expanded", "true");
        openMenu = { menu, control };
    });

    return control;
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

/*
    Apply a settings change without tearing the panel down.

    The control the user just touched already shows the new value, so the local
    copy is updated first and the bound closures refresh anything that depends on
    it. Only if the backend rejects the write does anything visibly move — the
    previous state is restored and the reason surfaced.
*/
async function patch(changes) {
    const previous = structuredClone(snap.settings);
    Object.assign(snap.settings, changes);

    syncUI();
    renderMain();

    try {
        snap = await invoke("apply_settings", { settings: snap.settings });
    } catch (err) {
        snap.settings = previous;
        toast(String(err), "bad");
    }

    syncUI();
    renderMain();
}

async function patchProfile(changes) {
    const current = profile();
    if (!current) return;

    const previous = structuredClone(current);
    Object.assign(current, changes);

    syncUI();
    renderMain();
    // The picker's contents genuinely change shape when a sync is set or
    // cleared (the unselected pills disappear), so it is rebuilt in place.
    refreshPicker();

    try {
        snap.settings = await invoke("update_profile", { profile: { ...current } });
    } catch (err) {
        Object.assign(current, previous);
        toast(String(err), "bad");
    }

    syncUI();
    renderMain();
    refreshPicker();
}

/* Rebuild just the exploit pills, leaving the rest of the pane untouched. */
let pickerHostEl = null;
function refreshPicker() {
    if (!pickerHostEl || !pickerHostEl.isConnected) return;
    pickerHostEl.replaceChildren();
    renderExploitPicker(pickerHostEl);
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
    closeOpenMenu();

    // A genuine rebuild: drop the old closures so they can't outlive their DOM.
    bindings = [];
    pickerHostEl = null;

    const pane = $("settingsPane");
    pane.replaceChildren();

    const s = snap.settings;
    const p = profile();

    if (activeTab === "launch") {
        pane.append(row(
            "Roblox Bootstrapper",
            "Automatically downloads and updates the Roblox client",
            toggle(() => snap.settings.bootstrapper, (v) => patch({ bootstrapper: v }))
        ));

        pane.append(groupLabel("Version options"));

        /* Exploit sync — the same pill picker the website uses. */
        const pickerHost = document.createElement("div");
        pickerHost.className = "epills";
        pickerHostEl = pickerHost;
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
            toggle(() => snap.settings.use_roblox_cdn, (v) => patch({ use_roblox_cdn: v }))
        ));

        pane.append(row(
            "Studio Bootstrapper",
            "Automatically downloads and updates Roblox Studio",
            toggle(() => snap.settings.studio_bootstrapper, (v) => patch({ studio_bootstrapper: v }))
        ));

        pane.append(row(
            "Multi instance",
            "Allows the launcher to open multiple Roblox clients",
            toggle(() => snap.settings.multi_instance, (v) => patch({ multi_instance: v }))
        ));

        pane.append(row(
            "Prompt on new instance",
            "Confirm before launching when Roblox is already running",
            toggle(() => snap.settings.prompt_on_new_instance, (v) => patch({ prompt_on_new_instance: v }))
        ));

        pane.append(row(
            "Launch delay",
            "Wait before launching the Roblox client",
            [
                collapsible(
                    numberField(() => snap.settings.launch_delay_seconds,
                        (v) => patch({ launch_delay_seconds: Math.max(0, parseInt(v, 10) || 0) }), { unit: "sec" }),
                    () => snap.settings.launch_delay_enabled
                ),
                toggle(() => snap.settings.launch_delay_enabled, (v) => patch({ launch_delay_enabled: v })),
            ]
        ));

        pane.append(row(
            "Notify on launch",
            "Show a Windows notification with the Roblox process ID on launch",
            toggle(() => snap.settings.notify_on_launch, (v) => patch({ notify_on_launch: v }))
        ));

        pane.append(groupLabel("Startup"));

        pane.append(row(
            "Launch on Startup",
            "Start santi.weblauncher automatically when you sign in to Windows",
            toggle(() => snap.settings.launch_on_startup, (v) => patch({ launch_on_startup: v }))
        ));

        // Only meaningful while autostart is on, so it collapses when it is not.
        pane.append(row(
            "Start in Tray",
            "When Windows starts it, come up hidden in the system tray",
            toggle(() => snap.settings.start_in_tray, (v) => patch({ start_in_tray: v })),
            { when: () => snap.settings.launch_on_startup }
        ));

        pane.append(groupLabel("Channel"));

        pane.append(row(
            "Pin the release channel",
            "Holds Roblox on one channel and re-applies it before every launch",
            toggle(() => snap.settings.pin_channel, (v) => patch({ pin_channel: v }))
        ));

        const channelInput = document.createElement("input");
        channelInput.className = "field field--wide";
        channelInput.spellcheck = false;
        bind(() => {
            if (document.activeElement !== channelInput) channelInput.value = snap.settings.pinned_channel;
        });
        channelInput.addEventListener("change", () => patch({ pinned_channel: channelInput.value.trim() || "LIVE" }));
        pane.append(row(
            "Channel",
            "Which channel to hold Roblox on. LIVE means production.",
            channelInput,
            { when: () => snap.settings.pin_channel }
        ));
        return;
    }

    if (activeTab === "roblox") {
        pane.append(row(
            "FPS cap",
            "Limit the Roblox client frame rate",
            [
                collapsible(
                    numberField(() => snap.settings.fps_cap,
                        (v) => patch({ fps_cap: Math.max(1, parseInt(v, 10) || 60) }), { unit: "fps" }),
                    () => snap.settings.fps_cap_enabled
                ),
                toggle(() => snap.settings.fps_cap_enabled, (v) => patch({ fps_cap_enabled: v })),
            ]
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
                () => snap.settings.server_mode || "default",
                (v) => patch({ server_mode: v })
            )
        ));

        pane.append(groupLabel("Activity"));

        pane.append(row(
            "Activity Watcher",
            "Read Roblox's log files to track your current game session",
            toggle(() => snap.settings.activity_watcher, (v) => patch({ activity_watcher: v }))
        ));

        pane.append(row(
            "Discord Rich Presence",
            "Show the game you're in on your Discord profile",
            toggle(() => snap.settings.discord_rpc, (v) => patch({ discord_rpc: v })),
            { dim: () => !snap.settings.activity_watcher }
        ));

        pane.append(row(
            "Show join buttons",
            'Add a "See game page" button to your presence',
            toggle(() => snap.settings.show_join_buttons, (v) => patch({ show_join_buttons: v })),
            { dim: () => !snap.settings.activity_watcher || !snap.settings.discord_rpc }
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
        const statusRow = (title, ours, registered) => {
            const dot = statusDot("off");
            const el = row(title, "", dot);
            const caption = el.querySelector(".row__desc");
            bind(() => {
                const mine = ours();
                const any = registered();
                caption.textContent = mine
                    ? "Registered to this launcher"
                    : any ? "Another bootstrapper is registered" : "Not registered";
                dot.dataset.tone = mine ? "ok" : any ? "warn" : "off";
            });
            return el;
        };

        pane.append(statusRow(
            "Registration status",
            () => snap.protocol.player_ours,
            () => snap.protocol.player_registered
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

        pane.append(statusRow(
            "Studio Registration status",
            () => snap.protocol.studio_ours,
            () => snap.protocol.studio_registered
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
        pane.append(groupLabel("Presets"));

        const presetRow = document.createElement("div");
        presetRow.className = "presets";

        for (const preset of WEAO_PRESETS) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "preset";

            const dots = document.createElement("span");
            dots.className = "preset__dots";
            for (const colour of [preset.theme.background, preset.theme.surface, preset.theme.accent, preset.theme.danger]) {
                const dot = document.createElement("i");
                dot.style.background = colour;
                dots.append(dot);
            }

            const label = document.createElement("span");
            label.textContent = preset.name;
            chip.append(dots, label);

            // A preset only sets colours — grid, scale and background image
            // are the user's own choices and are left alone.
            bind(() => {
                const t = snap.settings.theme;
                const match = Object.entries(preset.theme).every(([k, v]) => t[k] === v);
                chip.setAttribute("aria-pressed", String(match));
            });

            chip.addEventListener("click", () => setTheme({ ...preset.theme }));
            presetRow.append(chip);
        }

        pane.append(presetRow);
        pane.append(groupLabel("Colors"));

        for (const [key, title, desc] of THEME_KEYS) {
            const swatch = document.createElement("button");
            swatch.className = "swatch";

            const picker = document.createElement("input");
            picker.type = "color";
            swatch.append(picker);
            swatch.addEventListener("click", () => picker.click());

            const hex = document.createElement("input");
            hex.className = "field hex";
            hex.spellcheck = false;

            bind(() => {
                const current = snap.settings.theme[key];
                swatch.style.background = current;
                picker.value = current;
                if (document.activeElement !== hex) hex.value = current;
            });

            const commit = (value) => {
                if (!/^#[0-9a-f]{6}$/i.test(value)) { hex.value = snap.settings.theme[key]; return; }
                setTheme({ [key]: value.toLowerCase() });
            };
            picker.addEventListener("change", () => commit(picker.value));
            hex.addEventListener("change", () => commit(hex.value.trim()));

            pane.append(row(title, desc, [swatch, hex]));
        }

        pane.append(row(
            "Grid overlay",
            "Show dot-grid texture on background",
            toggle(() => snap.settings.theme.grid_overlay, (v) => setTheme({ grid_overlay: v }))
        ));

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "slider";
        slider.min = "80"; slider.max = "140"; slider.step = "5";
        const scaleLabel = document.createElement("span");
        scaleLabel.className = "tag";
        bind(() => {
            if (document.activeElement !== slider) slider.value = String(snap.settings.theme.ui_scale);
            scaleLabel.textContent = `${snap.settings.theme.ui_scale}%`;
        });
        slider.addEventListener("input", () => { scaleLabel.textContent = `${slider.value}%`; });
        slider.addEventListener("change", () => setTheme({ ui_scale: Number(slider.value) }));
        pane.append(row("UI scale", "Make text and controls larger", [slider, scaleLabel]));

        const bgRow = row(
            "Background image",
            "None",
            [
                button("Browse", async () => {
                    const file = await openDialog({
                        multiple: false,
                        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
                    });
                    if (file) setTheme({ background_image: file });
                }),
                collapsible(
                    button("Clear", () => setTheme({ background_image: null })),
                    () => Boolean(snap.settings.theme.background_image)
                ),
            ]
        );
        const bgCaption = bgRow.querySelector(".row__desc");
        bind(() => { bgCaption.textContent = snap.settings.theme.background_image || "None"; });
        pane.append(bgRow);

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
            toggle(() => snap.settings.auto_check_updates, (v) => patch({ auto_check_updates: v }))
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
            // The custom-flag list changes length, so this pane is rebuilt.
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
        syncUI();
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
    const previous = structuredClone(snap.settings.theme);
    const next = changes === null ? defaultTheme() : { ...snap.settings.theme, ...changes };

    // Paint immediately; a colour picker that lags behind the swatch feels broken.
    snap.settings.theme = next;
    applyTheme();
    syncUI();

    try {
        snap.settings = await invoke("set_theme", { theme: next });
    } catch (err) {
        snap.settings.theme = previous;
        toast(String(err), "bad");
    }

    applyTheme();
    syncUI();
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
        syncUI();
        refreshPicker();
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
let pendingUpdate = null;

function showUpdateModal(update) {
    pendingUpdate = update;

    $("updateFrom").textContent = `v${snap.app_version}`;
    $("updateTo").textContent = `v${update.version}`;
    $("updateNotes").textContent = (update.body || "").trim() || "No release notes were provided.";
    $("updateBadge").textContent = "Update";
    $("updateTitle").textContent = "A new version is available";

    $("updateProgress").hidden = true;
    $("updateFill").style.width = "0%";
    $("updateLater").hidden = false;
    $("updateNow").hidden = false;
    $("updateNow").disabled = false;
    $("updateNow").textContent = "Install and restart";

    $("updateModal").hidden = false;
}

function hideUpdateModal() {
    $("updateModal").hidden = true;
    pendingUpdate = null;
}

$("updateLater").addEventListener("click", hideUpdateModal);

$("updateNow").addEventListener("click", async () => {
    if (!pendingUpdate) return;

    $("updateNow").disabled = true;
    $("updateNow").textContent = "Installing…";
    $("updateLater").hidden = true;
    $("updateProgress").hidden = false;

    let total = 0;
    let received = 0;

    try {
        await pendingUpdate.downloadAndInstall((event) => {
            if (event.event === "Started") {
                total = event.data.contentLength || 0;
                $("updateStatus").textContent = total
                    ? `Downloading ${(total / 1048576).toFixed(1)} MB…`
                    : "Downloading…";
            } else if (event.event === "Progress") {
                received += event.data.chunkLength || 0;
                // Without a content length there's nothing honest to show, so
                // the bar creeps rather than pretending to know.
                const pct = total ? Math.min((received / total) * 100, 100) : Math.min(received / 40000, 90);
                $("updateFill").style.width = `${pct}%`;
            } else if (event.event === "Finished") {
                $("updateFill").style.width = "100%";
                $("updateStatus").textContent = "Restarting…";
            }
        });

        await window.__TAURI__.process.relaunch();
    } catch (err) {
        $("updateProgress").hidden = true;
        $("updateBadge").textContent = "Failed";
        $("updateTitle").textContent = "Update failed";
        $("updateNotes").textContent = String(err);
        $("updateLater").hidden = false;
        $("updateLater").textContent = "Close";
        $("updateNow").disabled = false;
        $("updateNow").textContent = "Try again";
    }
});

/*
    Signed updates via the Tauri updater. The manifest lives on
    rdd.xocat.online and each installer is minisign-signed, so an update can
    only install if it was built with our private key.

    `interactive` distinguishes the Advanced-tab button (which should say
    something either way) from the startup check (which only speaks up when
    there is genuinely an update).
*/
async function checkForUpdate(btn, interactive) {
    const { check } = window.__TAURI__.updater;
    const setLabel = (text) => { if (btn) btn.textContent = text; };

    try {
        setLabel("Checking…");
        const update = await check();
        setLabel("Check");

        if (!update) {
            if (interactive) toast(`You're on the latest version (v${snap.app_version})`, "ok");
            return;
        }

        showUpdateModal(update);
    } catch (err) {
        setLabel("Check");
        if (interactive) toast(`Update check failed: ${err}`, "bad");
    }
}

/* ── Activity ───────────────────────────────────────────────── */

listen("activity", (event) => {
    session = event.payload || null;
    renderMain();
    // The Roblox tab shows what is playing, and that row appears/disappears.
    if (activeTab === "roblox" && !$("settings").hidden) renderSettings();
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
        // Quiet unless there is actually something to install, in which
        // case the modal appears on its own.
        checkForUpdate(null, false);
    }
})();
