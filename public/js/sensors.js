import { CONFIG, ROAD_HALF_W, laneCenter, laneOf, kmh } from "./config.js";
import { extentX, collides } from "./world.js";
import { steerFor, stepKinematics } from "./car.js";

const r1 = (v) => Math.round(v * 10) / 10;

/** Which lanes an object's footprint touches (pedestrians on the sidewalk return []). */
function lanesTouched(o) {
  const lanes = [];
  const [minX, maxX] = extentX(o);
  for (let i = 0; i < CONFIG.LANES; i++) {
    const c = laneCenter(i);
    if (maxX > c - CONFIG.LANE_W / 2 + 0.15 && minX < c + CONFIG.LANE_W / 2 - 0.15) lanes.push(i);
  }
  return lanes;
}

function describeObject(o, ego) {
  const gap = (o.y - o.h / 2) - (ego.y + ego.h / 2);
  const base = {
    type: o.type,
    distance_m: r1(gap),
    lateral_offset_m: r1(o.x - ego.x),  // + = to the right of ego
  };
  if (o.type === "car" || o.type === "truck") {
    base.moving = true;
    base.speed_kmh = kmh(o.speed);
    base.closing_speed_kmh = kmh(ego.speed - o.speed); // + = ego is catching up
    base.lane = o.lane ?? laneOf(o.x);
  } else if (o.type === "pedestrian") {
    const onRoad = Math.abs(o.x) < ROAD_HALF_W + 0.35;
    base.on_road = onRoad;
    base.lanes = onRoad ? lanesTouched(o) : [];
    base.walking = o.phase === "crossing" ? (o.dir > 0 ? "right" : "left") : "standing";
    base.will_enter_road = o.phase !== "done";
    base.seconds_to_ego_lane = null;
    if (o.phase === "crossing") {
      const egoLaneX = laneCenter(ego.targetLane);
      const dx = (egoLaneX - o.x) * o.dir;
      const inEgoLane = Math.abs(o.x - egoLaneX) < CONFIG.LANE_W / 2 + o.w / 2;
      // null = walking away, will never reach ego's lane
      base.seconds_to_ego_lane = inEgoLane ? 0 : dx > 0 ? r1(Math.max(0, dx - 1.2) / o.walkSpeed) : null;
    }
  } else {
    base.moving = false;
    base.lanes = lanesTouched(o);
  }
  return base;
}

/**
 * Build the perception summary that becomes Jev's `state`, plus the local
 * reflex signal and ray-cast visualisation data.
 */
