import { PROVIDERS } from "./lib/providers.js";
import { CONTEXT_TEMPLATE } from "./lib/context-template.js";

const $ = (id) => document.getElementById(id);
const CUSTOM = "__custom__";
let settings = { provider: "anthropic", keys: {}, models: {}, customBaseUrl: "", modelLists: {} };

function flash(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  if (text) setTimeout(() => { el.textContent = ""; }, 5000);
}

// ================= provider + model select =================

for (const p of Object.values(PROVIDERS)) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  $("provider").appendChild(opt);
}

function currentProvider() {
  return PROVIDERS[$("provider").value];
}

function fillModelSelect(models, selectedModel) {
  const sel = $("model");
  sel.innerHTML = "";
  const list = [...new Set(models)];
  if (selectedModel && !list.includes(selectedModel)) list.unshift(selectedModel);
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = CUSTOM;
  custom.textContent = "Custom…";
  sel.appendChild(custom);
  sel.value = list.includes(selectedModel) ? selectedModel : list[0] ?? CUSTOM;
  $("modelCustom").hidden = sel.value !== CUSTOM;
}

function renderProviderFields() {
  const p = currentProvider();
  $("apiKey").value = settings.keys[p.id] || "";
  $("baseUrlWrap").hidden = !p.needsBaseUrl;
  $("baseUrl").value = settings.customBaseUrl || "";
  $("keyLink").hidden = !p.keyUrl;
  if (p.keyUrl) $("keyLink").href = p.keyUrl;
  const known = settings.modelLists?.[p.id]?.length ? settings.modelLists[p.id] : p.fallbackModels;
  fillModelSelect(known, settings.models[p.id] || p.defaultModel);
}

$("provider").addEventListener("change", renderProviderFields);

$("model").addEventListener("change", () => {
  $("modelCustom").hidden = $("model").value !== CUSTOM;
  if ($("model").value === CUSTOM) $("modelCustom").focus();
});

async function fetchModels() {
  const p = currentProvider();
  const apiKey = $("apiKey").value.trim();
  if (!apiKey && p.id !== "openrouter") {
    return flash($("modelStatus"), "Enter your API key first, then fetch.", true);
  }
  flash($("modelStatus"), "Fetching models…");
  try {
    const models = await p.listModels({ apiKey, baseUrl: $("baseUrl").value.trim() });
    if (!models.length) throw new Error("Provider returned an empty model list.");
    settings.modelLists[p.id] = models;
    fillModelSelect(models, selectedModelValue() || settings.models[p.id] || p.defaultModel);
    flash($("modelStatus"), `${models.length} models loaded.`);
  } catch (err) {
    flash($("modelStatus"), err.message, true);
  }
}
$("refreshModels").addEventListener("click", fetchModels);
// Auto-fetch once a key is pasted, so the dropdown is real without extra clicks.
$("apiKey").addEventListener("change", () => {
  if ($("apiKey").value.trim()) fetchModels();
});

function selectedModelValue() {
  return $("model").value === CUSTOM ? $("modelCustom").value.trim() : $("model").value;
}

$("saveSettings").addEventListener("click", async () => {
  const p = currentProvider();
  const model = selectedModelValue();
  if (!model) return flash($("settingsStatus"), "Pick or enter a model.", true);
  settings.provider = p.id;
  settings.keys[p.id] = $("apiKey").value.trim();
  settings.models[p.id] = model;

  if (p.needsBaseUrl) {
    const baseUrl = $("baseUrl").value.trim();
    if (!baseUrl) return flash($("settingsStatus"), "Custom provider needs a base URL.", true);
    settings.customBaseUrl = baseUrl;
    try {
      const origin = new URL(baseUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return flash($("settingsStatus"), "Permission for that host was declined.", true);
    } catch {
      return flash($("settingsStatus"), "That base URL doesn't look valid.", true);
    }
  }

  await chrome.storage.local.set({ settings });
  flash($("settingsStatus"), "Saved.");
});

// ================= founder context form =================

const SKIP_KEYS = new Set(["schema_version", "answer_history", "applications"]);
const PROSE_FIELDS = new Set([
  "problem", "solution", "why_now", "why_us", "background", "technical_background",
  "founder_story", "market_problem", "market_size", "market_trends",
  "competitive_advantage", "description", "how_it_works", "security",
  "use_of_funds", "program_goals", "ideal_customer_profile", "target_customer"
]);

let ctx = structuredClone(CONTEXT_TEMPLATE);

const isFact = (v) => v && typeof v === "object" && !Array.isArray(v) && "value" in v && "verified" in v;
const title = (k) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const today = () => new Date().toISOString().slice(0, 10);

function getAt(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj, path, val) {
  let node = obj;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]] ??= (typeof path[i + 1] === "number" ? [] : {});
  node[path[path.length - 1]] = val;
}

