# Local OpenAI-compatible mock provider for demoing Lore without an API key.
# Speaks /v1/models and /v1/chat/completions with CORS, so the extension's
# "Custom (OpenAI-compatible)" provider works against http://localhost:8998/v1.
import json, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def deep_get(d, path, default=""):
    for k in path.split("."):
        if not isinstance(d, dict) or k not in d:
            return default
        d = d[k]
    if isinstance(d, dict) and "value" in d:
        return d["value"]
    return d

def revise_answer(user_msg):
    import re as _re
    draft = _re.search(r"CURRENT DRAFT[^:]*:\n(.*?)\n\nREVISION REQUEST", user_msg, _re.S)
    instr = _re.search(r"REVISION REQUEST FROM THE FOUNDER:\n(.*?)\n\nRevise", user_msg, _re.S)
    draft = draft.group(1).strip() if draft else ""
    instr = (instr.group(1).strip() if instr else "").lower()
    if not draft:
        return "[MISSING: no draft to revise]"
    if "short" in instr or "concise" in instr or "trim" in instr:
        return draft.split(". ")[0].rstrip(".") + "."
    m = _re.search(r"(?:mention|add|include)\s+(.*)", instr)
    if m:
        extra_bit = m.group(1).strip().rstrip(".")
        return draft.rstrip(".") + ". " + extra_bit[0].upper() + extra_bit[1:] + "."
    return draft  # unknown instruction: mock keeps it as-is

def choose_options(user_msg):
    # Mimic a model answering multiple-choice from context values; skip when
    # the context doesn't determine the answer.
    ctx_vals = [l.split(": ", 1)[1].strip().lower()
                for l in user_msg.split("CONTEXT VALUES:")[1].split("CHOICE FIELDS:")[0].strip().splitlines()
                if ": " in l]
    out = []
    for b in re.split(r"\n(?=\d+\. )", user_msg.split("CHOICE FIELDS:")[1].strip()):
        m = re.match(r"(\d+)\.\s+(.*)", b)
        if not m:
            continue
        i, label = int(m.group(1)), m.group(2).lower()
        opts = re.findall(r"^\s+(\d+)\.\s+(.*)$", b, re.M)
        pick = None
        if "technical" in label:
            tech = any(("technical" in v or "engineer" in v) for v in ctx_vals)
            for n, o in opts:
                if o.strip().lower() == ("yes" if tech else "no"):
                    pick = [int(n)]
        elif "incorporat" in label:
            neg = any("not" in v and "incorporat" in v for v in ctx_vals)
            for n, o in opts:
                if o.strip().lower() == ("no" if neg else "yes"):
                    pick = [int(n)]
        else:
            for n, o in opts:
                ol = o.strip().lower()
                if any(ol == v or (len(ol) >= 4 and len(v) >= 4 and (ol in v or v in ol)) for v in ctx_vals):
                    pick = [int(n)]
                    break
        out.append({"i": i, "pick": pick} if pick else {"i": i, "skip": True})
    return json.dumps(out)

def map_fields(user_msg):
    # Mimic a capable model mapping arbitrary field labels to context paths.
    out = []
    for line in user_msg.split("FORM FIELDS:")[1].strip().splitlines():
        m = re.match(r"\s*(\d+)\.\s+(.*?)\s*\((short input|long text)\)\s*$", line)
        if not m:
            continue
        i, label, kind = int(m.group(1)), m.group(2).lower(), m.group(3)
        if kind == "long text":
            out.append({"i": i, "draft": True})
        elif any(w in label for w in ["online", "website", "url of", "web presence", "homepage"]):
            out.append({"i": i, "path": "company.website"})
        elif any(w in label for w in ["link to it", "product link", "link to your product"]):
            out.append({"i": i, "path": "company.website"})
        elif "deck" in label or "slides" in label:
            out.append({"i": i, "path": "company.deck_url"})
        elif "raising" in label or "round" in label:
            out.append({"i": i, "path": "fundraising.target_amount"})
        else:
            out.append({"i": i, "skip": True})
    return json.dumps(out)

