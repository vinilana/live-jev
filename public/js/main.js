import { CONFIG } from "./config.js";
import { World } from "./world.js";
import { Course } from "./course.js";
import { PRESETS } from "./presets.js";
import { perceive } from "./sensors.js";
import { Renderer } from "./render.js";
import { QUESTIONS, askBrain, localDecide, gate } from "./brain.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsd = (v) => (v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(5)}`);

const app = {
  health: { jev: false, model: null, llm: false, llmModel: null, pricing: null },
  mode: "single",          // "single" (Jev) | "compare" (Jev vs LLM)
  drivers: [],
  selected: 0,             // which driver's answers are shown in detail
  running: true,
  tool: "cone",
  seed: Date.now() >>> 0,
  course: null,            // one Course shared by every track: identical objects in identical places
  settings: { autoTraffic: true, density: 1, maxSpeedKmh: 45, reflex: true, rays: true, course: "traffic", decisionMs: CONFIG.DECISION_MIN_INTERVAL_MS },
};

// ---------- a Driver = one world + one canvas + one brain
class Driver {
  constructor(kind, canvas, label) {
    this.kind = kind; this.label = label;
    this.renderer = new Renderer(canvas);
    this.canvas = canvas;
    this.reset(app.seed);
  }
  get modelName() {
    if (this.kind === "llm") return app.health.llm ? app.health.llmModel : "LLM (no key)";
    return app.health.jev ? app.health.model : "local fallback";
  }
  reset(seed) {
    if (!app.course || app.course.seed !== seed || app.course.presetId !== app.settings.course) app.course = new Course(seed, app.settings.density, app.settings.course);
    this.world = new World(seed, app.course);
    this.applySettings();
    this.perception = null;
    this.last = { answers: null, intent: null, latency: null, state: null, source: null, error: null, reasoning: "" };
    this.stats = { calls: 0, errors: 0, latencies: [], tokensIn: 0, tokensOut: 0, cost: 0, consecutiveErrors: 0, retryAt: 0, crashedAt: null };
  }
  applySettings() {
    const s = app.settings;
    this.world.autoTraffic = s.autoTraffic; if (app.course) app.course.density = s.density;
    this.world.ego.maxSpeed = s.maxSpeedKmh / 3.6; this.world.ego.reflexEnabled = s.reflex;
    this.renderer.showRays = s.rays;
  }
  frame(dt) {
    const world = this.world;
    this.perception = perceive(world);
    if (app.running && !world.crashed) {
      world.ego.update(dt, this.perception.reflex, world.time);
      world.update(dt);
      if (world.crashed) { this.stats.crashedAt = world.ego.y; log(`[${this.label}] CRASH into ${world.crashed.type} at ${Math.round(world.ego.y)} m`); }
    }
    this.renderer.draw(world, this.perception, {
      mode: this.kind === "llm" ? (app.health.llm ? "llm" : "local") : (app.health.jev ? "jev" : "local"),
      model: this.modelName, label: this.label, latency: this.last.latency, paused: !app.running,
      hazard: this.last.answers ? this.last.answers.hazard.score : 0,
    });
  }
  /** Decision loop: one request in flight at a time, per driver. */
  async loop() {
    for (;;) {
      const world = this.world;
      if (!app.running || world.crashed || !this.perception || app.health.checking || !this.active) { await sleep(80); continue; }
      const remote = this.kind === "llm" ? app.health.llm : app.health.jev;
      const state = this.perception.state;
      const t0 = performance.now();
      let answers, source = "local", error = null, usage = null, cost = 0, reasoning = "";
      const useRemote = remote && (this.stats.consecutiveErrors < 3 || performance.now() > this.stats.retryAt);
      if (useRemote) {
        try {
          const res = await askBrain(this.kind, state);
          answers = res.answers; source = this.kind; usage = res.usage; cost = res.cost || 0; reasoning = res.reasoning || "";
          this.stats.consecutiveErrors = 0;
        } catch (e) {
          error = e.message; this.stats.errors++; this.stats.consecutiveErrors++;
          if (this.stats.consecutiveErrors === 3) { this.stats.retryAt = performance.now() + 10000; log(`[${this.label}] 3 failures in a row: local brain for 10 s`); }
          log(`[${this.label}] error: ${e.message}`);
        }
      }
      if (!answers) answers = localDecide(state);
      const latency = Math.round(performance.now() - t0);
      if (world !== this.world) continue; // restarted meanwhile: drop the stale answer
      const intent = gate(answers, state);
      if (!world.crashed && app.running) world.ego.applyIntent(intent, world.time);
      const st = this.stats;
      st.calls++; st.latencies.push(latency); if (st.latencies.length > 50) st.latencies.shift();
      if (usage) { st.tokensIn += usage.input_tokens || 0; st.tokensOut += usage.output_tokens || 0; }
      st.cost += cost;
      this.last = { answers, intent, latency, state, source, error, reasoning };
      if (app.drivers[app.selected] === this) renderDecision();
      await sleep(Math.max(0, app.settings.decisionMs - latency));
    }
  }
}

