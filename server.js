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

let client = null;
if (process.env.TYPESAFE_API_KEY) {
  client = new TypeSafeClient({
    timeout: TIMEOUT_MS,
    retry: { maxRetries: 0 }, // a stale driving decision is useless, never retry
    logLevel: "warn",
  });
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
    });
  }
  if (req.method === "POST" && url.pathname === "/api/decide") {
    if (!client) return sendJson(res, 503, { error: "TYPESAFE_API_KEY is not configured on the server" });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || typeof body !== "object" || !body.questions) return sendJson(res, 400, { error: "Expected {state, questions}" });
    const t0 = performance.now();
    try {
      const result = await client.systemOne({ state: body.state ?? null, questions: body.questions });
      return sendJson(res, 200, {
        answers: result.answers,
        model: result.model,
        usage: result.usage,
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
    ? `Jev enabled (model: ${client.defaultModel}, timeout ${TIMEOUT_MS}ms)`
    : "TYPESAFE_API_KEY not set: the browser will run the local fallback brain. Copy .env.example to .env to enable Jev.");
});