def pick_paths(user_msg):
    paths = [l.split(" (empty)")[0].strip() for l in
             user_msg.split("Available paths:")[1].split("Question:")[0].strip().splitlines()]
    q = user_msg.split("Question:")[-1].lower()
    sections = {"company"}
    if any(w in q for w in ["traction", "revenue", "customers", "users", "metrics", "growth", "progress", "milestone", "so far"]):
        sections |= {"traction", "validation"}
    if any(w in q for w in ["team", "founder", "met", "who"]):
        sections |= {"founders"}
    if any(w in q for w in ["join", "accelerator", "program", "cohort", "batch", "why do you want"]):
        sections |= {"programs"}
    if any(w in q for w in ["business", "pricing", "monetize", "revenue model"]):
        sections |= {"business"}
    if any(w in q for w in ["market", "customer", "competitor"]):
        sections |= {"market"}
    chosen = [p for p in paths if p.split(".")[0] in sections]
    return json.dumps(chosen)

def draft_answer(user_msg):
    m = re.search(r"FOUNDER CONTEXT \(the only source of facts\):\n(\{.*?\})\n\n---", user_msg, re.S)
    ctx = json.loads(m.group(1)) if m else {}
    q = user_msg.split("APPLICATION QUESTION:")[-1].lower()
    pc = deep_get(ctx, "traction.paying_customers")
    conv = deep_get(ctx, "traction.customer_conversations")
    rev = deep_get(ctx, "traction.revenue")
    growth = deep_get(ctx, "traction.growth_rate")
    one = deep_get(ctx, "company.one_liner")
    if "growth" in q:
        base = f"Revenue to date is {rev} from {pc} paying customers."
        return base + (f" Monthly growth is {growth}." if growth else " [MISSING: monthly growth rate]")
    if any(w in q for w in ["traction", "progress", "metrics"]):
        if not pc and not rev:
            return "[MISSING: traction numbers]"
        return (f"We have {pc} paying customers and {rev} in revenue to date, "
                f"after {conv} customer conversations. Both customers pay monthly and use "
                f"the product in production.")
    # team / co-founder questions: compose ONLY from founders data
    if any(w in q for w in ["founder", "team", "met", "who are you"]):
        founders = [f for f in ctx.get("founders", []) if f.get("name")]
        if not founders:
            return "[MISSING: founder names and backgrounds]"
        if len(founders) == 1:
            f = founders[0]
            bits = [f"I'm {f['name']}, a solo founder."]
            if f.get("background"): bits.append(f["background"])
            if f.get("founder_story"): bits.append(f["founder_story"])
            if "met" in q or "meet" in q:
                bits.append("There are no co-founders to have met — I'm building this alone.")
            return " ".join(bits)
        parts = [f"{f['name']} ({f.get('role') or 'co-founder'}): {f.get('background') or ''}".strip() for f in founders]
        out = "We are " + "; ".join(parts) + "."
        if "met" in q or "meet" in q:
            out += " [MISSING: how the founders met]"
        return out
    # why-join / program questions: compose ONLY from program goals + why_us
    if any(w in q for w in ["join", "accelerator", "program", "cohort", "batch"]):
        goals = deep_get(ctx, "programs.program_goals")
        why_us = deep_get(ctx, "company.why_us")
        bits = [b for b in [goals, why_us] if b]
        return " ".join(bits) if bits else "[MISSING: what you want to get out of this program]"
    if any(w in q for w in ["what does", "describe your company", "what are you building"]):
        return one or "[MISSING: company description]"
    return "[MISSING: no information about this in the founder context]"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._send(200, {"data": [{"id": "mock-claude-demo"}]})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._send(404, {"error": {"message": "not found"}})
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user_msg = next((m["content"] for m in body["messages"] if m["role"] == "user"), "")
        if "REVISION REQUEST FROM THE FOUNDER:" in user_msg:
            content = revise_answer(user_msg)
        elif "CHOICE FIELDS:" in user_msg and "CONTEXT VALUES:" in user_msg:
            content = choose_options(user_msg)
        elif "FORM FIELDS:" in user_msg and "CONTEXT PATHS:" in user_msg:
            content = map_fields(user_msg)
        elif "Available paths:" in user_msg:
            content = pick_paths(user_msg)
        else:
            content = draft_answer(user_msg)
        self._send(200, {"choices": [{"message": {"role": "assistant", "content": content}}]})

ThreadingHTTPServer(("127.0.0.1", 8998), H).serve_forever()