export function perceive(world) {
  const ego = world.ego;
  const egoLane = ego.lane;
  const ahead = [];
  const lanes = [];
  for (let i = 0; i < CONFIG.LANES; i++) lanes.push({ lane: i, clear_ahead_m: CONFIG.SENSOR_RANGE, blocked_by: null, alongside: null, vehicle_behind: null });

  for (const o of world.objects) {
    const gap = (o.y - o.h / 2) - (ego.y + ego.h / 2);
    const gapBehind = (ego.y - ego.h / 2) - (o.y + o.h / 2);
    const touched = o.type === "pedestrian"
      ? (Math.abs(o.x) < ROAD_HALF_W + 0.35 ? lanesTouched(o) : [])
      : lanesTouched(o);

    if (gap >= 0 && gap <= CONFIG.SENSOR_RANGE) {
      if (o.type !== "pedestrian" || Math.abs(o.x) < ROAD_HALF_W + 4) ahead.push(describeObject(o, ego));
      for (const li of touched) {
        const L = lanes[li];
        if (gap < L.clear_ahead_m) {
          L.clear_ahead_m = r1(gap);
          L.blocked_by = { type: o.type, speed_kmh: kmh(o.speed || 0), moving: o.type === "car" || o.type === "truck" };
        }
      }
    } else if (gap < 0 && gapBehind < 1.0) { // overlapping ego's length: alongside
      if (o.type === "pedestrian" && Math.abs(o.x) < ROAD_HALF_W + 4) ahead.push(describeObject(o, ego));
      for (const li of touched) lanes[li].alongside = { type: o.type, lateral_offset_m: r1(o.x - ego.x) };
    } else if (gapBehind >= 1.0 && gapBehind <= CONFIG.SENSOR_BEHIND && (o.type === "car" || o.type === "truck")) {
      for (const li of touched) {
        const L = lanes[li];
        const cand = { type: o.type, distance_m: r1(Math.max(0, gapBehind)), speed_kmh: kmh(o.speed), closing_speed_kmh: kmh(o.speed - ego.speed) };
        if (!L.vehicle_behind || cand.distance_m < L.vehicle_behind.distance_m) L.vehicle_behind = cand;
      }
    }
  }
  ahead.sort((a, b) => a.distance_m - b.distance_m);

  // The "current" lane for decisions is the target lane. While a lane change is in
  // progress, objects in the lane we are leaving only count if the swept-path
  // prediction (which follows the real steering law) actually hits them.
  const occupied = new Set(lanesTouched(ego)); occupied.add(ego.targetLane); occupied.add(egoLane);
  const path = { ...lanes[ego.targetLane] };
  for (const li of occupied) if (lanes[li].alongside && !path.alongside) path.alongside = lanes[li].alongside;
  const vNow = Math.max(0, ego.speed);
  // Predict with the speed we are likely to have shortly (the brain may be accelerating us).
  const vAssumed = Math.max(2.0, vNow, Math.min(ego.targetSpeed, vNow + 4));
  // The steering law turns sharper at low speed (rear swings out more), so predict at both
  // the current/creep speed and the likely upcoming speed and keep the worst case.
  const sweptLow = sweptClearance(world, Math.max(2.0, vNow), 3.0, 0.08);
  const sweptHigh = vAssumed > Math.max(2.0, vNow) + 0.1 ? sweptClearance(world, vAssumed, 3.0, 0.08) : sweptLow;
  const sweptForPath = sweptLow.dist <= sweptHigh.dist ? sweptLow : sweptHigh;
  const corridor = corridorClearance(world);
  if (sweptForPath.obj && sweptForPath.dist < path.clear_ahead_m) {
    const o = sweptForPath.obj;
    path.clear_ahead_m = r1(sweptForPath.dist);
    path.blocked_by = { type: o.type, speed_kmh: kmh(o.speed || 0), moving: o.type === "car" || o.type === "truck" };
  }
  // Something very close straight along the heading counts too, whatever lane it is in.
  if (corridor.obj && corridor.dist < 8 && corridor.dist < path.clear_ahead_m) {
    const o = corridor.obj;
    path.clear_ahead_m = r1(corridor.dist);
    path.blocked_by = { type: o.type, speed_kmh: kmh(o.speed || 0), moving: o.type === "car" || o.type === "truck" };
  }
  // Time-to-collision against the lead in the path.
  let ttc = null;
  if (path.blocked_by && path.clear_ahead_m < CONFIG.SENSOR_RANGE) {
    const closing = ego.speed - (path.blocked_by.speed_kmh / 3.6);
    if (closing > 0.2) ttc = r1(path.clear_ahead_m / closing);
  }
  // Pedestrian about to be in the path: distance-based.
  const peds = ahead.filter((a) => a.type === "pedestrian" && a.distance_m >= -0.3);
  let pedInPath = null;
  for (const p of peds) {
    const inLane = p.on_road && p.lanes.some((l) => occupied.has(l));
    const soon = p.will_enter_road && p.seconds_to_ego_lane !== null && p.seconds_to_ego_lane < 3.5;
    if ((inLane || soon) && p.distance_m < 30 && (!pedInPath || p.distance_m < pedInPath.distance_m)) pedInPath = p;
  }

  const rear = rearClearance(world);
  const stoppingDist = (ego.speed * ego.speed) / (2 * CONFIG.EGO_BRAKE) + ego.speed * 0.25;
  const state = {
    ego: {
      speed_kmh: kmh(ego.speed),
      max_speed_kmh: kmh(ego.maxSpeed),
      lane: egoLane,
      target_lane: ego.targetLane,
      lane_change_in_progress: ego.laneChanging,
      can_change_left: ego.targetLane > 0 && !ego.laneChanging,
      can_change_right: ego.targetLane < CONFIG.LANES - 1 && !ego.laneChanging,
      seconds_since_lane_change: r1(Math.min(99, world.time - ego.laneChangeStartedAt)),
      stopping_distance_m: r1(stoppingDist),
      front_clearance_m: r1(Math.min(corridor.dist, 99)),
      reversing: ego.reversing,
    },
    road: { lanes_total: CONFIG.LANES, one_way: true, lane_numbering: "0 = leftmost, 2 = rightmost", sidewalks: "both sides" },
    lanes: {
      left: ego.targetLane > 0 ? lanes[ego.targetLane - 1] : "does_not_exist",
      current: path,
      right: ego.targetLane < CONFIG.LANES - 1 ? lanes[ego.targetLane + 1] : "does_not_exist",
      far_left: ego.targetLane > 1 ? lanes[ego.targetLane - 2] : "does_not_exist",
      far_right: ego.targetLane < CONFIG.LANES - 2 ? lanes[ego.targetLane + 2] : "does_not_exist",
    },
    time_to_collision_s: ttc,
    pedestrian_in_path: pedInPath,
    objects_ahead: ahead.slice(0, 7),
  };

  // Local reflex: only for truly imminent impacts (Jev makes every other call).
  // Emergency stopping distance at the current speed, plus a small reaction margin.
  const v = vNow;
  const emergencyDist = (v * v) / (2 * CONFIG.EGO_EMERGENCY_BRAKE) + v * 0.2;
  const swept = sweptForPath;
  const imminent = swept.obj !== null && swept.dist < emergencyDist + 0.6 && v > 0.3;
  // Blind-spot monitor for a lane change in progress: is the target lane safe *right now*?
  let blindSpot = false, abortSafe = true;
  if (ego.laneChanging && ego.targetLane !== egoLane) {
    const T = lanes[ego.targetLane];
    const vb = T.vehicle_behind;
    const arrivingSoon = vb && vb.closing_speed_kmh > 0 && vb.distance_m < 12 && vb.distance_m / (vb.closing_speed_kmh / 3.6) < 2.0;
    blindSpot = Boolean(T.alongside) || Boolean(arrivingSoon);
    // Is steering back into our own lane safe for a few meters? (used by abort and by the give-up timer)
    abortSafe = sweptClearance(world, vAssumed, 2.2, 0.08, egoLane).dist > 6;
  }
  const reflex = {
    blindSpot: blindSpot && abortSafe,
    blindSpotHold: blindSpot && !abortSafe,   // can't go back either: freeze the lateral move until it clears
    returnSafe: abortSafe,
    holdForPedestrian: Boolean(pedInPath && pedInPath.distance_m < 12),
    brake: imminent
      || Boolean(pedInPath && pedInPath.on_road && pedInPath.lanes.some((l) => occupied.has(l)) && pedInPath.distance_m < Math.max(3, stoppingDist * 0.9)),
    frontClearance: corridor.dist,
    sweptClearance: swept.dist,
    sweptHit: swept.obj ? swept.obj.type : null,
    rearClearance: rear,
  };

  return { state, reflex, rays: castRays(world) };
}

