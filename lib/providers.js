// Provider adapters. Each exposes: complete({apiKey, model, baseUrl, system, user, maxTokens}) -> string
// Keys never leave the service worker except to the provider the user selected.

async function readError(res) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    detail = await res.text().catch(() => "");
  }
  return `${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`;
}

const anthropic = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  defaultModel: "claude-opus-5",
  fallbackModels: ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"],
  keyUrl: "https://console.anthropic.com/settings/keys",
  async listModels({ apiKey }) {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${await readError(res)}`);
    return (await res.json()).data.map((m) => m.id);
  },
  // Send a PDF (base64) + instruction, get text back.
  async interpret({ apiKey, model, base64, prompt, maxTokens = 8192 }) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${await readError(res)}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("The model declined this request.");
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  },
  async complete({ apiKey, model, system, user, maxTokens = 4096 }) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${await readError(res)}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") {
      throw new Error("The model declined this request (stop_reason: refusal).");
    }
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
};

// Shared implementation for OpenAI-compatible chat/completions endpoints.
function openaiCompatible({ id, label, defaultModel, fallbackModels, keyUrl, endpoint, extraHeaders }) {
  const root = endpoint ? endpoint.replace(/\/chat\/completions$/, "") : null;
  return {
    id,
    label,
    defaultModel,
    fallbackModels: fallbackModels || [],
    keyUrl,
    needsBaseUrl: !endpoint,
    async listModels({ apiKey, baseUrl }) {
      const base = root || baseUrl?.replace(/\/+$/, "");
      if (!base) throw new Error("Set the base URL first.");
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...(extraHeaders || {}) }
      });
      if (!res.ok) throw new Error(`${label} API error: ${await readError(res)}`);
      const data = await res.json();
      return (data.data || []).map((m) => m.id).sort();
    },
    async interpret({ apiKey, model, baseUrl, base64, prompt }) {
      const url = endpoint || `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(extraHeaders || {})
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "file", file: { filename: "pitch_deck.pdf", file_data: `data:application/pdf;base64,${base64}` } },
              { type: "text", text: prompt }
            ]
          }]
        })
      });
      if (!res.ok) throw new Error(`${label} API error: ${await readError(res)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    },
    async complete({ apiKey, model, baseUrl, system, user }) {
      const url = endpoint || `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(extraHeaders || {})
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
      if (!res.ok) throw new Error(`${label} API error: ${await readError(res)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
  };
}

const openai = openaiCompatible({
  id: "openai",
  label: "OpenAI",
  defaultModel: "gpt-4o",
  fallbackModels: ["gpt-4o", "gpt-4o-mini"],
  keyUrl: "https://platform.openai.com/api-keys",
  endpoint: "https://api.openai.com/v1/chat/completions"
});

const openrouter = openaiCompatible({
  id: "openrouter",
  label: "OpenRouter",
  defaultModel: "anthropic/claude-sonnet-4.5",
  fallbackModels: ["anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4.5"],
  keyUrl: "https://openrouter.ai/keys",
  endpoint: "https://openrouter.ai/api/v1/chat/completions"
});

const custom = openaiCompatible({
  id: "custom",
  label: "Custom (OpenAI-compatible)",
  defaultModel: "",
  keyUrl: ""
});

const gemini = {
  id: "gemini",
  label: "Google (Gemini)",
  defaultModel: "gemini-2.5-flash",
  fallbackModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
  keyUrl: "https://aistudio.google.com/apikey",
  async listModels({ apiKey }) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": apiKey }
    });
    if (!res.ok) throw new Error(`Gemini API error: ${await readError(res)}`);
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  },
  async interpret({ apiKey, model, base64, prompt, maxTokens = 8192 }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "application/pdf", data: base64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { maxOutputTokens: maxTokens }
      })
    });
    if (!res.ok) throw new Error(`Gemini API error: ${await readError(res)}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  },
  async complete({ apiKey, model, system, user, maxTokens = 4096 }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens }
      })
    });
    if (!res.ok) throw new Error(`Gemini API error: ${await readError(res)}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");
  }
};

export const PROVIDERS = { anthropic, openai, gemini, openrouter, custom };

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