// ---------- setup / mode switching
function buildDrivers() {
  const wrapJev = $("trackJev"), wrapLlm = $("trackLlm");
  app.drivers = [new Driver("jev", $("simJev"), "Jev")];
  if (app.mode === "compare") app.drivers.push(new Driver("llm", $("simLlm"), "LLM"));
  wrapLlm.hidden = app.mode !== "compare";
  document.querySelector(".layout").classList.toggle("compare", app.mode === "compare");
  app.drivers.forEach((d) => { d.active = true; d.loop(); });
  app.selected = 0;
  renderTabs();
  $("captionJev").textContent = `Jev · ${app.drivers[0].modelName}`;
  if (app.drivers[1]) $("captionLlm").textContent = `LLM · ${app.drivers[1].modelName}`;
}
function teardownDrivers() { app.drivers.forEach((d) => (d.active = false)); }

async function checkHealth() {
  app.health.checking = true;
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    app.health = { ...h, checking: false };
    log(h.jev ? `Jev connected (model ${h.model})` : "No TYPESAFE_API_KEY on the server: using local fallback brain");
    log(h.llm ? `LLM comparison available (${h.llmModel})` : "No OPENROUTER_API_KEY: comparison mode disabled");
  } catch (e) { app.health.checking = false; log(`health check failed: ${e.message}`); }
  $("modeCompare").disabled = !app.health.llm;
  $("modeHint").textContent = app.health.llm ? "" : "set OPENROUTER_API_KEY to enable";
  updateModeBadge();
  buildDrivers();
}

// ---------- game loop
let lastTs = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000); lastTs = ts;
  for (const d of app.drivers) d.frame(dt);
  updateStats();
  requestAnimationFrame(frame);
}

// ---------- UI rendering
function updateModeBadge() {
  const b = $("modeBadge"); const h = app.health;
  b.textContent = h.jev ? `Jev live · ${h.model}` : "Local fallback (no API key)";
  b.className = "badge " + (h.jev ? "ok" : "warn");
}

function updateStats() {
  const rows = [];
  const cell = (fn) => app.drivers.map((d) => `<td>${fn(d)}</td>`).join("");
  const avgLat = (d) => d.stats.latencies.length ? Math.round(d.stats.latencies.reduce((a, b) => a + b, 0) / d.stats.latencies.length) : 0;
  const perDecision = (d) => (d.stats.calls ? d.stats.cost / d.stats.calls : 0);
  const perHour = (d) => (d.world.time > 5 ? d.stats.cost / d.world.time * 3600 : 0);
  const price = (d) => { const p = app.health.pricing?.[d.kind]; return p ? `$${p.input}/M in · $${p.output}/M out` : "price unknown"; };
  rows.push(`<tr><th></th>${app.drivers.map((d) => `<th class="${d.kind}">${d.label}<small>${d.modelName}</small><small>${price(d)}</small></th>`).join("")}</tr>`);
  rows.push(`<tr><td>status</td>${cell((d) => d.world.crashed ? `<span class="bad">crashed (${d.world.crashed.type})</span>` : `<span class="good">driving</span>`)}</tr>`);
  rows.push(`<tr><td>distance</td>${cell((d) => `${Math.round(d.world.ego.y)} m`)}</tr>`);
  rows.push(`<tr><td>avg speed</td>${cell((d) => `${d.world.time > 1 ? Math.round(d.world.ego.y / d.world.time * 3.6) : 0} km/h`)}</tr>`);
  rows.push(`<tr><td>decisions</td>${cell((d) => `${d.stats.calls}${d.stats.errors ? ` <span class="bad">(${d.stats.errors} err)</span>` : ""}`)}</tr>`);
  rows.push(`<tr><td>avg latency</td>${cell((d) => `${avgLat(d)} ms`)}</tr>`);
  rows.push(`<tr><td>tokens in</td>${cell((d) => d.stats.tokensIn.toLocaleString())}</tr>`);
  rows.push(`<tr><td>tokens out</td>${cell((d) => d.stats.tokensOut.toLocaleString())}</tr>`);
  rows.push(`<tr><td>cost so far</td>${cell((d) => `<b>${fmtUsd(d.stats.cost)}</b>`)}</tr>`);
  rows.push(`<tr><td>cost / decision</td>${cell((d) => fmtUsd(perDecision(d)))}</tr>`);
  rows.push(`<tr><td>cost / km driven</td>${cell((d) => (d.world.ego.y > 20 ? fmtUsd(d.stats.cost / (d.world.ego.y / 1000)) : "–"))}</tr>`);
  rows.push(`<tr><td>cost / hour driving</td>${cell((d) => fmtUsd(perHour(d)))}</tr>`);
  $("statsTable").innerHTML = rows.join("");
  $("stTime").textContent = `${app.drivers[0] ? app.drivers[0].world.time.toFixed(0) : 0} s · ${app.course ? app.course.name : ""} · seed ${app.seed}`;
}