// Merge stored data over the template shape, upgrading plain scalars to fact
// leaves where the template expects one.
function normalize(stored) {
  const merged = structuredClone(CONTEXT_TEMPLATE);
  function walk(tpl, src, out) {
    for (const [k, tplVal] of Object.entries(tpl)) {
      const srcVal = src?.[k];
      if (srcVal === undefined) continue;
      if (isFact(tplVal)) {
        out[k] = isFact(srcVal)
          ? { value: srcVal.value, verified: !!srcVal.verified, updated: srcVal.updated || "" }
          : { value: srcVal, verified: false, updated: "" };
      } else if (k === "founders" && Array.isArray(srcVal)) {
        out[k] = srcVal.map((f) => ({ ...structuredClone(tpl[k][0]), ...f }));
      } else if (Array.isArray(tplVal)) {
        out[k] = Array.isArray(srcVal) ? srcVal : [];
      } else if (tplVal && typeof tplVal === "object") {
        walk(tplVal, srcVal, out[k]);
      } else {
        out[k] = srcVal;
      }
    }
  }
  walk(CONTEXT_TEMPLATE, stored || {}, merged);
  merged.answer_history = stored?.answer_history || [];
  return merged;
}

function fieldRow(labelText, inputEl) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.append(label, inputEl);
  return wrap;
}

function makeInput(path, value) {
  const key = path[path.length - 1];
  let el;
  if (typeof value === "boolean") {
    el = document.createElement("input");
    el.type = "checkbox";
    el.checked = value;
    el.className = "check";
  } else if (typeof value === "number") {
    el = document.createElement("input");
    el.type = "number";
    el.value = value || "";
  } else if (PROSE_FIELDS.has(key)) {
    el = document.createElement("textarea");
    el.rows = 3;
    el.value = value ?? "";
  } else {
    el = document.createElement("input");
    el.type = "text";
    el.value = value ?? "";
  }
  el.dataset.path = JSON.stringify(path);
  return el;
}

function makeFactRow(path, fact) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = title(path[path.length - 1]);
  const row = document.createElement("div");
  row.className = "fact-row";

  const input = makeInput([...path, "value"], fact.value);
  const verifiedLabel = document.createElement("label");
  verifiedLabel.className = "chip-toggle";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = !!fact.verified;
  check.dataset.path = JSON.stringify([...path, "verified"]);
  verifiedLabel.append(check, document.createTextNode(" verified"));

  const updated = document.createElement("span");
  updated.className = "muted small";
  updated.textContent = fact.updated ? `updated ${fact.updated}` : "";
  // Stamp today's date when the value changes.
  input.addEventListener("input", () => {
    input.dataset.dirty = "1";
    updated.textContent = `updated ${today()}`;
  });

  row.append(input, verifiedLabel, updated);
  wrap.append(label, row);
  return wrap;
}

function makeListInput(path, arr) {
  const el = document.createElement("textarea");
  el.rows = Math.min(4, Math.max(2, arr.length + 1));
  el.placeholder = "one per line";
  el.value = (arr || []).join("\n");
  el.dataset.path = JSON.stringify(path);
  el.dataset.list = "1";
  return fieldRow(title(path[path.length - 1]), el);
}

