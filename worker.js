import { getProvider } from "./lib/providers.js";
import { listPaths, hydrate, parsePathSelection, similarPastAnswers, getAtPath } from "./lib/retrieval.js";
import { factCheck, extractMissing } from "./lib/factcheck.js";
import { DEFAULT_PREFS } from "./lib/context-template.js";

// ---------- setup ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "lore-draft",
    title: "Draft answer with Lore",
    contexts: ["selection"]
  });
  ensureScanAlarm();
});
chrome.runtime.onStartup?.addListener(() => ensureScanAlarm());

// Chrome: toolbar click opens the side panel. Safari has no sidePanel API —
// serve the same page as a toolbar popup instead.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.setPopup({ popup: "sidepanel.html" }).catch?.(() => {});
}

// Heal detection state after a cold start: pages loaded before this worker
// registered may have reported into the void. Ask every tab to rescan.
setTimeout(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "RESCAN" }).catch(() => {});
    }
  } catch { /* ignore */ }
}, 1500);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "lore-draft" || !tab?.id) return;
  await chrome.storage.session.set({ pendingQuestion: info.selectionText || "" });
  if (chrome.sidePanel) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else {
    // Safari: open the same page as the action popup (allowed on user gesture).
    try { await chrome.action.openPopup(); } catch { /* user can click the toolbar icon */ }
  }
});

// ---------- prompts ----------

const SELECT_SYSTEM = `You select which parts of a founder's context file are relevant to a startup application question.
You are given the list of available paths (some marked (empty) — avoid those) and the question.
Respond with ONLY a JSON array of path strings, nothing else. Be generous: include any path that could strengthen the answer.`;

const countWords = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;

function answerSystem(prefs, charLimit, wordLimit) {
  return `You draft answers to accelerator/startup application questions on behalf of a founder, using ONLY the verified founder context provided.

HARD RULES:
- Never invent facts, numbers, metrics, customer names, revenue, partnerships, or credentials not present in the context.
- Facts marked verified:true must be used verbatim — never rounded, inflated, or altered.
- If the question requires information the context does not contain, write [MISSING: what is needed] in its place instead of guessing.
- Write in first person${prefs.first_person ? "" : " only if the context suggests it"}.
- Tone: ${prefs.tone}. No buzzwords, no hype, no filler. Prefer specific numbers over vague claims.
${charLimit ? `- The answer MUST be under ${charLimit} characters. This is a hard form limit.` : ""}
${wordLimit ? `- The answer MUST be under ${wordLimit} words. This is a hard form limit.` : ""}
- If past answers to similar questions are provided, match their voice, but update any facts from the current context.

Respond with ONLY the answer text — no preamble, no quotes, no markdown headings.`;
}

// ---------- pipeline ----------

async function loadState() {
  const { settings, founderContext } = await chrome.storage.local.get(["settings", "founderContext"]);
  if (!settings?.provider) throw new Error("Not configured. Open extension options and add a provider + API key.");
  const provider = getProvider(settings.provider);
  const apiKey = settings.keys?.[settings.provider];
  if (!apiKey) throw new Error(`No API key saved for ${provider.label}. Open extension options.`);
  if (!founderContext) throw new Error("No founder context yet. Open extension options and fill in your context.");
  const model = settings.models?.[settings.provider] || provider.defaultModel;
  if (!model) throw new Error("No model set. Open extension options.");
  return { provider, apiKey, model, baseUrl: settings.customBaseUrl, ctx: founderContext };
}