/** Segment vs AABB (slab) intersection, returns t in [0,1] or null. */
function rayHit(ox, oy, dx, dy, o) {
  const minX = o.x - o.w / 2, maxX = o.x + o.w / 2, minY = o.y - o.h / 2, maxY = o.y + o.h / 2;
  let tmin = 0, tmax = 1;
  for (const [o0, d, mn, mx] of [[ox, dx, minX, maxX], [oy, dy, minY, maxY]]) {
    if (Math.abs(d) < 1e-9) { if (o0 < mn || o0 > mx) return null; continue; }
    let t1 = (mn - o0) / d, t2 = (mx - o0) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * Forward-simulate the ego's own steering law for a short horizon at `assumedSpeed`
 * (moving objects are extrapolated) and return the distance travelled before the first
 * collision, or Infinity. This is what catches "the rear swings into the barrier".
 */
export function sweptClearance(world, assumedSpeed, horizonS = 2.2, dt = 0.08, targetLane = world.ego.targetLane) {
  const ego = world.ego;
  const sim = { x: ego.x, y: ego.y, heading: ego.heading, speed: assumedSpeed, steer: ego.steer, w: ego.w, h: ego.h };
  const movers = world.objects.map((o) => ({ ...o, vx: o.vx || 0, vy: (o.type === "car" || o.type === "truck") ? o.speed : 0 }));
  let travelled = 0, hitObj = null;
  for (let t = 0; t < horizonS; t += dt) {
    sim.steer = steerFor(sim.x, sim.heading, sim.speed, targetLane);
    stepKinematics(sim, dt);
    travelled += Math.abs(sim.speed) * dt;
    for (const o of movers) {
      o.x += o.vx * dt; o.y += o.vy * dt;
      if (Math.abs(o.y - sim.y) > 12) continue;
      if (collides(sim, o)) { hitObj = o; break; }
    }
    if (hitObj) return { dist: travelled, obj: hitObj, t };
  }
  return { dist: Infinity, obj: null, t: null };
}

/** Min distance from the front bumper to any object along the heading, across the car's width. */
export function corridorClearance(world) {
  const ego = world.ego;
  const c = Math.cos(ego.heading), sn = Math.sin(ego.heading);
  let best = 1, obj = null;
  const range = 60;
  for (const off of [-ego.w / 2 + 0.05, -ego.w / 4, 0, ego.w / 4, ego.w / 2 - 0.05]) {
    // bumper point = center + forward*(h/2) + right*off
    const ox = ego.x + sn * (ego.h / 2) + c * off;
    const oy = ego.y + c * (ego.h / 2) - sn * off;
    const dx = sn * range, dy = c * range;
    for (const o of world.objects) {
      const t = rayHit(ox, oy, dx, dy, o);
      if (t !== null && t < best) { best = t; obj = o; }
    }
  }
  return { dist: best * range, obj };
}

/** Free distance behind the rear bumper (straight back, ignoring heading). */
export function rearClearance(world) {
  const ego = world.ego;
  let best = 99;
  for (const o of world.objects) {
    if (Math.abs(o.x - ego.x) > (o.w + ego.w) / 2 + 0.2) continue;
    const gap = (ego.y - ego.h / 2) - (o.y + o.h / 2);
    if (gap >= -0.5 && gap < best) best = Math.max(0, gap);
  }
  return best;
}

export function castRays(world) {
  const ego = world.ego;
  const rays = [];
  const spread = 0.55;
  for (let i = 0; i < CONFIG.RAY_COUNT; i++) {
    const a = ego.heading + (-spread / 2 + (spread * i) / (CONFIG.RAY_COUNT - 1)) * 2;
    const ox = ego.x, oy = ego.y + ego.h / 2;
    const dx = Math.sin(a) * CONFIG.RAY_RANGE, dy = Math.cos(a) * CONFIG.RAY_RANGE;
    let best = 1, hitType = null;
    for (const o of world.objects) {
      const t = rayHit(ox, oy, dx, dy, o);
      if (t !== null && t < best) { best = t; hitType = o.type; }
    }
    rays.push({ x0: ox, y0: oy, x1: ox + dx * best, y1: oy + dy * best, dist: best * CONFIG.RAY_RANGE, hit: hitType });
  }
  return rays;
}
