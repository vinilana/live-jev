import { CONFIG } from "./config.js";
import { World } from "./world.js";
import { perceive } from "./sensors.js";
import { Renderer } from "./render.js";
import { QUESTIONS, askJev, localDecide, gate } from "./brain.js";

const $ = (id) => document.getElementById(id);
const canvas = $("sim");
const renderer = new Renderer(canvas);

const app = {
  world: new World(),
  gen: 0,                 // bumped on restart so stale Jev answers are dropped
  running: true,
  mode: "checking",       // "jev" | "local" | "checking"
  model: null,
  tool: "cone",
  perception: null,
  last: { answers: null, intent: null, latency: null, state: null, source: null, error: null },
  stats: { calls: 0, errors: 0, latencies: [], tokensIn: 0, tokensOut: 0, consecutiveErrors: 0, jevRetryAt: 0 },
};

// ---------- health check: does the server have a Jev key?
async function checkHealth() {
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    app.mode = h.jev ? "jev" : "local";
    app.model = h.model;
    log(h.jev ? `Jev connected (model ${h.model})` : "No TYPESAFE_API_KEY on the server: using local fallback brain");
  } catch (e) {
    app.mode = "local"; log(`health check failed: ${e.message}`);
  }
  updateModeBadge();
}

// ---------- game loop (60 fps physics + render)
let lastTs = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000); lastTs = ts;
  const { world } = app;
  app.perception = perceive(world);
  if (app.running && !world.crashed) {
    world.ego.update(dt, app.perception.reflex, world.time);
    world.update(dt);
    if (world.crashed) { onCrash(); }
  }
  renderer.draw(world, app.perception, {
    mode: app.mode, model: app.model, latency: app.last.latency, paused: !app.running,
    hazard: app.last.answers ? app.last.answers.hazard.score : 0,
  });
  updateStats();
  requestAnimationFrame(frame);
}

// ---------- decision loop: one Jev call in flight at a time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function brainLoop() {
  for (;;) {
    const { world } = app;
    if (!app.running || world.crashed || !app.perception || app.mode === "checking") { await sleep(80); continue; }
    const gen = app.gen;
    const state = app.perception.state;
    const t0 = performance.now();
    let answers, source = "local", error = null, usage = null;
    const useJev = app.mode === "jev" && (app.stats.consecutiveErrors < 3 || performance.now() > app.stats.jevRetryAt);
    if (useJev) {
      try {
        const res = await askJev(state);
        answers = res.answers; source = "jev"; usage = res.usage;
        app.stats.consecutiveErrors = 0;
      } catch (e) {
        error = e.message; app.stats.errors++; app.stats.consecutiveErrors++;
        if (app.stats.consecutiveErrors === 3) { app.stats.jevRetryAt = performance.now() + 10000; log("Jev failed 3× in a row: falling back to local brain for 10 s"); }
        log(`Jev error: ${e.message}`);
      }
    }
    if (!answers) answers = localDecide(state);
    const latency = Math.round(performance.now() - t0);
    if (gen !== app.gen) continue; // world was restarted meanwhile
    const intent = gate(answers, state);
    if (!app.world.crashed && app.running) app.world.ego.applyIntent(intent, app.world.time);
    app.stats.calls++; app.stats.latencies.push(latency); if (app.stats.latencies.length > 50) app.stats.latencies.shift();
    if (usage) { app.stats.tokensIn += usage.input_tokens || 0; app.stats.tokensOut += usage.output_tokens || 0; }
    app.last = { answers, intent, latency, state, source, error };
    renderDecision();
    await sleep(Math.max(0, CONFIG.DECISION_MIN_INTERVAL_MS - latency));
  }
}

// ---------- UI
function updateModeBadge() {
  const b = $("modeBadge");
  b.textContent = app.mode === "jev" ? `Jev live · ${app.model}` : app.mode === "local" ? "Local fallback (no API key)" : "checking…";
  b.className = "badge " + (app.mode === "jev" ? "ok" : "warn");
}

function updateStats() {
  const { world, stats } = app;
  const avg = stats.latencies.length ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length) : 0;
  $("stDist").textContent = `${Math.round(world.ego.y)} m`;
  $("stTime").textContent = `${world.time.toFixed(0)} s`;
  $("stCalls").textContent = `${stats.calls}${stats.errors ? ` (${stats.errors} err)` : ""}`;
  $("stLatency").textContent = `${avg} ms`;
  $("stTokens").textContent = `${stats.tokensIn + stats.tokensOut}`;
  $("stObjects").textContent = `${world.objects.length}`;
}

function bar(label, p, active) {
  const pct = Math.round(p * 100);
  return `<div class="bar ${active ? "active" : ""}"><span class="lbl">${label}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>`;
}

