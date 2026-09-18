import { CONFIG, ROAD_HALF_W, laneCenter } from "./config.js";
import { makeRng } from "./rng.js";
import { PRESETS } from "./presets.js";

const CAR_COLORS = ["#e04b4b", "#f2b134", "#5cc26a", "#b06be0", "#f08a3c", "#e8e8e8", "#4fb3d9"];
const PED_COLORS = ["#ffd166", "#06d6a0", "#ef476f", "#118ab2"];
const STATIC = new Set(["cone", "barrier", "parked_car"]);

/**
 * A deterministic course: an endless list of spawn events derived only from the seed.
 * Every event has an absolute road position, so several worlds sharing one Course
 * (the Jev vs LLM comparison) meet exactly the same objects in the same places,
 * each car at its own pace. Events fire when the ego passes `triggerY`.
 */
const SPAWN_AHEAD = 75; // preset objects appear this far ahead of the car

export class Course {
  constructor(seed, density = 1, presetId = "traffic") {
    this.seed = seed;
    this.rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
    this.density = density;
    this.presetId = PRESETS[presetId] ? presetId : "traffic";
    this.preset = PRESETS[this.presetId];
    this.staticOnly = Boolean(this.preset.staticOnly || this.preset.pattern);
    this.events = [];
    this.lastTriggerY = 20;
    // A small opening scene for the traffic course; presets start on a clean road.
    this.opening = this.presetId === "traffic"
      ? [{ type: "car", x: laneCenter(1), offset: 38, cruise: 6, color: "#f2b134" }, { type: "cone", x: laneCenter(2) + 0.3, offset: 60 }]
      : [];
  }

  get name() { return this.preset.name; }

  get(i) {
    while (this.events.length <= i) this.events.push(this.preset.pattern ? this.fromPattern(this.events.length) : this.generate());
    return this.events[i];
  }

  /** Event i of a repeating pattern, at absolute y = pattern y + k * period. */
  fromPattern(i) {
    const { period, events } = this.preset.pattern;
    if (events.length === 0) return { triggerY: (i + 1) * period, offset: SPAWN_AHEAD, type: "none", x: 0, lane: 1 };
    const k = Math.floor(i / events.length), e = events[i % events.length];
    const y = e.y + k * period;
    return { type: e.type, lane: e.lane, x: e.x, triggerY: y - SPAWN_AHEAD, offset: SPAWN_AHEAD };
  }

  /** Random event relative to "now" (used by the "Random object" button); same for every world. */
  randomEvent() { return this.generate(true); }

  generate(relative = false) {
    const rng = this.rng;
    const gap = rng.range(16, 34) / Math.max(0.2, this.density);
    const triggerY = relative ? 0 : this.lastTriggerY + gap;
    if (!relative) this.lastTriggerY = triggerY;
    // static-only courses draw from the obstacle part of the distribution only
    const r = this.staticOnly ? 0.72 + rng() * 0.28 : rng();
    const lane = rng.int(0, CONFIG.LANES - 1);
    const ahead = rng.range(CONFIG.SPAWN_AHEAD_MIN, CONFIG.SPAWN_AHEAD_MAX);
    const ev = { triggerY, lane, offset: ahead, x: laneCenter(lane) };
    if (r < 0.32) Object.assign(ev, { type: "car", cruise: rng.range(3.5, 9), color: rng.pick(CAR_COLORS) });
    else if (r < 0.44) Object.assign(ev, { type: "car", offset: -CONFIG.SPAWN_BEHIND, cruise: rng.range(11, 14), color: rng.pick(CAR_COLORS) });
    else if (r < 0.52) Object.assign(ev, { type: "truck", cruise: rng.range(3, 6), color: "#6c7a89" });
    else if (r < 0.72) {
      const side = rng.chance(0.5) ? -1 : 1;
      Object.assign(ev, { type: "pedestrian", offset: rng.range(35, 60), x: side * (ROAD_HALF_W + 1.2), dir: -side, wait: rng.range(0.5, 3), walkSpeed: rng.range(1.1, 1.6), color: rng.pick(PED_COLORS) });
    }
    else if (r < 0.82) Object.assign(ev, { type: "cone", x: laneCenter(lane) + rng.range(-0.8, 0.8) });
    else if (r < 0.91) Object.assign(ev, { type: "barrier" });
    else Object.assign(ev, { type: "parked_car", x: laneCenter(lane) + (lane === 0 ? -0.5 : lane === CONFIG.LANES - 1 ? 0.5 : 0) });
    // Never let static obstacles close every lane within the same 30 m stretch.
    if (!relative && STATIC.has(ev.type)) {
      const y = ev.triggerY + ev.offset;
      const blockedLanes = new Set([ev.lane]);
      for (const e of this.events) if (STATIC.has(e.type) && Math.abs(e.triggerY + e.offset - y) < 30) blockedLanes.add(e.lane);
      if (blockedLanes.size >= CONFIG.LANES) { ev.type = "car"; ev.x = laneCenter(lane); ev.cruise = rng.range(3.5, 9); ev.color = rng.pick(CAR_COLORS); }
    }
    return ev;
  }
}
