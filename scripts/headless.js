// Headless run of the simulation with the local fallback brain (no browser, no Jev).
// Usage: node scripts/headless.js [seconds] [seed] [decisionIntervalMs]
import { World } from "../public/js/world.js";
import { perceive } from "../public/js/sensors.js";
import { localDecide, gate, QUESTIONS } from "../public/js/brain.js";

// BRAIN=jev uses the running server (http://localhost:3000) for real Jev decisions.
const useJev = process.env.BRAIN === "jev";
const serverUrl = process.env.SERVER || "http://localhost:3000";
async function decide(state) {
  if (!useJev) return { answers: localDecide(state), ms: 0 };
  const t0 = Date.now();
  try {
    const r = await fetch(`${serverUrl}/api/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, questions: QUESTIONS }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return { answers: j.answers, ms: Date.now() - t0 };
  } catch (e) { // same policy as the browser: one failed call falls back to the local brain for that tick
    jevErrors++;
    return { answers: localDecide(state), ms: Date.now() - t0, error: e.message };
  }
}
let jevErrors = 0;

const seconds = Number(process.argv[2] || 120);
const seed = Number(process.argv[3] || 42);
const interval = Number(process.argv[4] || 400) / 1000; // emulate Jev latency
const dt = 1 / 60;

const world = new World(seed);
let nextDecision = 0, decisions = 0, laneChanges = 0, reflexTicks = 0, minTtc = Infinity, jevMs = 0;
const speeds = []; const trace = []; const counts = {};
while (world.time < seconds && !world.crashed) {
  const p = perceive(world);
  if (world.time >= nextDecision) {
    const { answers, ms } = await decide(p.state);
    jevMs += ms;
    const intent = gate(answers, p.state);
    counts[intent.speedAction] = (counts[intent.speedAction] || 0) + 1;
    if (intent.laneAction !== "keep_lane" && !world.ego.laneChanging) laneChanges++;
    world.ego.applyIntent(intent, world.time);
    if (useJev && process.env.TRACE) trace.push(`  jev@${world.time.toFixed(1)}s ${ms}ms v=${Math.round(world.ego.speed * 3.6)} speed=${intent.speedAction}(jev:${answers.speed_action.choice}) lane=${intent.laneAction} hazard=${answers.hazard.score.toFixed(2)} ped=${answers.pedestrian_yield.noul.toFixed(2)} notes=${intent.notes.join("|")} cur=${JSON.stringify(p.state.lanes.current)} pedInPath=${JSON.stringify(p.state.pedestrian_in_path)}`);
    // emulate latency: the decision applies now, next one after `interval` (or the real round trip)
    decisions++; nextDecision = world.time + (useJev ? Math.max(0.2, ms / 1000) : interval);
  }
  if (world.ego.reflexActive) reflexTicks++;
  if (Math.round(world.time * 60) % 20 === 0) trace.push(`${world.time.toFixed(1)}s x=${world.ego.x.toFixed(2)} v=${(world.ego.speed*3.6).toFixed(0)} lane=${world.ego.lane}->${world.ego.targetLane} chg=${world.ego.laneChanging} intent=${JSON.stringify(world.ego.lastIntent)} reflex=${world.ego.reflexActive} rev=${world.ego.reversing} front=${p.state.ego.front_clearance_m} swept=${p.reflex.sweptClearance.toFixed(1)} cur=${JSON.stringify(p.state.lanes.current)} ped=${JSON.stringify(p.state.pedestrian_in_path)}`);
  if (p.state.time_to_collision_s !== null) minTtc = Math.min(minTtc, p.state.time_to_collision_s);
  world.ego.update(dt, p.reflex, world.time);
  world.update(dt);
  speeds.push(world.ego.speed);
}
if (process.env.TRACE) for (const t of (useJev ? trace.filter((t) => t.includes(`speed=${process.env.TRACE_ACTION || "stop"}`)).slice(0, Number(process.env.TRACE_N || 14)) : trace.slice(-6))) console.log(t);
const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
console.log(JSON.stringify({
  seed, simSeconds: Math.round(world.time), crashed: world.crashed, distance_m: Math.round(world.ego.y),
  avg_kmh: Math.round(avg * 3.6), decisions, laneChanges, reflexTicks, minTtc, objects: world.objects.length,
  speedActions: counts, brain: useJev ? `jev avg ${Math.round(jevMs / Math.max(1, decisions))}ms, ${jevErrors} errors` : "local",
}));
for (const e of world.events.slice(-8)) console.log(`  ${e.t.toFixed(1)}s ${e.msg}`);