function buildSection(container, obj, basePath) {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...basePath, k];
    if (isFact(v)) container.appendChild(makeFactRow(path, v));
    else if (Array.isArray(v)) container.appendChild(makeListInput(path, v));
    else if (v && typeof v === "object") buildSection(container, v, path); // flatten nested objects
    else container.appendChild(fieldRow(title(k), makeInput(path, v)));
  }
}

function buildFounderCard(founder, index) {
  const card = document.createElement("div");
  card.className = "founder-card";
  const head = document.createElement("div");
  head.className = "founder-head";
  const h = document.createElement("strong");
  h.textContent = `Founder ${index + 1}`;
  const remove = document.createElement("button");
  remove.textContent = "Remove";
  remove.className = "slim danger";
  remove.addEventListener("click", () => {
    readFormIntoCtx();
    ctx.founders.splice(index, 1);
    if (ctx.founders.length === 0) ctx.founders.push(structuredClone(CONTEXT_TEMPLATE.founders[0]));
    buildForm();
  });
  head.append(h, remove);
  card.appendChild(head);
  buildSection(card, founder, ["founders", index]);
  return card;
}

// ---------- pagination ----------

const STEPS = Object.keys(CONTEXT_TEMPLATE).filter((k) => !SKIP_KEYS.has(k));
let step = 0;

function goToStep(i) {
  readFormIntoCtx();
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  buildForm();
}

$("prevStep").addEventListener("click", () => goToStep(step - 1));
$("nextStep").addEventListener("click", () => goToStep(step + 1));

function sectionFilled(sectionKey) {
  const v = ctx[sectionKey];
  const flat = JSON.stringify(v);
  // crude but effective: a section counts as started if any non-default scalar is present
  return /:(?:"(?!")[^"]|[1-9]|true)/.test(flat.replace(/"verified":(true|false)/g, "").replace(/"updated":"[^"]*"/g, ""));
}

function renderStepNav() {
  const nav = $("stepNav");
  nav.innerHTML = "";
  STEPS.forEach((key, i) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill" + (i === step ? " active" : "") + (sectionFilled(key) ? " filled" : "");
    pill.textContent = title(key);
    pill.addEventListener("click", () => goToStep(i));
    nav.appendChild(pill);
  });
  $("stepLabel").textContent = `Step ${step + 1} of ${STEPS.length}`;
  $("prevStep").disabled = step === 0;
  $("nextStep").disabled = step === STEPS.length - 1;
}

function buildForm() {
  renderStepNav();
  const root = $("contextForm");
  root.innerHTML = "";
  const sectionKey = STEPS[step];
  const sectionVal = ctx[sectionKey];

  const fs = document.createElement("fieldset");
  fs.className = "card";
  const legend = document.createElement("legend");
  legend.textContent = title(sectionKey);
  fs.appendChild(legend);

  if (sectionKey === "founders") {
    sectionVal.forEach((f, i) => fs.appendChild(buildFounderCard(f, i)));
    const add = document.createElement("button");
    add.textContent = "+ Add founder";
    add.className = "slim";
    add.addEventListener("click", () => {
      readFormIntoCtx();
      ctx.founders.push(structuredClone(CONTEXT_TEMPLATE.founders[0]));
      buildForm();
    });
    fs.appendChild(add);
  } else {
    buildSection(fs, sectionVal, [sectionKey]);
  }
  root.appendChild(fs);
  renderApps();
  syncJsonEditor();
}

function readFormIntoCtx() {
  for (const el of $("contextForm").querySelectorAll("[data-path]")) {
    const path = JSON.parse(el.dataset.path);
    let val;
    if (el.dataset.list) {
      val = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    } else if (el.type === "checkbox") {
      val = el.checked;
    } else if (el.type === "number") {
      val = el.value === "" ? 0 : Number(el.value);
    } else {
      val = el.value;
    }
    setAt(ctx, path, val);
    // Fact value edited -> stamp updated date.
    if (el.dataset.dirty && path[path.length - 1] === "value") {
      setAt(ctx, [...path.slice(0, -1), "updated"], today());
    }
  }
}

