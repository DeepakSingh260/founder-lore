const $ = (id) => document.getElementById(id);

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Pick up a question sent via the context menu.
async function loadPendingQuestion() {
  const { pendingQuestion } = await chrome.storage.session.get("pendingQuestion");
  if (pendingQuestion) {
    $("question").value = pendingQuestion;
    await chrome.storage.session.remove("pendingQuestion");
  }
}
loadPendingQuestion();
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingQuestion?.newValue) loadPendingQuestion();
});

// Autocomplete the Program field from the application tracker.
async function loadPrograms() {
  const { founderContext } = await chrome.storage.local.get("founderContext");
  const dl = $("programList");
  dl.innerHTML = "";
  for (const a of founderContext?.applications || []) {
    if (!a.program) continue;
    const o = document.createElement("option");
    o.value = a.program;
    dl.appendChild(o);
  }
}
loadPrograms();

// ---------- application-page banner ----------

let activeScan = null;
let activeTabId = null;

async function refreshBanner() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  const banner = $("pageBanner");
  if (activeTabId == null) return (banner.hidden = true);
  const key = `scan_${activeTabId}`;
  activeScan = (await chrome.storage.session.get(key))[key] || null;
  if (!activeScan) {
    // No recorded scan for this tab (report lost at startup, or panel opened
    // before the first scan) — ask the page to rescan, then re-read.
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: "RESCAN" });
      await new Promise((r) => setTimeout(r, 600));
      activeScan = (await chrome.storage.session.get(key))[key] || null;
    } catch { /* no content script on this page (chrome://, store, etc.) */ }
  }
  if (!activeScan?.isApplication && !activeScan?.submittedLogged) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const { founderContext } = await chrome.storage.local.get("founderContext");
  const tracked = (founderContext?.applications || []).some((a) => {
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const an = norm(a.program), n = norm(activeScan.program);
    return an && n && (an === n || an.includes(n) || n.includes(an));
  });
  if (activeScan.submittedLogged) {
    $("bannerText").textContent = `✓ Logged "${activeScan.loggedProgram || activeScan.program}" as submitted.`;
    $("autofillPage").hidden = true;
    $("trackPage").hidden = true;
    $("markSubmitted").hidden = true;
  } else {
    $("bannerText").textContent = `📋 This looks like a funding application${activeScan.program ? ` — ${activeScan.program}` : ""}.`;
    $("autofillPage").hidden = false;
    $("trackPage").hidden = tracked;
    $("markSubmitted").hidden = false;
    if (!$("program").value) $("program").value = activeScan.program || "";
  }
}

$("autofillPage").addEventListener("click", async () => {
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "START_AUTOFILL" });
    setStatus("Autofill started — watch the page.");
  } catch {
    setStatus("Could not reach the page — reload the tab and try again.", true);
  }
});

$("trackPage").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "TRACK_PAGE", program: activeScan?.program });
  setStatus(res?.ok ? `Tracking "${res.program}".` : res?.error || "Could not track.", !res?.ok);
  loadPrograms();
  refreshBanner();
});

$("markSubmitted").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({
    type: "MARK_SUBMITTED", program: activeScan?.program, tabId: activeTabId
  });
  setStatus(res?.ok ? `Logged "${res.program}" as submitted.` : res?.error || "Could not log.", !res?.ok);
  loadPrograms();
  refreshBanner();
});

refreshBanner();
chrome.tabs.onActivated.addListener(refreshBanner);
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith("scan_"))) refreshBanner();
});

