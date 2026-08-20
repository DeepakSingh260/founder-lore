// Two-call retrieval:
//   Call 1 sends ONLY the key paths (never values) + the question -> model picks paths.
//   Call 2 sends the hydrated slice -> model drafts the answer.
// Keeps calls small and avoids dumping the whole context into every request.

const SKIP_KEYS = new Set(["schema_version", "answer_history"]);

function isFactLeaf(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v && "verified" in v;
}

function isEmpty(v) {
  if (isFactLeaf(v)) return isEmpty(v.value);
  if (v == null || v === "" || v === 0 || v === false) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (typeof v === "object") return Object.values(v).every(isEmpty);
  return false;
}

// -> [{path: "traction.paying_customers", empty: false}, ...]
export function listPaths(ctx, prefix = "") {
  const out = [];
  for (const [key, val] of Object.entries(ctx || {})) {
    if (SKIP_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isFactLeaf(val) || Array.isArray(val) || typeof val !== "object" || val === null) {
      out.push({ path, empty: isEmpty(val) });
    } else {
      out.push(...listPaths(val, path));
    }
  }
  return out;
}

export function getAtPath(ctx, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

// Build a nested object holding only the selected paths.
export function hydrate(ctx, paths) {
  const slice = {};
  for (const path of paths) {
    const val = getAtPath(ctx, path);
    if (val === undefined || isEmpty(val)) continue;
    const keys = path.split(".");
    let node = slice;
    for (let i = 0; i < keys.length - 1; i++) {
      node = node[keys[i]] ??= {};
    }
    node[keys[keys.length - 1]] = val;
  }
  return slice;
}

// Parse the path list out of call 1's response, tolerating prose/fences around the JSON.
export function parsePathSelection(text, validPaths) {
  const valid = new Set(validPaths);
  let arr = null;
  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try { arr = JSON.parse(match[0]); } catch { /* fall through */ }
  }
  if (!Array.isArray(arr)) {
    // Fallback: pull anything that looks like a known path out of the text.
    arr = validPaths.filter((p) => text.includes(p));
  }
  return [...new Set(arr.filter((p) => typeof p === "string" && valid.has(p)))];
}

// Retrieve past answers to similar questions (crude token-overlap similarity —
// good enough to resurface "what's your traction" across programs).
export function similarPastAnswers(history, question, limit = 2) {
  const tokens = (s) =>
    new Set(
      s.toLowerCase().replace(/-/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const q = tokens(question);
  if (q.size === 0) return [];
  return (history || [])
    .filter((h) => h && h.question && h.answer)
    .map((h) => {
      const t = tokens(h.question);
      let overlap = 0;
      for (const w of q) if (t.has(w)) overlap++;
      return { ...h, score: overlap / Math.max(q.size, 1) };
    })
    .filter((h) => h.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