function syncJsonEditor() {
  $("contextEditor").value = JSON.stringify(ctx, null, 2);
}

// ---------- program discovery ----------

let discover = { enabled: true, intervalHours: 12, custom: [], results: {} };

async function saveDiscover() {
  await chrome.storage.local.set({ discover });
  chrome.runtime.sendMessage({ type: "DISCOVER_SETTINGS_CHANGED" }).catch(() => {});
}

function fmtAge(ts) {
  if (!ts) return "never";
  const h = Math.round((Date.now() - ts) / 3600000);
  return h < 1 ? "just now" : h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function renderDiscover() {
  $("discoverEnabled").checked = discover.enabled !== false;
  $("discoverInterval").value = String(discover.intervalHours || 12);
  const root = $("discoverList");
  root.innerHTML = "";
  const rows = Object.values(discover.results || {});
  rows.sort((a, b) => (b.open === true) - (a.open === true) || (a.deadline || "z").localeCompare(b.deadline || "z"));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "disc-row";
    const status = document.createElement("span");
    status.className = "chip " + (r.error ? "" : r.open ? "status-accepted" : r.closed ? "status-rejected" : "");
    status.textContent = r.error ? "unreachable" : r.open ? "OPEN" : r.closed ? "closed" : "unclear";
    const name = document.createElement("a");
    name.href = r.url; name.target = "_blank"; name.rel = "noreferrer";
    name.textContent = r.name;
    const meta = document.createElement("span");
    meta.className = "muted small";
    meta.textContent = [
      r.deadline ? `deadline ${r.deadline}` : "",
      r.openedAt ? `opened ${fmtAge(r.openedAt)}` : "",
      `checked ${fmtAge(r.lastChecked)}`
    ].filter(Boolean).join(" · ");
    row.append(status, name, meta);

    const tracked = (ctx.applications || []).some((a) =>
      (a.url && a.url === r.url) || (a.program || "").toLowerCase() === r.name.toLowerCase());
    const act = document.createElement("button");
    act.className = "slim";
    if (tracked) { act.textContent = "Tracked ✓"; act.disabled = true; }
    else {
      act.textContent = "Track";
      act.addEventListener("click", () => {
        ctx.applications.push({ ...EMPTY_APP, program: r.name, url: r.url, deadline: r.deadline || "", added: today() });
        renderApps(); persistApps(); renderDiscover();
      });
    }
    row.appendChild(act);

    if ((discover.custom || []).some((c) => (typeof c === "string" ? c : c.url) === r.url)) {
      const rm = document.createElement("button");
      rm.className = "slim danger";
      rm.textContent = "Unwatch";
      rm.addEventListener("click", () => {
        discover.custom = discover.custom.filter((c) => (typeof c === "string" ? c : c.url) !== r.url);
        delete discover.results[r.url];
        saveDiscover(); renderDiscover();
      });
      row.appendChild(rm);
    }
    root.appendChild(row);
  }
  if (!rows.length) {
    root.innerHTML = '<p class="muted">No scan yet — press “Scan now”.</p>';
  }
}