function setStatus(text, isError = false) {
  const el = $("status");
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function renderList(el, title, items) {
  el.hidden = items.length === 0;
  el.innerHTML = "";
  if (items.length === 0) return;
  const strong = document.createElement("strong");
  strong.textContent = title;
  el.appendChild(strong);
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

const countWords = (s) => s.trim().split(/\s+/).filter(Boolean).length;

function updateCharCount() {
  const len = $("answer").value.length;
  const words = countWords($("answer").value);
  const cl = parseInt($("charLimit").value, 10) || 0;
  const wl = parseInt($("wordLimit").value, 10) || 0;
  const el = $("charCount");
  el.textContent = [
    cl ? `${len} / ${cl} chars` : `${len} chars`,
    wl ? `${words} / ${wl} words` : `${words} words`
  ].join(" · ");
  el.classList.toggle("over", (cl > 0 && len > cl) || (wl > 0 && words > wl));
}
$("answer").addEventListener("input", updateCharCount);
$("charLimit").addEventListener("input", updateCharCount);
$("wordLimit").addEventListener("input", updateCharCount);

// Auto-detect limits stated inside the question ("Max: 500 characters — about 100 words").
$("question").addEventListener("input", () => {
  const t = $("question").value.toLowerCase();
  const chars = t.match(/(?:max(?:imum)?|limit|under|up to|within)[^\d]{0,14}(\d{2,5})\s*char/) || t.match(/(\d{2,5})\s*characters?\b/);
  const words = t.match(/(?:max(?:imum)?|limit|under|up to|within|about|~)[^\d]{0,14}(\d{1,4})\s*words?\b/) || t.match(/(\d{1,4})\s*words?\b/);
  if (chars && !$("charLimit").value) $("charLimit").value = chars[1];
  if (words && !$("wordLimit").value) $("wordLimit").value = words[1];
  if (chars || words) setStatus(`Detected limit from the question: ${[chars && chars[1] + " chars", words && words[1] + " words"].filter(Boolean).join(" · ")}.`);
});

$("draft").addEventListener("click", async () => {
  const question = $("question").value.trim();
  if (!question) return setStatus("Paste a question first.", true);

  $("draft").disabled = true;
  setStatus("Selecting relevant context…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "DRAFT_ANSWER",
      question,
      charLimit: parseInt($("charLimit").value, 10) || 0,
      wordLimit: parseInt($("wordLimit").value, 10) || 0,
      extra: $("extra").value.trim()
    });
    if (!res?.ok) throw new Error(res?.error || "Unknown error");

    $("result").hidden = false;
    $("answer").value = res.answer;
    updateCharCount();
    renderList($("warnings"), "Verify these numbers:", res.warnings);
    renderList($("missing"), "Missing from your context:", res.missing);
    $("usedPaths").textContent = res.usedPaths.join("\n");
    setStatus([
      res.note,
      res.overLimit ? `Still ${res.overLimit} chars over — trim by hand.` : "",
      res.overWords ? `Still ${res.overWords} words over — trim by hand.` : ""
    ].filter(Boolean).join(" "));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("draft").disabled = false;
  }
});

async function draftRequest(revise) {
  return chrome.runtime.sendMessage({
    type: "DRAFT_ANSWER",
    question: $("question").value.trim(),
    charLimit: parseInt($("charLimit").value, 10) || 0,
    wordLimit: parseInt($("wordLimit").value, 10) || 0,
    extra: $("extra").value.trim(),
    revise
  });
}

$("refine").addEventListener("click", async () => {
  const instruction = $("refineInput").value.trim();
  const current = $("answer").value.trim();
  if (!current) return setStatus("Draft an answer first, then refine it.", true);
  if (!instruction) return setStatus("Tell the AI what to change.", true);
  $("refine").disabled = true;
  setStatus("Revising…");
  try {
    const res = await draftRequest({ answer: current, instruction });
    if (!res?.ok) throw new Error(res?.error || "Unknown error");
    $("answer").value = res.answer;
    updateCharCount();
    renderList($("warnings"), "Verify these numbers:", res.warnings);
    renderList($("missing"), "Missing from your context:", res.missing);
    $("refineInput").value = "";
    setStatus([
      "Revised.",
      res.overLimit ? `Still ${res.overLimit} chars over — trim by hand.` : "",
      res.overWords ? `Still ${res.overWords} words over — trim by hand.` : ""
    ].filter(Boolean).join(" "));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("refine").disabled = false;
  }
});
$("refineInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("refine").click();
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("answer").value);
  setStatus("Copied.");
});

$("insert").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "INSERT_ANSWER", text: $("answer").value });
  setStatus(res?.ok ? "Inserted." : res?.error || "Insert failed.", !res?.ok);
});

$("saveHistory").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({
    type: "SAVE_HISTORY",
    question: $("question").value.trim(),
    answer: $("answer").value,
    program: $("program").value.trim()
  });
  if (res?.ok) {
    setStatus(res.tracked
      ? `Saved — "${$("program").value.trim()}" added to your application tracker.`
      : "Saved to answer history.");
    loadPrograms();
  } else {
    setStatus(res?.error || "Save failed.", true);
  }
});
