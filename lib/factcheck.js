// Post-generation verification. The model is asked not to invent facts;
// this is the part that actually checks. Every numeric claim in the draft
// must appear somewhere in the context slice that was sent.

// Normalize a numeric token for comparison: strip $, commas, %, whitespace.
function normalizeNum(s) {
  return s.replace(/[$,%\s]/g, "").toLowerCase();
}

// All numeric-looking tokens in a string ("$2,500", "50", "12%", "10k").
function numericTokens(text) {
  return text.match(/\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB]\b)?/g) || [];
}

export function factCheck(answer, contextSlice) {
  const haystack = new Set(
    numericTokens(JSON.stringify(contextSlice)).map(normalizeNum)
  );
  const warnings = [];
  const seen = new Set();
  for (const token of numericTokens(answer)) {
    const norm = normalizeNum(token);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!haystack.has(norm)) {
      warnings.push(`"${token.trim()}" does not appear in your context — verify before submitting.`);
    }
  }
  return warnings;
}

export function extractMissing(answer) {
  const out = [];
  for (const m of answer.matchAll(/\[MISSING:\s*([^\]]+)\]/g)) {
    out.push(m[1].trim());
  }
  return out;
}