$("discoverEnabled").addEventListener("change", () => {
  discover.enabled = $("discoverEnabled").checked;
  saveDiscover();
});
$("discoverInterval").addEventListener("change", () => {
  discover.intervalHours = Number($("discoverInterval").value);
  saveDiscover();
});
$("addProgram").addEventListener("click", () => {
  const url = $("customProgram").value.trim();
  try { new URL(url); } catch { return flash($("discoverStatus"), "That doesn't look like a URL.", true); }
  discover.custom = discover.custom || [];
  if (!discover.custom.some((c) => (typeof c === "string" ? c : c.url) === url)) discover.custom.push(url);
  $("customProgram").value = "";
  saveDiscover();
  flash($("discoverStatus"), "Watching — scanning now…");
  $("scanNow").click();
});
$("scanNow").addEventListener("click", async () => {
  $("scanNow").disabled = true;
  flash($("discoverStatus"), "Scanning apply pages…");
  try {
    const r = await chrome.runtime.sendMessage({ type: "SCAN_PROGRAMS" });
    discover = (await chrome.storage.local.get("discover")).discover || discover;
    renderDiscover();
    const opens = Object.values(r?.results || {}).filter((x) => x.open).length;
    flash($("discoverStatus"), `Done — ${opens} open now${r?.newlyOpen?.length ? `, newly open: ${r.newlyOpen.join(", ")}` : ""}.`);
  } catch (e) {
    flash($("discoverStatus"), e.message, true);
  } finally {
    $("scanNow").disabled = false;
  }
});

// ---------- application tracker ----------

const APP_STATUSES = ["planning", "in_progress", "submitted", "interview", "accepted", "waitlisted", "rejected"];
const EMPTY_APP = { program: "", status: "planning", applied: "", deadline: "", url: "", notes: "", added: "" };

let appsSaveTimer;
function persistApps() {
  clearTimeout(appsSaveTimer);
  appsSaveTimer = setTimeout(async () => {
    readFormIntoCtx();
    syncJsonEditor();
    await chrome.storage.local.set({ founderContext: ctx });
    renderAppsSummary();
    flash($("appsStatus"), "Saved.");
  }, 400);
}

function answersFor(program) {
  if (!program) return 0;
  return (ctx.answer_history || []).filter(
    (h) => h.program?.toLowerCase() === program.toLowerCase()
  ).length;
}

function renderAppsSummary() {
  const counts = {};
  for (const a of ctx.applications) counts[a.status] = (counts[a.status] || 0) + 1;
  $("appsSummary").innerHTML = "";
  for (const s of APP_STATUSES) {
    if (!counts[s]) continue;
    const chip = document.createElement("span");
    chip.className = `chip status-${s}`;
    chip.textContent = `${title(s)}: ${counts[s]}`;
    $("appsSummary").appendChild(chip);
  }
}

function appField(app, key, type = "text") {
  const el = type === "select" ? document.createElement("select") : document.createElement("input");
  if (type === "select") {
    for (const s of APP_STATUSES) {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = title(s);
      el.appendChild(o);
    }
    el.value = APP_STATUSES.includes(app[key]) ? app[key] : "planning";
  } else {
    el.type = type;
    el.value = app[key] || "";
  }
  el.addEventListener(type === "select" ? "change" : "input", () => {
    app[key] = el.value;
    persistApps();
  });
  return el;
}

function renderApps() {
  ctx.applications = ctx.applications || [];
  const root = $("appsList");
  root.innerHTML = "";
  ctx.applications.forEach((app, i) => {
    const card = document.createElement("div");
    card.className = "app-card";

    const grid = document.createElement("div");
    grid.className = "app-grid";
    const cell = (labelText, el, cls = "") => {
      const w = document.createElement("div");
      if (cls) w.className = cls;
      const l = document.createElement("label");
      l.textContent = labelText;
      w.append(l, el);
      grid.appendChild(w);
    };
    cell("Program", appField(app, "program"), "wide");
    cell("Status", appField(app, "status", "select"));
    cell("Applied", appField(app, "applied", "date"));
    cell("Deadline", appField(app, "deadline", "date"));
    cell("Application URL", appField(app, "url", "url"), "wide");

    const notes = document.createElement("textarea");
    notes.rows = 2;
    notes.placeholder = "private notes — never sent to the LLM";
    notes.value = app.notes || "";
    notes.addEventListener("input", () => { app.notes = notes.value; persistApps(); });
    const notesWrap = document.createElement("div");
    notesWrap.className = "full";
    const notesLabel = document.createElement("label");
    notesLabel.textContent = "Notes";
    notesWrap.append(notesLabel, notes);
    grid.appendChild(notesWrap);

    const foot = document.createElement("div");
    foot.className = "app-foot";
    const meta = document.createElement("span");
    meta.className = "muted small";
    const n = answersFor(app.program);
    meta.textContent = n ? `${n} saved answer${n === 1 ? "" : "s"} for this program` : "no saved answers yet";
    const remove = document.createElement("button");
    remove.className = "slim danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (!confirm(`Remove "${app.program || "this application"}" from the tracker?`)) return;
      ctx.applications.splice(i, 1);
      renderApps();
      persistApps();
    });
    foot.append(meta, remove);

    card.append(grid, foot);
    root.appendChild(card);
  });
  renderAppsSummary();
}