function bar(label, p, active) {
  const pct = Math.round(p * 100);
  return `<div class="bar ${active ? "active" : ""}"><span class="lbl">${label}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>`;
}

function renderTabs() {
  $("tabs").innerHTML = app.drivers.map((d, i) => `<button class="tab ${i === app.selected ? "active" : ""}" data-i="${i}">${d.label} · ${d.modelName}</button>`).join("");
  $("tabs").querySelectorAll(".tab").forEach((b) => (b.onclick = () => { app.selected = Number(b.dataset.i); renderTabs(); renderDecision(); }));
}

function renderDecision() {
  const d = app.drivers[app.selected]; if (!d) return;
  const { answers, intent, latency, state, source, error, reasoning } = d.last;
  if (!answers) { $("decision").innerHTML = `<div class="muted">waiting for first decision…</div>`; return; }
  const la = answers.lane_action, sa = answers.speed_action, hz = answers.hazard, py = answers.pedestrian_yield;
  const src = source === "local" ? `<span class="tag warn">local</span>` : `<span class="tag ok">${source}</span>`;
  $("decision").innerHTML = `
    <div class="qrow"><div class="qhead">${src} <b>lane_action</b> <span class="muted">choice · conf ${la.confidence.toFixed(2)} · ${latency} ms</span></div>
      ${Object.keys(QUESTIONS.lane_action.criteria).map((k) => bar(k, la.probabilities[k] ?? 0, k === la.choice)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>speed_action</b> <span class="muted">choice · conf ${sa.confidence.toFixed(2)}</span></div>
      ${Object.keys(QUESTIONS.speed_action.criteria).map((k) => bar(k, sa.probabilities[k] ?? 0, k === sa.choice)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>hazard</b> <span class="muted">score ${hz.score.toFixed(2)} / 3 · conf ${hz.confidence.toFixed(2)}</span></div>
      ${[0, 1, 2, 3].map((k) => bar(["none", "low", "moderate", "severe"][k], hz.probabilities[k] ?? 0, Math.round(hz.score) === k)).join("")}</div>
    <div class="qrow"><div class="qhead"><b>pedestrian_yield</b> <span class="muted">noul</span></div>${bar("yes", py.noul, py.noul >= CONFIG.PED_YIELD_THRESHOLD)}</div>
    <div class="intent">→ executing <b>${intent.laneAction}</b> + <b>${intent.speedAction}</b>${intent.notes.length ? `<div class="notes">${intent.notes.map((n) => "⚑ " + n).join("<br>")}</div>` : ""}${reasoning ? `<div class="reasoning">💭 ${reasoning}</div>` : ""}${error ? `<div class="err">${error}</div>` : ""}</div>`;
  $("stateJson").textContent = JSON.stringify(state, null, 1);
}

function log(msg) {
  const el = $("log");
  const line = document.createElement("div");
  const t = app.drivers[0] ? app.drivers[0].world.time : 0;
  line.textContent = `${t.toFixed(1)}s  ${msg}`;
  el.prepend(line);
  while (el.children.length > 80) el.lastChild.remove();
}

