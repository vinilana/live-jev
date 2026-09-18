import { CONFIG, SIZES, ROAD_HALF_W, laneCenter, laneOf, clamp } from "./config.js";
import { makeRng } from "./rng.js";
import { EgoCar } from "./car.js";
import { overlaps, corners, extentX, collides } from "./geometry.js";
export { overlaps, corners, extentX, collides };

let nextId = 1;
const CAR_COLORS = ["#e04b4b", "#f2b134", "#5cc26a", "#b06be0", "#f08a3c", "#e8e8e8", "#4fb3d9"];

export function makeObject(type, x, y, extra = {}) {
  const size = SIZES[type] || SIZES.car;
  return { id: nextId++, type, x, y, w: size.w, h: size.h, speed: 0, cruise: 0, color: "#ccc", ...extra };
}

export class World {
  constructor(seed = Date.now() & 0xffffffff) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.ego = new EgoCar();
    this.objects = [];
    this.time = 0;
    this.crashed = null;         // {type, id} of the object hit
    this.autoTraffic = true;
    this.density = 1.0;          // spawn rate multiplier
    this.nextSpawnAt = 2.0;
    this.events = [];            // log lines for the UI
    // A friendly opening scene: a slow car ahead and a cone further up.
    this.add("car", laneCenter(1), 38, { speed: 6, cruise: 6 });
    this.add("cone", laneCenter(2) + 0.3, 60);
  }

  log(msg) { this.events.push({ t: this.time, msg }); if (this.events.length > 200) this.events.shift(); }

  add(type, x, y, extra = {}) {
    const o = makeObject(type, x, y, extra);
    if (type === "car" || type === "truck") {
      o.color = extra.color || this.rng.pick(CAR_COLORS);
      o.lane = laneOf(x); o.x = laneCenter(o.lane);
      if (o.cruise === 0 && !("cruise" in extra)) o.cruise = this.rng.range(5, 10);
      if (!("speed" in extra)) o.speed = o.cruise;
    }
    if (type === "parked_car") { o.color = "#8d95a3"; }
    if (type === "pedestrian") {
      o.dir = extra.dir ?? (x < 0 ? 1 : -1);           // +1 walks rightwards
      o.phase = extra.phase ?? "waiting";
      o.waitUntil = this.time + (extra.wait ?? this.rng.range(0.3, 1.8));
      o.walkSpeed = extra.walkSpeed ?? this.rng.range(1.1, 1.6);
      o.color = this.rng.pick(["#ffd166", "#06d6a0", "#ef476f", "#118ab2"]);
    }
    this.objects.push(o);
    return o;
  }

  /** Place an object from a UI click; snaps vehicles to lanes and pedestrians to the sidewalk edge. */
  placeAt(type, x, y) {
    if (type === "remove") {
      const hit = this.objects.find((o) => Math.abs(o.x - x) < Math.max(o.w, 1.2) && Math.abs(o.y - y) < Math.max(o.h, 1.2));
      if (hit) { this.objects = this.objects.filter((o) => o !== hit); this.log(`removed ${hit.type} #${hit.id}`); }
      return hit || null;
    }
    let o;
    if (type === "pedestrian") {
      const side = x < 0 ? -1 : 1;
      const onRoad = Math.abs(x) < ROAD_HALF_W;
      o = this.add("pedestrian", onRoad ? x : side * (ROAD_HALF_W + 1.0), y, {
        dir: onRoad ? (this.rng.chance(0.5) ? 1 : -1) : -side, phase: onRoad ? "crossing" : "waiting", wait: 0.4,
      });
    } else if (type === "car" || type === "truck") {
      const lane = laneOf(clamp(x, -ROAD_HALF_W, ROAD_HALF_W));
      o = this.add(type, laneCenter(lane), y, { cruise: this.rng.range(4, 9) });
    } else {
      o = this.add(type, clamp(x, -ROAD_HALF_W + 0.3, ROAD_HALF_W - 0.3), y);
    }
    this.log(`placed ${o.type} #${o.id} ${o.y > this.ego.y ? Math.round(o.y - this.ego.y) + "m ahead" : Math.round(this.ego.y - o.y) + "m behind"}`);
    return o;
  }

  /** Random runtime spawn beyond the visible area. Returns false if the spot was busy. */
  spawnRandom() {
    const r = this.rng();
    const ego = this.ego;
    const yAhead = ego.y + this.rng.range(CONFIG.SPAWN_AHEAD_MIN, CONFIG.SPAWN_AHEAD_MAX);
    const lane = this.rng.int(0, CONFIG.LANES - 1);
    const free = (x, y, w, h) => !this.objects.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 1 && Math.abs(o.y - y) < (o.h + h) / 2 + 9);
    const isStatic = (o) => o.type === "cone" || o.type === "barrier" || o.type === "parked_car";
    // Never let static obstacles close every lane within the same 30 m stretch.
    const staticOk = (lane, y) => {
      const others = [];
      for (let i = 0; i < CONFIG.LANES; i++) if (i !== lane) others.push(i);
      return others.some((i) => !this.objects.some((o) => isStatic(o) && laneOf(o.x) === i && Math.abs(o.y - y) < 30));
    };
    if (r < 0.32) {           // slow car ahead
      if (!free(laneCenter(lane), yAhead, 2, 4.3)) return false;
      this.add("car", laneCenter(lane), yAhead, { cruise: this.rng.range(3.5, 9) });
    } else if (r < 0.44) {    // faster car coming from behind
      const yBehind = ego.y - CONFIG.SPAWN_BEHIND;
      if (!free(laneCenter(lane), yBehind, 2, 4.3)) return false;
      this.add("car", laneCenter(lane), yBehind, { cruise: this.rng.range(11, 14) });
    } else if (r < 0.52) {    // truck
      if (!free(laneCenter(lane), yAhead, 2.4, 7.5)) return false;
      this.add("truck", laneCenter(lane), yAhead, { cruise: this.rng.range(3, 6), color: "#6c7a89" });
    } else if (r < 0.72) {    // pedestrian on a sidewalk, will cross
      const side = this.rng.chance(0.5) ? -1 : 1;
      const y = ego.y + this.rng.range(35, 60);
      this.add("pedestrian", side * (ROAD_HALF_W + 1.2), y, { dir: -side, wait: this.rng.range(0.5, 3) });
    } else if (r < 0.82) {
      if (!free(laneCenter(lane), yAhead, 1, 1) || !staticOk(lane, yAhead)) return false;
      this.add("cone", laneCenter(lane) + this.rng.range(-0.8, 0.8), yAhead);
    } else if (r < 0.91) {
      if (!free(laneCenter(lane), yAhead, 3.1, 0.8) || !staticOk(lane, yAhead)) return false;
      this.add("barrier", laneCenter(lane), yAhead);
    } else {
      if (!free(laneCenter(lane), yAhead, 2, 4.3) || !staticOk(lane, yAhead)) return false;
      this.add("parked_car", laneCenter(lane) + (lane === 0 ? -0.5 : lane === 2 ? 0.5 : 0), yAhead);
    }
    return true;
  }

  /** Nearest thing ahead of `v` overlapping its lane footprint (vehicles, obstacles, pedestrians, ego). */
  leadFor(v) {
    let best = null, bestGap = Infinity;
    const [vMin, vMax] = extentX(v);
    const consider = (o) => {
      if (o === v) return;
      const [oMin, oMax] = extentX(o);
      if (oMin > vMax + 0.35 || oMax < vMin - 0.35) return;
      const gap = (o.y - o.h / 2) - (v.y + v.h / 2);
      if (gap < -1 || gap > 60) return;
      if (gap < bestGap) { bestGap = gap; best = o; }
    };
    for (const o of this.objects) consider(o);
    consider(this.ego);
    return best ? { obj: best, gap: bestGap } : null;
  }

  update(dt) {
    if (this.crashed) return;
    this.time += dt;
    const ego = this.ego;

    // --- NPC vehicles: keep lane, keep a safe gap, otherwise cruise.
    for (const o of this.objects) {
      if (o.type !== "car" && o.type !== "truck") continue;
      const lead = this.leadFor(o);
      let target = o.cruise;
      if (lead) {
        const leadSpeed = lead.obj.type === "ego" ? ego.speed : (lead.obj.speed || 0);
        const desiredGap = 3 + o.speed * 1.3;
        if (lead.gap < desiredGap) target = Math.min(target, Math.max(0, leadSpeed - (desiredGap - lead.gap) * 0.8));
        if (lead.gap < 1.5) target = 0;
      }
      const a = target > o.speed ? 1.8 : -7;
      o.speed = clamp(o.speed + a * dt, 0, Math.max(o.cruise, 15));
      if (target < o.speed && o.speed - target < Math.abs(a) * dt) o.speed = target;
      o.y += o.speed * dt;

      // Stuck behind something static for a while? Try a free adjacent lane.
      const leadSpeed = lead ? (lead.obj.type === "ego" ? ego.speed : lead.obj.speed || 0) : 99;
      const stuck = lead && lead.gap < 6 && o.speed < 0.6 && leadSpeed < 0.3;
      o.stuckFor = stuck ? (o.stuckFor || 0) + dt : 0;
      if (o.stuckFor > 3 && o.laneTarget === undefined) {
        for (const cand of [o.lane - 1, o.lane + 1]) {
          if (cand < 0 || cand >= CONFIG.LANES) continue;
          const cx = laneCenter(cand);
          // Conflict = in the target lane and either within 10 m behind or leaving < 1.5 m of gap ahead.
          const busy = [...this.objects, ego].some((v) => {
            if (v === o || Math.abs(v.x - cx) >= (v.w + o.w) / 2 + 0.3) return false;
            const gapAhead = (v.y - v.h / 2) - (o.y + o.h / 2);
            const gapBehind = (o.y - o.h / 2) - (v.y + v.h / 2);
            if (gapAhead >= 0) return gapAhead < 1.5;                          // ahead: needs 1.5 m of room
            if (gapBehind >= 0) return (v.speed || 0) > 0.3 ? gapBehind < 10 : gapBehind < 0.5; // behind: moving cars within 10 m, statics only if touching
            return true;                                                        // overlapping our length: alongside
          });
          if (!busy) { o.laneTarget = cand; o.stuckFor = 0; break; }
        }
      }
      if (o.laneTarget !== undefined && o.laneTarget !== o.lane) {
        // Blind-spot check every tick: anything beside us or closing from behind in the target lane -> abort.
        const cx = laneCenter(o.laneTarget);
        const danger = [...this.objects, ego].some((v) => v !== o && Math.abs((extentX(v)[0] + extentX(v)[1]) / 2 - cx) < (extentX(v)[1] - extentX(v)[0] + o.w) / 2 + 0.3 &&
          ((Math.abs(v.y - o.y) < (v.h + o.h) / 2 + 2) || (v.y < o.y && o.y - v.y < 6 + Math.max(0, (v.speed || 0) - o.speed) * 2.5)));
        if (danger) o.laneTarget = o.lane;
      }
      if (o.laneTarget !== undefined) {
        const cx = laneCenter(o.laneTarget);
        const step = Math.sign(cx - o.x) * 1.2 * dt;
        o.x = Math.abs(cx - o.x) <= Math.abs(step) ? cx : o.x + step;
        if (o.speed < 1.5) o.speed = Math.min(o.speed + 1.5 * dt, 1.5);
        if (o.x === cx) { o.lane = o.laneTarget; o.laneTarget = undefined; }
      }
    }

    // --- Pedestrians: wait on the sidewalk, then cross the whole road.
    for (const o of this.objects) {
      if (o.type !== "pedestrian") continue;
      if (o.phase === "waiting" && this.time >= o.waitUntil) {
        // Look before stepping out: any vehicle (incl. ego) arriving within ~2.5 s keeps them on the curb.
        const approaching = [...this.objects, ego].some((v) => (v.type === "car" || v.type === "truck" || v.type === "ego") &&
          v.y < o.y + 1 && o.y - v.y < (v.speed || 0) * 2.5 + 7);
        if (approaching) o.waitUntil = this.time + 0.5; else o.phase = "crossing";
      }
      if (o.phase === "crossing") {
        // Don't walk straight into a vehicle that is right in front of the pedestrian.
        const aheadX = o.x + o.dir * 1.3;
        const blocked = [...this.objects, ego].some((v) => v !== o && (v.type === "car" || v.type === "truck" || v.type === "parked_car" || v.type === "ego") &&
          Math.abs(v.y - o.y) < v.h / 2 + o.h / 2 + 0.3 && Math.abs(v.x - aheadX) < v.w / 2 + o.w / 2);
        o.vx = blocked ? 0 : o.dir * o.walkSpeed;
        o.x += o.vx * dt;
        if (Math.abs(o.x) > ROAD_HALF_W + 1.3 && Math.sign(o.x) === o.dir) { o.phase = "done"; o.vx = 0; }
      } else o.vx = 0;
    }

    // --- Lifecycle: drop things far behind/ahead or finished crossing.
    this.objects = this.objects.filter((o) =>
      o.y > ego.y - CONFIG.DESPAWN_BEHIND && o.y < ego.y + CONFIG.DESPAWN_AHEAD && o.phase !== "done");

    // --- Runtime spawning of dynamic objects.
    if (this.autoTraffic && this.time >= this.nextSpawnAt) {
      this.spawnRandom();
      this.nextSpawnAt = this.time + this.rng.range(2.2, 4.5) / Math.max(0.2, this.density);
    }

    // --- Collision check for the ego car.
    for (const o of this.objects) {
      if (collides(ego, o)) {
        this.crashed = { type: o.type, id: o.id, time: this.time };
        this.log(`CRASH into ${o.type} #${o.id}`);
        break;
      }
    }
    if (corners(ego).some(([cx]) => Math.abs(cx) > ROAD_HALF_W + 0.5)) {
      this.crashed = { type: "curb", id: 0, time: this.time };
      this.log("CRASH: left the road");
    }
  }
}