async function draftAnswer({ question, charLimit, wordLimit, extra, revise }) {
  const { provider, apiKey, model, baseUrl, ctx } = await loadState();
  const prefs = { ...DEFAULT_PREFS, ...(ctx.writing_preferences || {}) };
  const call = (system, user, maxTokens) =>
    provider.complete({ apiKey, model, baseUrl, system, user, maxTokens });

  // Call 1: pick relevant paths (paths only — no values leave the machine here).
  const paths = listPaths(ctx);
  const pathList = paths.map((p) => p.path + (p.empty ? " (empty)" : "")).join("\n");
  const selectionText = await call(
    SELECT_SYSTEM,
    `Available paths:\n${pathList}\n\nQuestion: ${question}`,
    1024
  );
  let selected = parsePathSelection(selectionText, paths.map((p) => p.path));
  if (selected.length === 0) {
    // Fall back to the non-empty paths rather than failing.
    selected = paths.filter((p) => !p.empty).map((p) => p.path);
  }
  // Always anchor with company identity.
  for (const anchor of ["company.name", "company.one_liner"]) {
    if (!selected.includes(anchor)) selected.push(anchor);
  }

  const slice = hydrate(ctx, selected);
  // Applications are retrievable (e.g. "what other programs have you applied to?")
  // but private fields (notes, urls) never leave the machine.
  if (Array.isArray(slice.applications)) {
    slice.applications = slice.applications.map(({ program, status, applied }) => ({ program, status, applied }));
  }
  const past = similarPastAnswers(ctx.answer_history, question);

  // Call 2: draft the answer from the hydrated slice.
  const userMsg = [
    `FOUNDER CONTEXT (the only source of facts):\n${JSON.stringify(slice, null, 2)}`,
    extra
      ? `ADDITIONAL CONTEXT FROM THE FOUNDER FOR THIS ANSWER (founder-verified; follow any guidance in it):\n${extra}`
      : "",
    past.length
      ? `PAST ANSWERS TO SIMILAR QUESTIONS (match this voice):\n${past
          .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
          .join("\n\n")}`
      : "",
    `APPLICATION QUESTION:\n${question}`,
    revise?.answer
      ? `CURRENT DRAFT (possibly hand-edited by the founder — treat its wording as their preference):\n${revise.answer}\n\nREVISION REQUEST FROM THE FOUNDER:\n${revise.instruction || "Improve it."}\n\nRevise the current draft accordingly. All hard rules still apply — no new facts beyond the context above.`
      : ""
  ].filter(Boolean).join("\n\n---\n\n");

  const system = answerSystem(prefs, charLimit, wordLimit);
  let answer = (await call(system, userMsg, 2048)).trim();

  // Enforce limits in code, not by trusting the model to count. One retry.
  const overNow = () =>
    (charLimit && answer.length > charLimit) || (wordLimit && countWords(answer) > wordLimit);
  if (overNow()) {
    const limitText = [
      charLimit ? `${charLimit} characters` : "",
      wordLimit ? `${wordLimit} words` : ""
    ].filter(Boolean).join(" / ");
    answer = (await call(
      system,
      `${userMsg}\n\n---\n\nYour previous draft was ${answer.length} characters / ${countWords(answer)} words — over the limit (${limitText}). Cut it below the limit without changing any facts:\n\n${answer}`,
      2048
    )).trim();
  }

  return {
    answer,
    usedPaths: selected.sort(),
    // Founder-provided extra context counts as a valid source for numbers.
    warnings: factCheck(answer, extra ? { slice, extra } : slice),
    missing: extractMissing(answer),
    overLimit: charLimit ? Math.max(0, answer.length - charLimit) : 0,
    overWords: wordLimit ? Math.max(0, countWords(answer) - wordLimit) : 0
  };
}

async function saveToHistory({ question, answer, program }) {
  const { founderContext } = await chrome.storage.local.get("founderContext");
  if (!founderContext) return;
  const today = new Date().toISOString().slice(0, 10);
  founderContext.answer_history = founderContext.answer_history || [];
  founderContext.answer_history.push({ question, answer, program: program || "", date: today });
  // Auto-track the program in the applications list.
  let tracked = false;
  if (program) {
    founderContext.applications = founderContext.applications || [];
    const existing = founderContext.applications.find(
      (a) => a.program?.toLowerCase() === program.toLowerCase()
    );
    if (!existing) {
      founderContext.applications.push({
        program, status: "in_progress", applied: "", deadline: "", url: "", notes: "", added: today
      });
      tracked = true;
    }
  }
  await chrome.storage.local.set({ founderContext });
  return { tracked };
}

// ---------- program discovery (scheduled scraping) ----------

import { PROGRAM_SOURCES } from "./lib/programs.js";

const SCAN_ALARM = "lore-program-scan";