function restart() {
  const seedInput = $("seed").value.trim();
  app.seed = seedInput ? Number(seedInput) : (Date.now() >>> 0);
  app.course = new Course(app.seed, app.settings.density, app.settings.course);
  for (const d of app.drivers) d.reset(app.seed);
  $("log").innerHTML = "";
  app.running = true; $("pause").textContent = "Pause";
  renderDecision();
  log(`restarted · course "${app.course.name}" · seed ${app.seed}${app.drivers.length > 1 ? " · both tracks share the course" : ""}`);
}

function setMode(mode) {
  if (mode === app.mode) return;
  teardownDrivers();
  app.mode = mode;
  buildDrivers();
  restart();
}

function wireUi() {
  $("restart").onclick = restart;
  $("pause").onclick = () => { app.running = !app.running; $("pause").textContent = app.running ? "Pause" : "Resume"; };
  $("spawn").onclick = () => {
    const ev = app.course.randomEvent(); // same object, same distance ahead, on every track
    for (const d of app.drivers) d.world.spawnEvent(ev, d.world.ego.y);
    log(`spawned ${ev.type} ${Math.round(ev.offset)} m ${ev.offset < 0 ? "behind" : "ahead"}${app.drivers.length > 1 ? " (both tracks)" : ""}`);
  };
  const sel = $("course");
  for (const [id, p] of Object.entries(PRESETS)) { const o = document.createElement("option"); o.value = id; o.textContent = p.name; sel.appendChild(o); }
  sel.value = app.settings.course;
  const showCourseInfo = () => { $("courseInfo").textContent = PRESETS[sel.value].description; };
  showCourseInfo();
  sel.onchange = () => { app.settings.course = sel.value; showCourseInfo(); restart(); };
  $("modeSingle").onchange = () => setMode("single");
  $("modeCompare").onchange = () => setMode("compare");
  const applyAll = () => app.drivers.forEach((d) => d.applySettings());
  $("autoTraffic").onchange = (e) => { app.settings.autoTraffic = e.target.checked; applyAll(); };
  $("density").oninput = (e) => { app.settings.density = Number(e.target.value); $("densityVal").textContent = `${e.target.value}×`; applyAll(); };
  $("maxSpeed").oninput = (e) => { app.settings.maxSpeedKmh = Number(e.target.value); $("maxSpeedVal").textContent = `${e.target.value} km/h`; applyAll(); };
  $("reflex").onchange = (e) => { app.settings.reflex = e.target.checked; applyAll(); };
  $("decisionMs").oninput = (e) => { app.settings.decisionMs = Number(e.target.value); $("decisionMsVal").textContent = `${e.target.value} ms`; };
  $("rays").onchange = (e) => { app.settings.rays = e.target.checked; applyAll(); };
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.onclick = () => { app.tool = btn.dataset.tool; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b === btn)); };
  });

  // Clicks on either track place the object in every world (same world coordinates), so the comparison stays fair.
  for (const canvas of [$("simJev"), $("simLlm")]) {
    const toWorld = (ev, d) => {
      const r = canvas.getBoundingClientRect();
      const sx = (ev.clientX - r.left) * (canvas.width / r.width), sy = (ev.clientY - r.top) * (canvas.height / r.height);
      return d.renderer.toWorld(sx, sy, d.world.ego.y);
    };
    canvas.addEventListener("click", (ev) => {
      const src = app.drivers.find((d) => d.canvas === canvas) || app.drivers[0];
      const [x, y] = toWorld(ev, src);
      if (Math.abs(x) > CONFIG.LANES * CONFIG.LANE_W / 2 + CONFIG.SIDEWALK_W + 1 && app.tool !== "remove") return;
      // keep the same distance ahead of each car
      const ahead = y - src.world.ego.y;
      for (const d of app.drivers) {
        const o = d.world.placeAt(app.tool, x, d.world.ego.y + ahead);
        if (o && d === src) log(`you placed ${o.type} ${Math.round(ahead)} m ahead${app.drivers.length > 1 ? " (both tracks)" : ""}`);
      }
    });
    canvas.addEventListener("mousemove", (ev) => {
      const src = app.drivers.find((d) => d.canvas === canvas); if (!src) return;
      const [x, y] = toWorld(ev, src);
      src.renderer.ghost = app.tool === "remove" ? null : { type: app.tool, x, y };
    });
    canvas.addEventListener("mouseleave", () => { const src = app.drivers.find((d) => d.canvas === canvas); if (src) src.renderer.ghost = null; });
  }

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
