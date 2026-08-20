# Lore — Founder Context Autofill

Open-source, BYOK Chrome extension that fills accelerator / VC / grant applications
from **one portable file of verified facts about your startup**. No server, no
subscription: your context and your API key live in your browser; calls go straight
to the LLM provider you choose — or to no provider at all for everything that
doesn't need one.

> **Your context is the product. The LLM is interchangeable.**

## Core guarantees

1. **Facts are never invented.** Numbers, names, URLs come from your context file
   or don't appear at all. Every number in an AI draft is verified *in code*
   against the context that produced it; anything unmatched is flagged.
2. **Gaps are honest.** Unknown answers become `[MISSING: …]` flags or empty
   fields — never plausible filler.
3. **Works without an API key.** Identity fields, previously saved answers, and
   option matching run entirely locally. A key only adds AI-drafted prose for
   novel questions.

## What it does

### Detection
Recognizes funding-application pages via layered local heuristics (no LLM, no
network): a real form + startup-application vocabulary across independent
categories (traction / team / fundraising / program / product) − negative signals
(job-application, checkout). Sees **through iframes** — Airtable / Typeform /
Tally / Google-Forms embeds — attributing the program to the embedding site.
Detected pages get an `APP` toolbar badge, an in-page pill, and a side-panel banner.

### Autofill (the pill, or ⚡ Autofill page in the panel)
Three phases, each reported in a summary toast:

1. **Local (keyless):** identity fields (company name, website, deck, LinkedIn,
   Twitter, GitHub, email, founder name, location, stage, industry, raise amount…)
   filled straight from context; questions answered before (any program) reused
   from history.
2. **AI field-mapping (one batched call):** the model maps remaining field labels
   to context paths — *it only points; values are resolved from your context in
   code*. Then prose fields are drafted individually through the retrieval
   pipeline below. Email/URL/short inputs never receive prose.
3. **Multiple choice:** selects, radio/checkbox groups, ARIA widgets. Options are
   matched against context values in code; semantic picks (context "Not yet
   incorporated" → option "No") go to the model, which returns an option *number*.
   Yes/no questions are never string-matched (only the model may decide them),
   and undeterminable questions ("How did you hear about us?") are left blank.

A per-field **✨ Fill** button appears when you focus any empty field.

### Drafting pipeline (side panel)
Two-call retrieval: call 1 sends only the context's *field names* to pick relevant
sections; call 2 sends those sections + the question. Output is fact-checked in
code, `[MISSING]` flags surface as a checklist, and character limits are enforced
by counting (one automatic shorten-retry).

### Learning loop
- **Save to history** stores each Q&A (per program) — future similar questions
  autofill keyless, in your own voice.
- **Hand-written answers**: fill a field Lore couldn't, and a toast offers to save
  it — next application, it autofills.
- **Pitch-deck ingest**: upload a PDF in settings; your model proposes values for
  empty fields only, all marked *unverified* for review.

### Program discovery (aggregator)
Re-scans a registry of accelerator/VC apply pages (plus any URL you add) on a
`chrome.alarms` schedule — 6/12/24 h, entirely in your browser, no server.
Detects "applications open" + parses deadlines from page text; a program that
flips to open sets a green **NEW** toolbar badge. Each row has **Track** →
one click into the application tracker with its deadline and URL. JS-only
pages that serve empty HTML honestly report "unclear" instead of guessing.

### Application tracker
Every program you apply to, with status (planning → … → accepted/rejected),
dates, URL, private notes (never sent to any LLM), and per-program answer counts.
Auto-tracks on save; **auto-logs "submitted"** when it sees a success page after a
detected application (badge flips to ✓); manual *Track it* / *Mark submitted*
in the panel.

## Architecture

```
manifest.json          MV3; SW named worker.js (renamed once to bust a Chrome SW-cache bug)
worker.js              service worker: providers orchestration, retrieval, fact-check,
                       identity rules, AI field/choice mapping, tracker, detection state
content.js             page side: detection heuristics, pill/✨/toast UI (shadow DOM),
                       label extraction, autofill phases, manual-answer capture, insert
sidepanel.html/js/css  question → draft → warnings → copy/insert/save; page banner
options.html/js/css    provider+key+model (fetched model dropdown), paginated context
                       wizard, deck upload, application tracker, import/export JSON
lib/providers.js       adapters: Anthropic, OpenAI, Gemini, OpenRouter, custom
                       OpenAI-compatible base URL; complete/listModels/interpret(PDF)
lib/retrieval.js       path listing, hydration, history similarity
lib/factcheck.js       numeric-claim verification, [MISSING] extraction
lib/context-template.js  founder_context schema; facts as {value, verified, updated}
```

- Plain JS, no build step. Safari-compatible (sidePanel feature-detected → popup;
  package with `xcrun safari-web-extension-converter`, needs Xcode).
- Context lives in `chrome.storage.local`; export/import as `founder_context.json`
  (git-friendly, portable).
- Keys are per-provider in local storage — anyone with the browser profile can
  read them.

## Install / develop

`chrome://extensions` → Developer mode → **Load unpacked** → this folder.
A local mock provider (`scratchpad/mock_llm.py`, OpenAI-compatible on
`localhost:8998`) lets you demo the full pipeline with no key — configure it via
the "Custom" provider.

## Honest limits

- Selective retrieval limits what each request exposes, but the provider still
  sees what's sent — this is not end-to-end privacy.
- Searchable comboboxes (Airtable type-to-filter) and file uploads can't be
  auto-filled.
- Detection is heuristic; an undetected page still works via the side panel.
- AI drafts are marked "review them" for a reason.
