// Tracks the last focused editable element so "Insert" from the side panel
// still works after the page loses focus to the panel.
(() => {
  let lastField = null;

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return ["text", "search", "email", "url"].includes(type);
    }
    return false;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (isEditable(e.target)) lastField = e.target;
    },
    true
  );

  function setNativeValue(el, text) {
    // Go through the native setter so React/Vue-controlled inputs notice the change.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------------- application page detection ----------------
  // Heuristic, local, no LLM calls. Requires MULTIPLE independent signals to
  // avoid false positives: a real form + startup-application vocabulary,
  // minus job-application/checkout negatives. Top frame only.

  const PLATFORMS = [
    ["ycombinator.com", "Y Combinator"],
    ["startupschool.org", "Y Combinator"],
    ["f6s.com", null],
    ["gust.com", null],
    ["techstars.com", "Techstars"],
    ["500.co", "500 Global"],
    ["seedcamp.com", "Seedcamp"],
    ["antler.co", "Antler"],
    ["joinef.com", "Entrepreneur First"],
    ["wefunder.com", "Wefunder"]
  ];

  const CATEGORIES = {
    company: ["what does your company do", "describe your company", "what are you building", "company description", "one-liner", "startup name"],
    traction: ["traction", "monthly recurring revenue", "mrr", "arr", "paying customers", "active users", "growth rate", "waitlist"],
    team: ["co-founder", "cofounder", "founding team", "technical founder", "cap table", "equity split", "why are you the right team", "how did you meet", "how long have you known"],
    fundraising: ["how much are you raising", "fundraising", "valuation", "pre-seed", "seed round", "investors", "safe note", "amount raised"],
    program: ["accelerator", "incubator", "cohort", "batch", "demo day", "why do you want to join"],
    product: ["pitch deck", "demo video", "how does your product work", "business model", "competitors"]
  };
  const NEGATIVES = [
    "cover letter", "resume", "curriculum vitae", "desired salary", "salary expectation",
    "current employer", "notice period", "years of experience", "position applied",
    "billing address", "credit card", "add to cart", "shipping address", "order summary"
  ];
  const SUCCESS_RE = /(thank you for (applying|your application)|application (has been |was )?(received|submitted)|we[’']?ve received your application|successfully submitted your application)/;

  // Hosts that serve embedded forms (Airtable, Typeform, …). A funding form on
  // one of these usually lives inside an iframe on the VC's own site.
  const FORM_HOSTS = ["airtable.com", "typeform.com", "tally.so", "jotform.com",
    "fillout.com", "docs.google.com", "forms.office.com", "hsforms.com", "paperform.co"];

  const hostMatches = (host, dom) => host === dom || host.endsWith("." + dom);

  function guessProgram() {
    const host = location.hostname;
    for (const [dom, name] of PLATFORMS) {
      if (hostMatches(host, dom) && name) return name;
    }
    // Inside an embedded form the meaningful name is the EMBEDDING site's.
    if (window !== window.top && document.referrer) {
      try {
        const refHost = new URL(document.referrer).hostname.replace(/^www\./, "");
        if (!FORM_HOSTS.some((d) => hostMatches(refHost, d))) return refHost;
      } catch { /* fall through */ }
    }
    const site = document.querySelector('meta[property="og:site_name"]')?.content;
    if (site && !/airtable|typeform|tally|jotform|google/i.test(site)) return site.trim();
    return (document.title || host)
      .split(/[|–—-]/)[0]
      .replace(/^\s*apply (to|for|now)?\s*/i, "")
      .replace(/\s*application\s*$/i, "")
      .trim() || host;
  }

  function scanPage() {
    const text = (document.body?.innerText || "").slice(0, 60000).toLowerCase();
    if (text.length < 100) return null;

    const textareas = document.querySelectorAll("textarea, [role='textbox'], [contenteditable='true']").length;
    const inputs = document.querySelectorAll("input:not([type=hidden])").length;
    const hasForm = textareas >= 2 || (textareas >= 1 && inputs >= 3) || (document.forms.length > 0 && inputs >= 4);

    const host = location.hostname;
    const platform = PLATFORMS.some(([dom]) => hostMatches(host, dom));
    const formHost = FORM_HOSTS.some((dom) => hostMatches(host, dom));
    const urlHint = /(apply|application|cohort|batch|funding)/.test(
      (location.pathname + (window !== window.top ? " " + document.referrer : "")).toLowerCase());
    const catHits = Object.values(CATEGORIES).filter((words) => words.some((w) => text.includes(w))).length;
    const negHits = NEGATIVES.filter((w) => text.includes(w)).length;

    const isApplication = hasForm && negHits < 2 && (
      (platform && (catHits >= 1 || urlHint)) ||
      catHits >= 3 ||
      (catHits >= 2 && (urlHint || formHost))
    );
    return {
      isApplication,
      program: guessProgram(),
      score: { platform, urlHint, catHits, negHits, textareas, inputs },
      successText: SUCCESS_RE.test(text),
      url: location.href.split("#")[0]
    };
  }

  // ---------------- in-page UI (pill + per-field fill button) ----------------
  // Lives in a shadow root so page CSS can't touch it. Only created once the
  // page is detected as a funding application.

  let ui = null;

  function buildUI() {
    if (ui) return ui;
    const host = document.createElement("div");
    host.id = "lore-ext-root";
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font: 12.5px/1.4 -apple-system, system-ui, sans-serif; }
        .pill {
          position: fixed; right: 18px; bottom: 18px;
          display: flex; align-items: center; gap: 8px;
          background: #fff; color: #1c1e26;
          border: 1px solid #c9cdf5; border-radius: 999px;
          padding: 8px 10px 8px 14px;
          box-shadow: 0 4px 16px rgba(30,30,60,.18);
        }
        .pill b { color: #4f46e5; }
        .pill button {
          border: 1px solid #4f46e5; background: #4f46e5; color: #fff;
          border-radius: 999px; padding: 5px 12px; cursor: pointer; font-weight: 600;
        }
        .pill button.ghost { background: transparent; color: #6b7280; border-color: transparent; padding: 5px 6px; }
        .fill-btn {
          position: fixed; display: none;
          background: #4f46e5; color: #fff; border: none; border-radius: 6px;
          padding: 4px 10px; cursor: pointer; font-weight: 600;
          box-shadow: 0 2px 8px rgba(30,30,60,.25);
        }
        .toast {
          position: fixed; right: 18px; bottom: 66px; display: none; max-width: 340px;
          background: #1c1e26; color: #fff; border-radius: 8px; padding: 9px 12px;
          box-shadow: 0 4px 16px rgba(0,0,0,.25); white-space: pre-line;
        }
      </style>
      <div class="pill">
        <span>⚡ <b>Lore</b> — application detected</span>
        <button data-act="autofill">Autofill</button>
        <button class="ghost" data-act="close" title="Hide">✕</button>
      </div>
      <button class="fill-btn">✨ Fill</button>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);

    const pillBtn = shadow.querySelector("[data-act=autofill]");
    shadow.querySelector("[data-act=close]").addEventListener("click", () => {
      host.remove(); ui = null;
      try { sessionStorage.setItem("lore-dismissed", "1"); } catch {}
    });
    pillBtn.addEventListener("click", () => autofillPage());

    const fillBtn = shadow.querySelector(".fill-btn");
    fillBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep field focus
    fillBtn.addEventListener("click", () => { if (ui.target) answerInto(ui.target); });

    const toastEl = shadow.querySelector(".toast");
    toastEl.addEventListener("click", () => {
      const action = toastEl.dataset.action;
      toastEl.style.display = "none";
      if (action === "options") {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
      } else if (action === "save-manual") {
        saveManualAnswers();
      }
    });
    let toastTimer;
    const toast = (text, ms = 4500, action = "") => {
      toastEl.textContent = text;
      toastEl.dataset.action = action;
      toastEl.style.cursor = action ? "pointer" : "default";
      toastEl.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, ms);
    };
    ui = { host, fillBtn, pillBtn, toast, target: null };
    return ui;
  }

  // ---- reading the question a field belongs to ----
  const clean = (s) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();

  // Form builders (Google Forms et al.) stamp generic labels on the control
  // itself; the real question lives in a heading above. Treat these as absent.
  const GENERIC_LABEL = /^(your (answer|response)|answer|response|type here|enter (your )?(answer|response|text)|untitled question)$/i;
  const useful = (t) => t && !GENERIC_LABEL.test(t) ? t : "";

  function labelFor(el) {
    if (el.labels?.[0]) {
      const t = useful(clean(el.labels[0].innerText));
      if (t) return t;
    }
    const aria = useful(clean(el.getAttribute("aria-label")));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (clean(t)) return clean(t);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.innerText.replace(el.value || "", ""));
    // walk back through previous siblings (and parent's) for a short text node
    let node = el;
    for (let hops = 0; hops < 4 && node; hops++) {
      let sib = node.previousElementSibling;
      while (sib) {
        let t = clean(sib.innerText);
        if (t) {
          // Long blocks are usually heading + help text + the question — the
          // question is normally the last meaningful line.
          if (t.length > 200) {
            const lines = t.split("\n").map(clean).filter(Boolean);
            t = lines[lines.length - 1] || "";
          }
          if (t && t.length <= 200) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return useful(clean(el.getAttribute("placeholder")));
  }

  // Prose = fields where written answers belong. Email/url/tel/etc. inputs are
  // NEVER prose, no matter how large the site sets maxlength.
  // Pull "Max: 500 characters" / "about 100 words" style limits out of the
  // question text itself, so drafts respect the form's stated limits.
  function parseLimits(text) {
    const t = (text || "").toLowerCase();
    const chars =
      t.match(/(?:max(?:imum)?|limit|under|up to|within)[^\d]{0,14}(\d{2,5})\s*char/) ||
      t.match(/(\d{2,5})\s*characters?\b/);
    const words =
      t.match(/(?:max(?:imum)?|limit|under|up to|within|about|~)[^\d]{0,14}(\d{1,4})\s*words?\b/) ||
      t.match(/(\d{1,4})\s*words?\b/);
    return { chars: chars ? +chars[1] : 0, words: words ? +words[1] : 0 };
  }

  const isProse = (el) =>
    el.tagName === "TEXTAREA" || el.isContentEditable ||
    ((el.type === "text" || el.type === "search") && el.maxLength > 120);

  async function answerInto(el, { silent = false } = {}) {
    const question = labelFor(el);
    if (!question) {
      if (!silent) ui?.toast("Couldn't read this field's question.");
      return { skipped: true };
    }
    if (!silent) ui?.toast("Filling…", 15000);
    const limits = parseLimits(question);
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "ANSWER_FIELD",
        question,
        charLimit: el.maxLength > 0 ? el.maxLength : limits.chars,
        wordLimit: limits.words,
        allowAI: isProse(el)
      });
    } catch {
      resp = { ok: false, error: "Lore was updated — reload this page." };
    }
    // An answer that is ONLY a missing-info marker should leave the field
    // blank and count as a gap, not fill the slot with noise.
    if (resp?.ok && /^\s*\[MISSING:[^\]]*\]\s*$/.test(resp.answer || "")) {
      resp = { ok: false, skipped: true, error: `Missing from your context: ${resp.missing?.[0] || "this info"}.` };
    }
    if (resp?.ok) {
      fillEl(el, resp.answer);
      if (!silent) {
        const src = { context: "from your context", history: "reused a saved answer", ai: "AI draft — review it" }[resp.source];
        ui?.toast(`Filled (${src}).` + (resp.missing?.length ? `\nMissing: ${resp.missing.join(", ")}` : ""));
      }
    } else if (!silent) {
      ui?.toast(resp?.error || "Could not fill this field.");
    }
    return resp || { ok: false };
  }

  function collectFields() {
    const els = [...document.querySelectorAll("textarea, input")];
    return els.filter((el) => {
      if (!isEditable(el) || el.value.trim() !== "") return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 10 && el.offsetParent !== null;
    });
  }

  const loreFilled = new WeakSet();   // fields Lore itself filled

  function fillEl(el, answer) {
    if (el.isContentEditable) {
      el.focus(); el.textContent = answer;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(el, answer);
    }
    loreFilled.add(el);
  }

  // ---- learn from hand-written answers ----
  // A field Lore couldn't fill that the user then fills by hand is exactly the
  // knowledge the context is missing — offer to save it for future autofill.
  const pendingManual = [];
  const manualSeen = new WeakSet();

  document.addEventListener("focusout", (e) => {
    const el = e.target;
    if (!ui || !isEditable(el) || loreFilled.has(el) || manualSeen.has(el)) return;
    const answer = (el.isContentEditable ? el.textContent : el.value || "").trim();
    if (answer.length < 2) return;
    const question = labelFor(el);
    if (!question) return;
    manualSeen.add(el);
    pendingManual.push({ el, question });
    ui.toast(
      `💾 You answered ${pendingManual.length} field${pendingManual.length === 1 ? "" : "s"} yourself.\n` +
      `Tap this note to save ${pendingManual.length === 1 ? "it" : "them"} to Lore — next time they autofill.`,
      10000, "save-manual");
  }, true);

  async function saveManualAnswers() {
    let saved = 0;
    for (const p of pendingManual.splice(0)) {
      const answer = (p.el.isConnected
        ? (p.el.isContentEditable ? p.el.textContent : p.el.value) : "").trim();
      if (!answer) continue;
      try {
        await chrome.runtime.sendMessage({
          type: "SAVE_HISTORY", question: p.question, answer, program: lastProgram || ""
        });
        saved++;
      } catch { /* worker unavailable */ }
    }
    ui?.toast(saved ? `Saved ${saved} answer${saved === 1 ? "" : "s"} — they'll autofill next time.` : "Nothing to save.");
  }

  // ---- multiple-choice fields (selects, radios, checkboxes, ARIA widgets) ----

  function optionLabel(input) {
    // The option's text is what sits between this input and the next control —
    // robust for both <label><input>yes</label> and flat <input>yes<input>no.
    let t = "";
    let n = input.nextSibling;
    while (n && !(n.nodeType === 1 && n.matches?.("input, select, textarea, button"))) {
      t += n.textContent || "";
      n = n.nextSibling;
    }
    t = clean(t);
    if (t) return t.length > 60 ? clean(t.split("\n")[0]).slice(0, 60) : t;
    if (input.labels?.[0]) {
      const lt = clean(input.labels[0].innerText);
      if (lt && lt.length <= 60) return lt;
    }
    const wrap = input.closest("label");
    if (wrap) {
      const wt = clean(wrap.innerText);
      if (wt && wt.length <= 60) return wt;
    }
    return "";
  }

  function groupLabel(el, optionTexts = []) {
    const fs = el.closest("fieldset");
    const group = el.closest("[role=group], [role=radiogroup]");
    if (group?.getAttribute("aria-label")) return clean(group.getAttribute("aria-label"));
    // The question is the line just ABOVE the first option, inside the nearest
    // container holding both — not a distant section heading. (A fieldset
    // legend is often a SECTION title, so this scan runs first; a per-question
    // legend is simply the line above the options and gets found anyway.)
    const first = (optionTexts[0] || "").trim();
    let p = el.parentElement;
    for (let hops = 0; hops < 5 && p; hops++, p = p.parentElement) {
      const lines = (p.innerText || "").split("\n").map(clean).filter(Boolean);
      const idx = first ? lines.findIndex((l) => l === first || l.startsWith(first)) : -1;
      for (let j = idx - 1; j >= 0; j--) {
        const cand = lines[j];
        if (cand.length >= 8 && !optionTexts.includes(cand)) return cand;
      }
    }
    const legend = fs?.querySelector("legend");
    if (legend) return clean(legend.innerText);
    return labelFor(fs || group || el.parentElement || el);
  }

  function choiceGroups() {
    const groups = [];
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    document.querySelectorAll("select").forEach((sel) => {
      if (!visible(sel) || (sel.selectedIndex > 0 && sel.value)) return;
      const options = [...sel.options].filter((o) => o.value !== "").map((o) => clean(o.textContent)).filter(Boolean);
      if (options.length >= 2) groups.push({ kind: "select", el: sel, label: labelFor(sel), options, multi: false });
    });

    const byName = new Map();
    document.querySelectorAll("input[type=radio], input[type=checkbox]").forEach((r) => {
      if (!visible(r)) return;
      const key = r.type + "|" + (r.name || (r.closest("fieldset, [role=group]") ? "g" : "solo"));
      if (!byName.has(key + r.name)) byName.set(key + r.name, { type: r.type, els: [] });
      byName.get(key + r.name).els.push(r);
    });
    for (const { type, els } of byName.values()) {
      if (els.length < 2 || els.some((r) => r.checked)) continue;
      const options = els.map(optionLabel).filter(Boolean);
      if (options.length !== els.length) continue;
      groups.push({ kind: "input", els, label: groupLabel(els[0], options), options, multi: type === "checkbox" });
    }

    // ARIA widgets (custom form builders like Airtable)
    document.querySelectorAll("[role=radiogroup], [role=listbox]").forEach((g) => {
      if (!visible(g)) return;
      const items = [...g.querySelectorAll("[role=radio], [role=option]")];
      if (items.length < 2) return;
      if (items.some((i) => i.getAttribute("aria-checked") === "true" || i.getAttribute("aria-selected") === "true")) return;
      const options = items.map((i) => clean(i.innerText || i.getAttribute("aria-label"))).filter(Boolean);
      if (options.length !== items.length) return;
      groups.push({
        kind: "aria", els: items, label: groupLabel(g, options), options,
        multi: g.getAttribute("aria-multiselectable") === "true"
      });
    });

    return groups.filter((g) => g.label && g.options.length >= 2);
  }

  function applyChoice(group, choices) {
    let applied = false;
    for (const choice of choices) {
      if (group.kind === "select") {
        const opt = [...group.el.options].find((o) => clean(o.textContent) === choice);
        if (opt) {
          group.el.value = opt.value;
          group.el.dispatchEvent(new Event("input", { bubbles: true }));
          group.el.dispatchEvent(new Event("change", { bubbles: true }));
          applied = true;
        }
      } else {
        const idx = group.options.indexOf(choice);
        if (idx >= 0) { group.els[idx].click(); applied = true; }
      }
      if (!group.multi && applied) break;
    }
    return applied;
  }

  let autofillRunning = false;
  async function autofillPage() {
    if (autofillRunning) return;
    autofillRunning = true;
    const fields = collectFields();
    const items = fields
      .map((el, i) => ({ el, i, label: labelFor(el), prose: isProse(el), charLimit: el.maxLength > 0 ? el.maxLength : 0 }))
      .filter((f) => f.label);
    const stats = { context: 0, history: 0, ai: 0, needsKey: 0, skipped: fields.length - items.length };

    // Phase 1: one batched call — local matches + AI field mapping.
    ui.pillBtn.textContent = "Mapping fields…";
    let plan = null;
    try {
      plan = await chrome.runtime.sendMessage({
        type: "AUTOFILL_MAP",
        fields: items.map(({ i, label, prose, charLimit }) => ({ i, label, prose, charLimit }))
      });
    } catch { /* fall through to per-field mode */ }
    if (plan?.error) {
      ui.pillBtn.textContent = "Autofill";
      autofillRunning = false;
      return ui.toast(plan.error);
    }

    // Phase 2: apply mapped values instantly, draft prose fields one by one.
    const drafts = [];
    for (const f of items) {
      const r = plan?.results?.[f.i];
      if (r?.ok) { fillEl(f.el, r.answer); stats[r.source] = (stats[r.source] || 0) + 1; }
      else if (r?.draft) drafts.push(f);
      else if (r?.needsKey) stats.needsKey++;
      else if (r) stats.skipped++;
      else drafts.push(f); // no plan at all — per-field fallback
    }
    let done = 0;
    for (const f of drafts) {
      ui.pillBtn.textContent = `Drafting ${++done}/${drafts.length}…`;
      const resp = await answerInto(f.el, { silent: true });
      if (resp?.ok) stats[resp.source] = (stats[resp.source] || 0) + 1;
      else if (resp?.needsKey) stats.needsKey++;
      else stats.skipped++;
    }

    // Phase 3: multiple-choice fields (selects / radios / checkboxes).
    const cgroups = choiceGroups();
    if (cgroups.length) {
      ui.pillBtn.textContent = "Choosing options…";
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({
          type: "CHOICE_ANSWERS",
          fields: cgroups.map((g, i) => ({ i, label: g.label, options: g.options, multi: g.multi }))
        });
      } catch { /* worker unavailable */ }
      cgroups.forEach((g, i) => {
        const r = resp?.results?.[i];
        if (r?.ok && r.choices?.length && applyChoice(g, r.choices)) {
          stats.choices = (stats.choices || 0) + 1;
        } else {
          stats.skipped++;
        }
      });
    }

    ui.pillBtn.textContent = "Autofill";
    autofillRunning = false;
    const parts = [];
    if (stats.context) parts.push(`${stats.context} from your context`);
    if (stats.history) parts.push(`${stats.history} from saved answers`);
    if (stats.ai) parts.push(`${stats.ai} AI drafts — review them`);
    if (stats.choices) parts.push(`${stats.choices} choices selected`);
    const filled = stats.context + stats.history + stats.ai + (stats.choices || 0);
    let msg = filled ? `Filled ${filled} field${filled === 1 ? "" : "s"} (${parts.join(", ")}).` : "Nothing filled.";
    if (stats.needsKey) msg += `\n${stats.needsKey} need an API key (add one in Lore settings for AI drafts).`;
    if (stats.skipped) msg += `\n${stats.skipped} skipped — that info isn't in your context yet.`;
    const actionable = stats.needsKey || stats.skipped;
    if (actionable) msg += `\n👉 Tap this note to open Lore settings and add it.`;
    ui.toast(msg, 12000, actionable ? "options" : "");
  }

  // per-field ✨ Fill button
  document.addEventListener("focusin", (e) => {
    if (!ui || !isEditable(e.target) || e.target.value?.trim()) return;
    const r = e.target.getBoundingClientRect();
    ui.target = e.target;
    ui.fillBtn.style.display = "block";
    ui.fillBtn.style.top = `${Math.max(4, r.top - 30)}px`;
    ui.fillBtn.style.left = `${Math.min(window.innerWidth - 80, r.right - 70)}px`;
  }, true);
  document.addEventListener("focusout", () => {
    setTimeout(() => { if (ui) ui.fillBtn.style.display = "none"; }, 250);
  }, true);

  let lastReport = "";
  let successSent = false;
  let detectedHere = false;   // this frame holds the application form
  let lastProgram = "";

  function reportScan(force = false) {
    // Iframes without any form elements never scan — keeps ad/widget frames silent.
    if (window !== window.top &&
        !document.querySelector("textarea, input, [contenteditable=true]")) return;
    const scan = scanPage();
    if (!scan) return;
    detectedHere = detectedHere || scan.isApplication;
    if (scan.isApplication) lastProgram = scan.program || lastProgram;
    // Show the in-page pill as soon as the page is recognized (unless the
    // user dismissed it for this tab session).
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("lore-dismissed") === "1"; } catch {}
    if (scan.isApplication && !dismissed) buildUI();
    if (scan.successText && !successSent) {
      successSent = true;
      chrome.runtime.sendMessage({ type: "SUCCESS_TEXT", scan }).catch(() => {});
    }
    // Iframes only ever send POSITIVE detections — a negative from some other
    // frame must not overwrite the form frame's state.
    if (window !== window.top && !scan.isApplication) return;
    const key = `${scan.isApplication}|${scan.successText}|${scan.program}`;
    if (!force && key === lastReport) return;
    // Only mark reported on a successful send — a message lost during browser
    // startup gets retried by the next scheduled scan.
    chrome.runtime.sendMessage({ type: "PAGE_SCAN", scan })
      .then(() => { lastReport = key; })
      .catch(() => {});
  }

  {
    setTimeout(reportScan, 1200);
    setTimeout(reportScan, 5000);   // retry if the first report was lost
    let scanTimer;
    new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(reportScan, 2500);
    }).observe(document.documentElement, { childList: true, subtree: true });

    // A submit-looking click → recheck shortly after for an inline success state.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button, [type=submit], [role=button]");
      if (btn && /\b(submit|apply|send application|finish)\b/i.test(btn.textContent || btn.value || "")) {
        setTimeout(reportScan, 1800);
      }
    }, true);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START_AUTOFILL") {
      // Runs in the frame that actually holds the form (may be an embed iframe).
      if (detectedHere) {
        // Explicit request (e.g. from the side panel) — undo any earlier dismissal.
        try { sessionStorage.removeItem("lore-dismissed"); } catch {}
        buildUI();
        autofillPage();
        sendResponse({ ok: true });
      }
      return;
    }
    if (msg.type === "DEBUG_FIELDS") {
      // Dry-run audit: what fields/labels/choices would autofill see here?
      if (window !== window.top && !detectedHere) return;
      const fields = collectFields().map((el) => ({
        tag: el.tagName, type: el.type || "", maxLength: el.maxLength,
        prose: isProse(el), label: labelFor(el)
      }));
      const choices = choiceGroups().map((g) => ({ kind: g.kind, label: g.label, options: g.options, multi: g.multi }));
      if (fields.length || choices.length || window === window.top) sendResponse({ fields, choices, frame: location.href });
      return;
    }
    if (msg.type === "RESCAN") {
      reportScan(true);            // every frame rechecks
      if (window === window.top) sendResponse({ ok: true });
      return;
    }
    if (msg.type !== "INSERT_INTO_FIELD") return;
    const el = isEditable(document.activeElement) ? document.activeElement : lastField;
    if (!el || !el.isConnected) {
      // Stay silent so a frame that CAN insert wins the response race.
      // If no frame responds, the background reports "click into the field first".
      return;
    }
    if (el.isContentEditable) {
      el.focus();
      // Replace content of the contenteditable region.
      el.textContent = msg.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(el, msg.text);
    }
    sendResponse({ ok: true });
  });
})();
