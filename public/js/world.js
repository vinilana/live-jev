import { CONFIG, SIZES, ROAD_HALF_W, laneCenter, laneOf, clamp } from "./config.js";
import { makeRng } from "./rng.js";
import { EgoCar } from "./car.js";
import { Course } from "./course.js";
import { overlaps, corners, extentX, collides } from "./geometry.js";
export { overlaps, corners, extentX, collides };

let nextId = 1;
const CAR_COLORS = ["#e04b4b", "#f2b134", "#5cc26a", "#b06be0", "#f08a3c", "#e8e8e8", "#4fb3d9"];

export function makeObject(type, x, y, extra = {}) {
  const size = SIZES[type] || SIZES.car;
  return { id: nextId++, type, x, y, w: size.w, h: size.h, speed: 0, cruise: 0, color: "#ccc", ...extra };
}

export class World {
  constructor(seed = Date.now() >>> 0, course = null) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.ego = new EgoCar();
    this.objects = [];
    this.time = 0;
    this.crashed = null;         // {type, id} of the object hit
    this.autoTraffic = true;
    this.course = course || new Course(seed);   // shared between worlds in comparison mode
    this.courseIndex = 0;
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
      o.color = extra.color || this.rng.pick(["#ffd166", "#06d6a0", "#ef476f", "#118ab2"]);
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

  /** Spawn a course event at its absolute position (baseY + offset). Returns the object or null. */
  spawnEvent(ev, baseY) {
    const size = SIZES[ev.type] || SIZES.car;
    let y = baseY + ev.offset;
    const isStatic = (t) => t === "cone" || t === "barrier" || t === "parked_car";
    const overlapsWith = (o, yy, margin) => Math.abs(o.x - ev.x) < (o.w + size.w) / 2 + 1 && Math.abs(o.y - yy) < (o.h + size.h) / 2 + margin;
    if (isStatic(ev.type)) {
      // Static obstacles land exactly where the course says (identical on every track); they only
      // step aside from another static object or from the ego itself. NPC cars will brake for them.
      const blocked = (yy) => this.objects.some((o) => isStatic(o.type) && overlapsWith(o, yy, 6)) || overlapsWith(this.ego, yy, 6);
      let tries = 0;
      while (blocked(y) && tries < 8) { y += 3; tries++; }
      if (blocked(y)) return null;
    } else if (ev.type !== "pedestrian") {
      // Vehicles must not overlap anything: nudge forward until there is room.
      const busy = (yy) => this.objects.some((o) => overlapsWith(o, yy, 9)) || overlapsWith(this.ego, yy, 9);
      let tries = 0;
      while (busy(y) && tries < 10) { y += 4; tries++; }
      if (busy(y)) return null;
    }
    if (ev.type === "car" || ev.type === "truck") return this.add(ev.type, ev.x, y, { cruise: ev.cruise, speed: ev.cruise, color: ev.color });
    if (ev.type === "pedestrian") return this.add("pedestrian", ev.x, y, { dir: ev.dir, wait: ev.wait, walkSpeed: ev.walkSpeed, color: ev.color });
    return this.add(ev.type, ev.x, y);
  }

  /** Legacy helper: one random object relative to the ego (the UI's "Random object" button shares the event across worlds). */
  spawnRandom() { return Boolean(this.spawnEvent(this.course.randomEvent(), this.ego.y)); }

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

    // --- Course events fire as the ego passes their marks (skipped, not queued, while auto traffic is off).
    for (;;) {
      const ev = this.course.get(this.courseIndex);
      if (ev.triggerY > ego.y) break;
      this.courseIndex++;
      if (this.autoTraffic) this.spawnEvent(ev, ev.triggerY);
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