$("addApp").addEventListener("click", () => {
  ctx.applications.push({ ...EMPTY_APP, added: today() });
  renderApps();
  persistApps();
  const cards = $("appsList").querySelectorAll(".app-card");
  cards[cards.length - 1]?.querySelector("input")?.focus();
});

// ---------- pitch deck ingest ----------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1]);
    r.onerror = () => reject(new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

// Flat "dot.path (type)" list for the extraction prompt.
function extractablePaths() {
  const out = [];
  function walk(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (isFact(v)) out.push(`${path} (${typeof v.value === "number" ? "number" : "string"})`);
      else if (k === "founders") {
        for (const [fk, fv] of Object.entries(v[0])) {
          out.push(`founders.0.${fk} (${Array.isArray(fv) ? "list of strings" : "string"}) — use founders.1.*, founders.2.* for more founders`);
        }
      }
      else if (Array.isArray(v)) out.push(`${path} (list of strings)`);
      else if (typeof v === "boolean") out.push(`${path} (true/false)`);
      else if (typeof v === "object" && v !== null) walk(v, path);
      else out.push(`${path} (string)`);
    }
  }
  walk(CONTEXT_TEMPLATE, "");
  return out;
}

const DECK_PROMPT = () => `You are extracting startup facts from a founder's pitch deck to pre-fill a structured profile.

Return ONLY a JSON object mapping flat dot-notation paths to values. Allowed paths (with expected types):

${extractablePaths().join("\n")}

Rules:
- Include ONLY fields the deck clearly supports. Never guess or infer numbers that are not stated.
- Copy numbers and metrics exactly as written in the deck.
- Prose fields (problem, solution, founder_story, …): summarize faithfully in the founder's voice, 1-3 sentences.
- No markdown, no commentary — just the JSON object.`;

const isEmptyVal = (v) =>
  v == null || v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0);

// Merge extracted flat paths into ctx. Never overwrite user-entered data;
// every extracted fact lands unverified.
function mergeExtracted(flat) {
  let applied = 0;
  for (const [pathStr, val] of Object.entries(flat)) {
    if (val == null || val === "") continue;
    const path = pathStr.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const tplPath = path.map((s) => (typeof s === "number" ? 0 : s));
    const tplLeaf = getAt(CONTEXT_TEMPLATE, tplPath);
    if (tplLeaf === undefined) continue; // unknown path — drop it
    // Ensure founders[i] exists.
    if (path[0] === "founders" && typeof path[1] === "number") {
      while (ctx.founders.length <= path[1]) ctx.founders.push(structuredClone(CONTEXT_TEMPLATE.founders[0]));
    }
    if (isFact(tplLeaf)) {
      const cur = getAt(ctx, path);
      if (!isEmptyVal(cur?.value)) continue;
      setAt(ctx, path, { value: val, verified: false, updated: today() });
    } else {
      const cur = getAt(ctx, path);
      if (!isEmptyVal(cur)) continue;
      if (Array.isArray(tplLeaf)) setAt(ctx, path, Array.isArray(val) ? val.map(String) : [String(val)]);
      else if (typeof tplLeaf === "boolean") setAt(ctx, path, !!val);
      else setAt(ctx, path, typeof val === "object" ? JSON.stringify(val) : val);
    }
    applied++;
  }
  return applied;
}

