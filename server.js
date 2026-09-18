// Static file server + proxy to TypeSafe's Jev API.
// The browser never sees the API key: it POSTs {state, questions} to /api/decide
// and this server forwards the call through the official SDK.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient, APIError } from "@typesafe-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch { /* no .env, use process env */ }

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 4000);

// Pricing (USD per million tokens). Jev: $0.042/M input, output free (TypeSafe's advertised rate).
const PRICING = {
  jev: { input: Number(process.env.JEV_PRICE_INPUT_PER_M ?? 0.042), output: Number(process.env.JEV_PRICE_OUTPUT_PER_M ?? 0) },
  llm: { input: Number(process.env.LLM_PRICE_INPUT_PER_M ?? 0), output: Number(process.env.LLM_PRICE_OUTPUT_PER_M ?? 0) },
};
const costOf = (kind, inTok, outTok) => (inTok * PRICING[kind].input + outTok * PRICING[kind].output) / 1e6;

// Running totals since the server started, to reconcile with the providers' consoles.
const TOTALS = { since: new Date().toISOString(), jev: { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 }, llm: { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 } };
function tally(kind, usage, cost) {
  const t = TOTALS[kind]; t.calls++; t.input_tokens += usage?.input_tokens || 0; t.output_tokens += usage?.output_tokens || 0; t.cost += cost || 0;
}

let client = null;
if (process.env.TYPESAFE_API_KEY) {
  client = new TypeSafeClient({
    timeout: TIMEOUT_MS,
    retry: { maxRetries: 0 }, // a stale driving decision is useless, never retry
    logLevel: "warn",
  });
}

// ---- Optional LLM brain through OpenRouter (for side-by-side comparison with Jev).
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const LLM_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
const LLM_REASONING = process.env.OPENROUTER_REASONING || ""; // e.g. "low" to let the LLM think before answering
const llmEnabled = Boolean(OPENROUTER_KEY);

async function loadLlmPricing() {
  if (!llmEnabled || PRICING.llm.input > 0) return;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    const { data } = await res.json();
    const m = data.find((x) => x.id === LLM_MODEL);
    if (m) { PRICING.llm.input = Number(m.pricing.prompt) * 1e6; PRICING.llm.output = Number(m.pricing.completion) * 1e6; }
    console.log(`LLM pricing for ${LLM_MODEL}: $${PRICING.llm.input}/M in, $${PRICING.llm.output}/M out`);
  } catch (e) { console.warn(`[llm] could not load pricing: ${e.message}`); }
}

const LLM_SYSTEM = `You are the driving policy of an autonomous car in a 2D simulation. You will receive a JSON "state"
(the car's perception) and a set of typed "questions". Answer every question strictly following its type:
- choice: pick exactly one of the criteria keys; also give a probability for every key (summing to 1) and a confidence 0-1.
- score: give a number between 0 and (number of levels - 1), a probability for every level index ("0","1",...) and a confidence 0-1.
- noul: give the probability 0-1 that the statement is true.
Respond with ONLY one JSON object, no markdown. Example of the exact shape (values are illustrative):
{"answers":{
  "lane_action":{"choice":"keep_lane","probabilities":{"keep_lane":0.8,"change_left":0.15,"change_right":0.05},"confidence":0.8},
  "speed_action":{"choice":"hold","probabilities":{"stop":0.0,"slow_down":0.1,"hold":0.7,"speed_up":0.2},"confidence":0.7},
  "hazard":{"score":1.2,"probabilities":{"0":0.1,"1":0.6,"2":0.3,"3":0.0},"confidence":0.6},
  "pedestrian_yield":{"noul":0.05}
},"reasoning":"one short sentence explaining the decision"}`;