function renderDecision() {
  const { answers, intent, latency, state, source, error } = app.last;
  if (!answers) return;
  const la = answers.lane_action, sa = answers.speed_action, hz = answers.hazard, py = answers.pedestrian_yield;
  const src = source === "jev" ? `<span class="tag ok">jev</span>` : `<span class="tag warn">local</span>`;
  $("decision").innerHTML = `
    <div class="qrow"><div class="qhead">${src} <b>lane_action</b> <span class="muted">choice · conf ${la.confidence.toFixed(2)} · ${latency} ms</span></div>
      ${Object.keys(QUESTIONS.lane_action.criteria).map((k) => bar(k, la.probabilities[k] ?? 0, k === la.choice)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>speed_action</b> <span class="muted">choice · conf ${sa.confidence.toFixed(2)}</span></div>
      ${Object.keys(QUESTIONS.speed_action.criteria).map((k) => bar(k, sa.probabilities[k] ?? 0, k === sa.choice)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>hazard</b> <span class="muted">score ${hz.score.toFixed(2)} / 3 · conf ${hz.confidence.toFixed(2)}</span></div>
      ${[0, 1, 2, 3].map((k) => bar(["none", "low", "moderate", "severe"][k], hz.probabilities[k] ?? 0, Math.round(hz.score) === k)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>pedestrian_yield</b> <span class="muted">noul</span></div>${bar("yes", py.noul, py.noul >= CONFIG.PED_YIELD_THRESHOLD)}</div>
    <div class="intent">→ executing <b>${intent.laneAction}</b> + <b>${intent.speedAction}</b>${intent.notes.length ? `<div class="notes">${intent.notes.map((n) => "⚑ " + n).join("<br>")}</div>` : ""}${error ? `<div class="err">${error}</div>` : ""}</div>`;
  $("stateJson").textContent = JSON.stringify(state, null, 1);
}

function log(msg) {
  const el = $("log");
  const line = document.createElement("div");
  line.textContent = `${app.world.time.toFixed(1)}s  ${msg}`;
  el.prepend(line);
  while (el.children.length > 60) el.lastChild.remove();
}

function onCrash() {
  log(`CRASH into ${app.world.crashed.type}`);
}

function restart() {
  const seedInput = $("seed").value.trim();
  const seed = seedInput ? Number(seedInput) : (Date.now() & 0xffffffff);
  app.world = new World(seed);
  app.world.autoTraffic = $("autoTraffic").checked;
  app.world.density = Number($("density").value);
  app.world.ego.maxSpeed = Number($("maxSpeed").value) / 3.6;
  app.world.ego.reflexEnabled = $("reflex").checked;
  app.gen++;
  app.last = { answers: null, intent: null, latency: null, state: null, source: null, error: null };
  app.stats.calls = 0; app.stats.errors = 0; app.stats.latencies = []; app.stats.tokensIn = 0; app.stats.tokensOut = 0;
  $("decision").innerHTML = `<div class="muted">waiting for first decision…</div>`;
  $("log").innerHTML = "";
  app.running = true; $("pause").textContent = "Pause";
  log(`restarted (seed ${seed})`);
}

function wireUi() {
  $("restart").onclick = restart;
  $("pause").onclick = () => { app.running = !app.running; $("pause").textContent = app.running ? "Pause" : "Resume"; };
  $("spawn").onclick = () => { for (let i = 0; i < 6 && !app.world.spawnRandom(); i++); log("spawned a random object"); };
  $("autoTraffic").onchange = (e) => (app.world.autoTraffic = e.target.checked);
  $("density").oninput = (e) => { app.world.density = Number(e.target.value); $("densityVal").textContent = `${e.target.value}×`; };
  $("maxSpeed").oninput = (e) => { app.world.ego.maxSpeed = Number(e.target.value) / 3.6; $("maxSpeedVal").textContent = `${e.target.value} km/h`; };
  $("reflex").onchange = (e) => (app.world.ego.reflexEnabled = e.target.checked);
  $("rays").onchange = (e) => (renderer.showRays = e.target.checked);
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.onclick = () => { app.tool = btn.dataset.tool; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b === btn)); };
  });

  const toWorld = (ev) => {
    const r = canvas.getBoundingClientRect();
    const sx = (ev.clientX - r.left) * (canvas.width / r.width), sy = (ev.clientY - r.top) * (canvas.height / r.height);
    return renderer.toWorld(sx, sy, app.world.ego.y);
  };
  canvas.addEventListener("click", (ev) => {
    const [x, y] = toWorld(ev);
    if (app.tool === "remove") { app.world.placeAt("remove", x, y); return; }
    if (Math.abs(x) > CONFIG.LANES * CONFIG.LANE_W / 2 + CONFIG.SIDEWALK_W + 1) return;
    const o = app.world.placeAt(app.tool, x, y);
    if (o) log(`you placed ${o.type}`);
  });
  canvas.addEventListener("mousemove", (ev) => {
    const [x, y] = toWorld(ev);
    renderer.ghost = app.tool === "remove" ? null : { type: app.tool, x, y };
  });
  canvas.addEventListener("mouseleave", () => (renderer.ghost = null));

  window.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "INPUT") return;
    if (ev.key === " ") { ev.preventDefault(); $("pause").click(); }
    if (ev.key === "r" || ev.key === "R") restart();
    const tools = ["cone", "barrier", "parked_car", "car", "truck", "pedestrian", "remove"];
    if (ev.key >= "1" && ev.key <= "7") document.querySelector(`[data-tool="${tools[Number(ev.key) - 1]}"]`).click();
  });
  $("questionsJson").textContent = JSON.stringify(QUESTIONS, null, 1);
}

wireUi();
checkHealth();
requestAnimationFrame(frame);
brainLoop();