$("uploadDeck").addEventListener("click", () => $("deckPicker").click());
$("deckPicker").addEventListener("change", async () => {
  const file = $("deckPicker").files[0];
  $("deckPicker").value = "";
  if (!file) return;
  const p = currentProvider();
  const apiKey = $("apiKey").value.trim();
  const model = selectedModelValue();
  if (!apiKey) return flash($("deckStatus"), "Add your API key above first — the deck is read with your own model.", true);
  if (!model) return flash($("deckStatus"), "Pick a model above first.", true);
  if (file.size > 30 * 1024 * 1024) return flash($("deckStatus"), "PDF is over 30 MB — export a smaller version.", true);

  readFormIntoCtx();
  $("uploadDeck").disabled = true;
  flash($("deckStatus"), `Reading ${file.name} with ${model}…`);
  try {
    const base64 = await fileToBase64(file);
    const text = await p.interpret({ apiKey, model, baseUrl: $("baseUrl").value.trim(), base64, prompt: DECK_PROMPT() });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The model returned no usable JSON. Try a more capable model.");
    const applied = mergeExtracted(JSON.parse(match[0]));
    buildForm();
    flash($("deckStatus"), `Filled ${applied} empty fields from the deck (all unverified). Review each step, then save.`);
  } catch (err) {
    flash($("deckStatus"), err.message, true);
  } finally {
    $("uploadDeck").disabled = false;
  }
});

// dev hook for automated testing
globalThis.__lore = { mergeExtracted, extractablePaths, get ctx() { return ctx; }, buildForm };

// ---------- import / export / raw JSON ----------

$("importFile").addEventListener("click", () => $("filePicker").click());
$("filePicker").addEventListener("change", async () => {
  const file = $("filePicker").files[0];
  $("filePicker").value = "";
  if (!file) return;
  try {
    ctx = normalize(JSON.parse(await file.text()));
    buildForm();
    flash($("contextStatus"), "Imported — review and save.");
  } catch (err) {
    flash($("contextStatus"), `Import failed: ${err.message}`, true);
  }
});

$("exportFile").addEventListener("click", () => {
  readFormIntoCtx();
  syncJsonEditor();
  const blob = new Blob([JSON.stringify(ctx, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "founder_context.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("applyJson").addEventListener("click", () => {
  try {
    ctx = normalize(JSON.parse($("contextEditor").value));
    buildForm();
    flash($("contextStatus"), "JSON applied to form.");
  } catch (err) {
    flash($("contextStatus"), `Not valid JSON: ${err.message}`, true);
  }
});

$("saveContext").addEventListener("click", async () => {
  readFormIntoCtx();
  syncJsonEditor();
  await chrome.storage.local.set({ founderContext: ctx });
  flash($("contextStatus"), "Context saved.");
});

// Keep answer history + tracker fresh if the side panel writes while this
// page is open (otherwise Save here could clobber those additions).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.founderContext?.newValue) return;
  const nv = changes.founderContext.newValue;
  const changed =
    JSON.stringify(nv.answer_history) !== JSON.stringify(ctx.answer_history) ||
    JSON.stringify(nv.applications) !== JSON.stringify(ctx.applications);
  if (changed) {
    ctx.answer_history = nv.answer_history || [];
    ctx.applications = nv.applications || [];
    renderApps();
  }
});

// ================= init =================

(async () => {
  const stored = await chrome.storage.local.get(["settings", "founderContext"]);
  if (stored.settings) settings = { keys: {}, models: {}, modelLists: {}, ...stored.settings };
  settings.modelLists ??= {};
  $("provider").value = settings.provider || "anthropic";
  renderProviderFields();
  ctx = normalize(stored.founderContext);
  buildForm();
  const d = await chrome.storage.local.get("discover");
  if (d.discover) discover = d.discover;
  renderDiscover();
  // viewing the list clears the NEW badge
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
})();