/** Ask the LLM the same questions Jev gets and normalise its answer into Jev's shape. */
async function llmDecide(state, questions) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost", "X-Title": "live-jev sim" },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: 900,
        // Thinking mode would spend seconds (and tokens) before the JSON; keep it off unless asked.
        reasoning: LLM_REASONING ? { effort: LLM_REASONING } : { enabled: false },
        response_format: { type: "json_object" },
        usage: { include: true },
        messages: [
          { role: "system", content: LLM_SYSTEM },
          { role: "user", content: `questions:\n${JSON.stringify(questions)}\n\nstate:\n${JSON.stringify(state)}` },
        ],
      }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw Object.assign(new Error(body.error?.message || `HTTP ${res.status}`), { status: res.status });
    const text = body.choices?.[0]?.message?.content || "";
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* try to salvage an object from the text */ }
    if (!parsed) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* logged below */ } } }
    if (!parsed || !parsed.answers) {
      const choice = body.choices?.[0] || {};
      console.warn(`[llm] unparseable reply (finish=${choice.finish_reason}, reasoning=${(choice.message?.reasoning || "").length} chars): ${JSON.stringify(text).slice(0, 400)}`);
      throw new Error(`LLM returned no answers JSON (finish_reason=${choice.finish_reason})`);
    }
    const answers = normalizeAnswers(parsed.answers, questions);
    const u = body.usage || {};
    const usage = { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 };
    const cost = typeof u.cost === "number" ? u.cost : costOf("llm", usage.input_tokens, usage.output_tokens);
    return { answers, usage, cost, model: body.model || LLM_MODEL, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 300) : "" };
  } finally { clearTimeout(timer); }
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
function normalizeAnswers(raw, questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id] || {};
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      let probs = {}; let sum = 0;
      for (const k of keys) { probs[k] = clamp01(a.probabilities?.[k]); sum += probs[k]; }
      let choice = keys.includes(a.choice) ? a.choice : null;
      if (sum <= 0) { choice = choice || keys[0]; for (const k of keys) probs[k] = k === choice ? 1 : 0; sum = 1; }
      for (const k of keys) probs[k] = probs[k] / sum;
      if (!choice) choice = keys.reduce((b, k) => (probs[k] > probs[b] ? k : b), keys[0]);
      out[id] = { type: "choice", choice, probabilities: probs, confidence: a.confidence != null ? clamp01(a.confidence) : probs[choice] };
    } else if (q.type === "score") {
      const n = q.criteria.length; const probs = {}; let sum = 0;
      for (let i = 0; i < n; i++) { probs[i] = clamp01(a.probabilities?.[i] ?? a.probabilities?.[String(i)]); sum += probs[i]; }
      let score = Number(a.score);
      if (!Number.isFinite(score)) score = sum > 0 ? Object.entries(probs).reduce((acc, [i, p]) => acc + Number(i) * p, 0) / sum : 0;
      score = Math.max(0, Math.min(n - 1, score));
      if (sum <= 0) { const r = Math.round(score); for (let i = 0; i < n; i++) probs[i] = i === r ? 1 : 0; sum = 1; }
      for (let i = 0; i < n; i++) probs[i] = probs[i] / sum;
      const legend = {}; q.criteria.forEach((c, i) => (legend[i] = c));
      out[id] = { type: "score", score, probabilities: probs, legend, confidence: a.confidence != null ? clamp01(a.confidence) : Math.max(...Object.values(probs)) };
    } else {
      out[id] = { type: "noul", noul: clamp01(a.noul ?? a.probability ?? a.yes) };
    }
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      jev: Boolean(client),
      model: client ? client.defaultModel : null,
      timeoutMs: TIMEOUT_MS,
      llm: llmEnabled,
      llmModel: llmEnabled ? LLM_MODEL : null,
      pricing: PRICING,
      totals: TOTALS,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/llm-decide") {
    if (!llmEnabled) return sendJson(res, 503, { error: "OPENROUTER_API_KEY is not configured on the server" });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || typeof body !== "object" || !body.questions) return sendJson(res, 400, { error: "Expected {state, questions}" });
    const t0 = performance.now();
    try {
      const r = await llmDecide(body.state ?? null, body.questions);
      tally("llm", r.usage, r.cost);
      return sendJson(res, 200, { ...r, latencyMs: Math.round(performance.now() - t0) });
    } catch (err) {
      console.error(`[llm] ${err.name}: ${err.message}`);
      const status = err.name === "AbortError" ? 504 : (err.status >= 400 && err.status < 600 ? err.status : 502);
      return sendJson(res, status, { error: err.name === "AbortError" ? `LLM timed out after ${LLM_TIMEOUT_MS}ms` : err.message, latencyMs: Math.round(performance.now() - t0) });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/decide") {
    if (!client) return sendJson(res, 503, { error: "TYPESAFE_API_KEY is not configured on the server" });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || typeof body !== "object" || !body.questions) return sendJson(res, 400, { error: "Expected {state, questions}" });
    const t0 = performance.now();
    try {
      const result = await client.systemOne({ state: body.state ?? null, questions: body.questions });
      const cost = costOf("jev", result.usage?.input_tokens || 0, result.usage?.output_tokens || 0);
      tally("jev", result.usage, cost);
      return sendJson(res, 200, {
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        cost,
        latencyMs: Math.round(performance.now() - t0),
      });
    } catch (err) {
      const status = err instanceof APIError ? err.status : 502;
      const detail = err instanceof APIError ? err.body : undefined;
      console.error(`[jev] ${err.name}: ${err.message}`);
      return sendJson(res, status >= 400 && status < 600 ? status : 502, {
        error: err.message, name: err.name, detail, latencyMs: Math.round(performance.now() - t0),
      });
    }
  }
  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url).catch((e) => sendJson(res, 500, { error: e.message }));
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Self-driving sim on http://localhost:${PORT}`);
  console.log(client
    ? `Jev enabled (model: ${client.defaultModel}, timeout ${TIMEOUT_MS}ms, $${PRICING.jev.input}/M in)`
    : "TYPESAFE_API_KEY not set: the browser will run the local fallback brain. Copy .env.example to .env to enable Jev.");
  console.log(llmEnabled
    ? `LLM comparison enabled via OpenRouter (model: ${LLM_MODEL}, timeout ${LLM_TIMEOUT_MS}ms)`
    : "OPENROUTER_API_KEY not set: the Jev vs LLM comparison mode is disabled.");
  loadLlmPricing();
});