async function ensureScanAlarm() {
  const { discover } = await chrome.storage.local.get("discover");
  const hours = discover?.intervalHours || 12;
  if (discover?.enabled === false) { chrome.alarms.clear(SCAN_ALARM); return; }
  const existing = await chrome.alarms.get(SCAN_ALARM);
  if (!existing || Math.abs(existing.periodInMinutes - hours * 60) > 1) {
    chrome.alarms.create(SCAN_ALARM, { periodInMinutes: hours * 60, delayInMinutes: 1 });
  }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SCAN_ALARM) scanPrograms(); });

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const OPEN_RE = /(apply now|applications? (are |is |currently )?open|start your application|accepting applications|apply for (the )?(next |upcoming )?(batch|cohort|class|round)|apply to (join|the))/i;
const CLOSED_RE = /(applications? (are |is )?(now )?closed|not (currently )?accepting|closed for (this|the))/i;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
}

// Find a date near deadline-ish words; returns "YYYY-MM-DD" or "".
function parseDeadline(text) {
  const windows = [];
  const kw = /(deadline|apply by|applications? (close|due)|closes on|due by)/gi;
  let m;
  while ((m = kw.exec(text)) && windows.length < 6) {
    windows.push(text.slice(m.index, m.index + 140));
  }
  const monthRe = new RegExp(`(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i");
  const isoRe = /(\d{4})-(\d{2})-(\d{2})/;
  for (const w of windows) {
    const iso = w.match(isoRe);
    if (iso) return iso[0];
    const md = w.match(monthRe);
    if (md) {
      const month = MONTHS.split("|").indexOf(md[1].slice(0, 3).toLowerCase()) + 1;
      const now = new Date();
      let year = md[3] ? Number(md[3]) : now.getFullYear();
      if (!md[3] && month < now.getMonth() + 1) year++;   // "Dec 8" said in Aug → this year; "Mar 2" → next
      return `${year}-${String(month).padStart(2, "0")}-${String(md[2]).padStart(2, "0")}`;
    }
  }
  return "";
}

async function scanOne(source) {
  try {
    const res = await fetch(source.url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ...source, error: `HTTP ${res.status}`, lastChecked: Date.now() };
    const text = stripHtml(await res.text()).slice(0, 40000);
    const closed = CLOSED_RE.test(text);
    const open = !closed && OPEN_RE.test(text);
    return {
      ...source, open, closed,
      deadline: parseDeadline(text),
      lastChecked: Date.now()
    };
  } catch (e) {
    return { ...source, error: e.name === "TimeoutError" ? "timeout" : e.message, lastChecked: Date.now() };
  }
}

async function scanPrograms() {
  const { discover = {} } = await chrome.storage.local.get("discover");
  if (discover.enabled === false) return { results: discover.results || {} };
  const sources = [
    ...PROGRAM_SOURCES,
    ...(discover.custom || []).map((c) => (typeof c === "string" ? { name: "", url: c } : c))
  ];
  const prev = discover.results || {};
  const settled = await Promise.all(sources.map(scanOne));
  const results = {};
  const newlyOpen = [];
  for (const r of settled) {
    if (!r.name) { try { r.name = new URL(r.url).hostname.replace(/^www\./, ""); } catch { r.name = r.url; } }
    const before = prev[r.url];
    if (r.open && before && !before.open) { r.openedAt = Date.now(); newlyOpen.push(r.name); }
    else if (r.open && before?.openedAt) r.openedAt = before.openedAt;
    results[r.url] = r;
  }
  await chrome.storage.local.set({
    discover: { ...discover, results, lastScan: Date.now(), newlyOpen }
  });
  if (newlyOpen.length) {
    chrome.action.setBadgeText({ text: "NEW" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#17754a" }).catch(() => {});
  }
  return { results, newlyOpen };
}

// ---------- keyless local answers (identity fields + saved answers) ----------

const factVal = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

// Label-keyword -> context value. Order matters: specific before generic.
const IDENTITY_RULES = [
  [/(company|startup).{0,12}name|name of (your )?(company|startup)/, (c) => c.company?.name, "company.name"],
  [/one[ -]?liner|tagline|in one sentence/, (c) => c.company?.one_liner, "company.one_liner"],
  [/linked ?in/, (c) => c.founders?.[0]?.linkedin, "founders.0.linkedin"],
  [/pitch ?deck/, (c) => c.company?.deck_url, "company.deck_url"],
  [/demo (video|url|link)|video demo/, (c) => c.company?.demo_url, "company.demo_url"],
  [/github/, (c) => c.links?.github, "links.github"],
  [/twitter|\bx\b.{0,3}(handle|profile|account)|\/ x\b/, (c) => c.links?.twitter, "links.twitter"],
  [/\bemail\b/, (c) => c.founders?.[0]?.email, "founders.0.email"],
  [/web ?site|company url|\burl\b/, (c) => c.company?.website, "company.website"],
  [/where.{0,20}(based|located)|\blocation\b|\bcity\b/, (c) => c.founders?.[0]?.location, "founders.0.location"],
  [/incorporat/, (c) => c.company_facts?.incorporation_status, "company_facts.incorporation_status"],
  [/first name/, (c) => c.founders?.[0]?.name?.split(/\s+/)[0], "founders.0.name"],
  [/last name|surname/, (c) => c.founders?.[0]?.name?.split(/\s+/).slice(1).join(" "), "founders.0.name"],
  [/(your|founder|full|applicant) name/, (c) => c.founders?.[0]?.name, "founders.0.name"],
  [/industry|sector/, (c) => c.company?.industry, "company.industry"],
  [/stage/, (c) => c.company?.stage, "company.stage"],
  [/how much are you raising|raise amount|round size/, (c) => c.fundraising?.target_amount, "fundraising.target_amount"]
];

// Try to answer without any LLM: exact-ish identity mapping first, then a
// close match from past saved answers. Returns null if neither applies.
function localAnswer(ctx, question) {
  const q = (question || "").toLowerCase();
  for (const [re, get, path] of IDENTITY_RULES) {
    if (re.test(q)) {
      const val = factVal(get(ctx));
      if (val !== undefined && val !== null && String(val).trim() !== "" && val !== 0) {
        return { answer: String(val), source: "context", usedPaths: [path], warnings: [], missing: [], overLimit: 0 };
      }
      break; // matched a rule but no data — let other strategies try
    }
  }
  const past = similarPastAnswers(ctx.answer_history, question, 1);
  if (past[0] && past[0].score >= 0.45) {
    return { answer: past[0].answer, source: "history", usedPaths: ["answer_history"], warnings: [], missing: [], overLimit: 0 };
  }
  return null;
}

const isConfigError = (e) => /Not configured|No API key|No model|No founder context/.test(e.message || "");

// ---------- AI field mapping ----------
// One call maps form-field labels to context paths. The model only POINTS at a
// path — the value is always resolved from the context in code, so mapping can
// never invent data.

const MAP_SYSTEM = `You map fields on a startup/accelerator application form to a founder's context schema.
For each numbered form field, decide one of:
- {"i": N, "path": "dot.path"}  — the field asks for a specific stored value (a name, URL, email, number, date) that a listed path holds. Prefer paths not marked (empty).
- {"i": N, "draft": true}       — the field needs written prose (an explanation, story, description).
- {"i": N, "skip": true}        — neither applies (file uploads, agreements, questions unrelated to the schema).
Use ONLY paths from the provided list. Respond with ONLY a JSON array covering every field number.`;

async function mapFields(state, fields) {
  const paths = listPaths(state.ctx);
  const pathList = paths.map((p) => p.path + (p.empty ? " (empty)" : "")).join("\n");
  const fieldList = fields.map((f) => `${f.i}. ${f.label} ${f.prose ? "(long text)" : "(short input)"}`).join("\n");
  const out = await state.provider.complete({
    apiKey: state.apiKey, model: state.model, baseUrl: state.baseUrl,
    system: MAP_SYSTEM,
    user: `CONTEXT PATHS:\n${pathList}\n\nFORM FIELDS:\n${fieldList}`,
    maxTokens: 2048
  });
  const m = out.match(/\[[\s\S]*\]/);
  let arr = [];
  if (m) { try { arr = JSON.parse(m[0]); } catch { /* fall through */ } }
  return new Map(arr.filter((x) => x && typeof x.i === "number").map((x) => [x.i, x]));
}

function resolveMappedValue(ctx, path) {
  const val = factVal(getAtPath(ctx, path));
  if (val == null || String(val).trim() === "" || val === 0) return null;
  return {
    ok: true, answer: String(val), source: "context",
    usedPaths: [path], warnings: [], missing: [], overLimit: 0
  };
}

async function answerField({ question, charLimit, wordLimit, allowAI }) {
  const { founderContext } = await chrome.storage.local.get("founderContext");
  if (!founderContext) return { ok: false, error: "No founder context yet — open Lore settings." };
  const local = localAnswer(founderContext, question);
  if (local) return { ok: true, ...local };
  try {
    if (!allowAI) {
      // Short field with no keyword match: ask the model to map it to a path.
      const state = await loadState();
      const map = await mapFields(state, [{ i: 0, label: question, prose: false }]);
      const d = map.get(0);
      if (d?.path) {
        const hit = resolveMappedValue(state.ctx, d.path);
        if (hit) return hit;
      }
      return { ok: false, skipped: true, error: "No matching info in your context for this field." };
    }
    const r = await draftAnswer({ question, charLimit, wordLimit });
    return { ok: true, source: "ai", ...r };
  } catch (e) {
    if (isConfigError(e)) {
      return allowAI
        ? { ok: false, needsKey: true, error: "No local match — add an API key in Lore settings for AI drafts." }
        : { ok: false, skipped: true, error: "No saved answer or context field matches." };
    }
    return { ok: false, error: e.message };
  }
}

// ---------- multiple-choice / select fields ----------

// All short scalar values in the context, as [path, value] pairs — the pool
// choice options are matched against.
function shortContextValues(ctx) {
  const out = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o || {})) {
      if (["schema_version", "answer_history", "applications"].includes(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        v.forEach((item, idx) => {
          if (typeof item === "string" && item && item.length <= 80) out.push([`${path}.${idx}`, item]);
          else if (item && typeof item === "object") walk(item, `${path}.${idx}`);
        });
        continue;
      }
      const val = factVal(v);
      if (typeof val === "string" && val && val.length <= 80) out.push([path, val]);
      else if (typeof val === "number" && val) out.push([path, String(val)]);
      // NOTE: booleans deliberately excluded — "no" would exact-match every
      // yes/no option regardless of what the question asks.
      else if (v && typeof v === "object" && !("value" in v)) walk(v, path);
    }
  })(ctx, "");
  return out;
}

// Code-level option matching: exact normalized match beats containment;
// containment needs real length on both sides so "No" can't match everything.
function localChoice(field, values) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const scored = [];
  for (const opt of field.options) {
    const on = norm(opt);
    if (!on) continue;
    // Generic options only make sense relative to the QUESTION — string
    // matching against context values can't decide them. Leave to the model.
    if (["yes", "no", "maybe", "none", "other", "not sure"].includes(on)) continue;
    for (const [, val] of values) {
      const vn = norm(val);
      if (!vn) continue;
      if (on === vn) { scored.push([2, opt]); break; }
      if (on.length >= 4 && vn.length >= 4 && (vn.includes(on) || on.includes(vn))) { scored.push([1, opt]); break; }
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b[0] - a[0]);
  return field.multi ? [...new Set(scored.map((s) => s[1]))] : [scored[0][1]];
}

const CHOICE_SYSTEM = `You answer multiple-choice questions on a startup application using ONLY the founder's context values provided.
For each numbered field, reply {"i": N, "pick": [option numbers]} choosing the option(s) the context clearly supports, or {"i": N, "skip": true}.
Never guess: if the context does not determine the answer (e.g. "how did you hear about us"), skip it.
Respond with ONLY a JSON array.`;

async function choiceAnswers({ fields }) {
  const { founderContext } = await chrome.storage.local.get("founderContext");
  if (!founderContext) return { error: "No founder context yet — open Lore settings." };
  const values = shortContextValues(founderContext);
  const results = {};
  const remaining = [];
  for (const f of fields) {
    const picks = localChoice(f, values);
    if (picks) results[f.i] = { ok: true, choices: picks, source: "context" };
    else remaining.push(f);
  }
  let state = null;
  try { state = await loadState(); } catch { /* keyless */ }
  if (state && remaining.length) {
    try {
      const ctxList = values.map(([p, v]) => `${p}: ${v}`).join("\n");
      const fieldList = remaining
        .map((f) => `${f.i}. ${f.label}${f.multi ? " (choose any that apply)" : " (choose one)"}\n` +
          f.options.map((o, n) => `   ${n}. ${o}`).join("\n"))
        .join("\n");
      const out = await state.provider.complete({
        apiKey: state.apiKey, model: state.model, baseUrl: state.baseUrl,
        system: CHOICE_SYSTEM,
        user: `CONTEXT VALUES:\n${ctxList}\n\nCHOICE FIELDS:\n${fieldList}`,
        maxTokens: 1500
      });
      const m = out.match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const byI = new Map(arr.filter((x) => x && typeof x.i === "number").map((x) => [x.i, x]));
      for (const f of remaining) {
        const d = byI.get(f.i);
        const picks = (d?.pick || []).map((n) => f.options[n]).filter(Boolean);
        results[f.i] = picks.length
          ? { ok: true, choices: f.multi ? picks : picks.slice(0, 1), source: "ai" }
          : { skipped: true };
      }
    } catch {
      for (const f of remaining) results[f.i] = { skipped: true };
    }
  } else {
    for (const f of remaining) results[f.i] = { skipped: true };
  }
  return { results };
}

// Batch plan for Autofill: local answers + one mapping call for the rest.
// Returns per-field results; prose fields come back as {draft:true} so the
// content script can draft them one by one with visible progress.
async function autofillMap({ fields }) {
  const { founderContext } = await chrome.storage.local.get("founderContext");
  if (!founderContext) return { error: "No founder context yet — open Lore settings." };
  const results = {};
  const remaining = [];
  for (const f of fields) {
    const local = localAnswer(founderContext, f.label);
    if (local) results[f.i] = { ok: true, ...local };
    else remaining.push(f);
  }
  let state = null;
  try { state = await loadState(); } catch { /* keyless */ }
  if (state && remaining.length) {
    try {
      const map = await mapFields(state, remaining);
      for (const f of remaining) {
        const d = map.get(f.i) || {};
        if (d.path) {
          const hit = resolveMappedValue(state.ctx, d.path);
          if (hit) { results[f.i] = hit; continue; }
        }
        if (f.prose && (d.draft || d.path)) results[f.i] = { draft: true };
        else results[f.i] = { skipped: true };
      }
    } catch {
      // mapping call failed — fall back: prose fields still draftable
      for (const f of remaining) results[f.i] = f.prose ? { draft: true } : { skipped: true };
    }
  } else {
    for (const f of remaining) {
      results[f.i] = f.prose
        ? (state ? { draft: true } : { needsKey: true })
        : { skipped: true };
    }
  }
  return { results };
}

// Side-panel drafts fall back to local answers when no key is configured.
async function draftOrLocal(msg) {
  try {
    return await draftAnswer(msg);
  } catch (e) {
    if (!isConfigError(e)) throw e;
    if (msg.revise) throw new Error("Revising needs an API key — add one in Lore settings. (You can still edit the answer by hand.)");
    const { founderContext } = await chrome.storage.local.get("founderContext");
    const local = founderContext && localAnswer(founderContext, msg.question);
    if (local) {
      return {
        ...local,
        note: local.source === "history"
          ? "No API key — reused your closest saved answer."
          : "No API key — answered from your context."
      };
    }
    throw new Error(`${e.message} Identity fields and previously saved answers still autofill without a key.`);
  }
}

// ---------- application page detection & submission logging ----------

const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function findApp(apps, program) {
  const n = normName(program);
  if (!n) return undefined;
  return (apps || []).find((a) => {
    const an = normName(a.program);
    return an && (an === n || an.includes(n) || n.includes(an));
  });
}

// Upsert a tracker entry; returns what happened for user-facing status.
async function upsertApplication(program, status) {
  // The tracker should work even before the founder context is filled in.
  const founderContext = (await chrome.storage.local.get("founderContext")).founderContext || { schema_version: 1 };
  const today = new Date().toISOString().slice(0, 10);
  founderContext.applications = founderContext.applications || [];
  const existing = findApp(founderContext.applications, program);
  let action;
  if (existing) {
    const terminal = ["accepted", "rejected", "waitlisted"];
    if (status === "submitted" && !terminal.includes(existing.status) && existing.status !== "submitted") {
      existing.status = "submitted";
      existing.applied = existing.applied || today;
      action = "updated";
    } else {
      action = "unchanged";
    }
    program = existing.program;
  } else {
    founderContext.applications.push({
      program, status, applied: status === "submitted" ? today : "",
      deadline: "", url: "", notes: "", added: today
    });
    action = "created";
  }
  await chrome.storage.local.set({ founderContext });
  return { ok: true, action, program };
}

async function setTabScan(tabId, scan) {
  const key = `scan_${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  // Remember that this tab held an application across same-site navigations
  // (form page -> "thank you" page), so the success page can still be attributed.
  const sameSite = stored && safeOrigin(stored.url) === safeOrigin(scan.url);
  const wasApplication = scan.isApplication || (sameSite && (stored.isApplication || stored.wasApplication)) || false;
  const merged = { ...scan, wasApplication };
  if (sameSite && stored.submittedLogged) {
    merged.submittedLogged = stored.submittedLogged;
    merged.loggedProgram = stored.loggedProgram;
    merged.loggedAction = stored.loggedAction;
  }
  await chrome.storage.session.set({ [key]: merged });
  chrome.action.setBadgeText({ tabId, text: merged.submittedLogged ? "✓" : merged.isApplication ? "APP" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: merged.submittedLogged ? "#2e7d32" : "#4f46e5" }).catch(() => {});
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

async function handleSuccessText(tabId, scan) {
  const key = `scan_${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  // Only log if this tab was identified as an application at some point
  // — a random "application received" page alone is not enough.
  const sameSite = !stored || safeOrigin(stored.url) === safeOrigin(scan.url);
  const wasApplication = scan.isApplication ||
    (sameSite && (stored?.isApplication || stored?.wasApplication));
  if (!wasApplication || stored?.submittedLogged) return;
  const program = stored?.program || scan.program;
  const result = await upsertApplication(program, "submitted");
  if (!result.ok) return;
  await chrome.storage.session.set({
    [key]: { ...(stored || scan), submittedLogged: true, loggedProgram: result.program, loggedAction: result.action }
  });
  chrome.action.setBadgeText({ tabId, text: "✓" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e7d32" }).catch(() => {});
}

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PAGE_SCAN" && sender.tab?.id != null) {
    setTabScan(sender.tab.id, msg.scan);
    return;
  }
  if (msg.type === "SUCCESS_TEXT" && sender.tab?.id != null) {
    handleSuccessText(sender.tab.id, msg.scan);
    return;
  }
  if (msg.type === "TRACK_PAGE") {
    upsertApplication(msg.program, "in_progress").then(sendResponse);
    return true;
  }
  if (msg.type === "MARK_SUBMITTED") {
    (async () => {
      const result = await upsertApplication(msg.program, "submitted");
      if (result.ok && msg.tabId != null) {
        const key = `scan_${msg.tabId}`;
        const stored = (await chrome.storage.session.get(key))[key];
        if (stored) await chrome.storage.session.set({ [key]: { ...stored, submittedLogged: true, loggedProgram: result.program, loggedAction: result.action } });
        chrome.action.setBadgeText({ tabId: msg.tabId, text: "✓" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: "#2e7d32" }).catch(() => {});
      }
      sendResponse(result);
    })();
    return true;
  }
  if (msg.type === "DRAFT_ANSWER") {
    draftOrLocal(msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }
  if (msg.type === "ANSWER_FIELD") {
    answerField(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "AUTOFILL_MAP") {
    autofillMap(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "CHOICE_ANSWERS") {
    choiceAnswers(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.type === "SCAN_PROGRAMS") {
    scanPrograms().then(sendResponse);
    return true;
  }
  if (msg.type === "DISCOVER_SETTINGS_CHANGED") {
    ensureScanAlarm();
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return;
  }
  if (msg.type === "SAVE_HISTORY") {
    saveToHistory(msg)
      .then((r) => sendResponse({ ok: true, ...(r || {}) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "INSERT_ANSWER") {
    // Relay from side panel to the content script in the active tab.
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab?.id) return sendResponse({ ok: false, error: "No active tab." });
      try {
        const results = await Promise.allSettled(
          [chrome.tabs.sendMessage(tab.id, { type: "INSERT_INTO_FIELD", text: msg.text })]
        );
        const r = results[0];
        if (r.status === "fulfilled" && r.value?.ok) sendResponse({ ok: true });
        else sendResponse({ ok: false, error: r.value?.error || "Click into the form field first, then press Insert." });
      } catch (err) {
        sendResponse({ ok: false, error: "Could not reach the page. Reload the tab and try again." });
      }
    });
    return true;
  }
});
