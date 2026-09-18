import { CONFIG } from "./config.js";

// ---- The questions we ask Jev on every decision tick (speculative fan-out:
// all of them go in one call and code decides which answers to act on).
export const QUESTIONS = {
  lane_action: {
    type: "choice",
    instructions:
      "You are the driving policy of `ego`, a car on a one-way road with 3 lanes (see `road`). " +
      "Decide the lane maneuver for the next second using `lanes` and `objects_ahead`. " +
      "Change lanes only if the target lane exists (`ego.can_change_left` / `ego.can_change_right`), " +
      "its `alongside` is null, its `clear_ahead_m` is clearly larger than the current lane's, and no `vehicle_behind` in " +
      "that lane has a positive `closing_speed_kmh` within ~15 m. Keep the lane when the current lane is clear, when " +
      "`lane_change_in_progress` is true, or when `seconds_since_lane_change` is below 3. Exception: if ego is stopped " +
      "behind something that is also stopped, a lane change into any lane with a few more meters of room is better than waiting " +
      "(also via an adjacent lane toward an open `far_left` / `far_right` lane). Plan double lane changes early: if the " +
      "current lane AND the adjacent lane are both blocked ahead but `far_left` / `far_right` is open, start moving toward " +
      "the open side now, one lane at a time, while there is still room to stop in the intermediate lane.",
    criteria: {
      keep_lane: "Stay in the current lane; it is clear enough, or no adjacent lane is safer.",
      change_left: "Move one lane to the left: the left lane exists, is clear ahead and no car is closing from behind, and the current lane is blocked or slower.",
      change_right: "Move one lane to the right: the right lane exists, is clear ahead and no car is closing from behind, and the current lane is blocked or slower.",
    },
  },
  speed_action: {
    type: "choice",
    instructions:
      "Decide how `ego` should adjust its speed in the next second. Only `lanes.current` matters for speed; objects in " +
      "other lanes or on the sidewalk are NOT a reason to slow down. Use `lanes.current.clear_ahead_m`, `ego.stopping_distance_m`, " +
      "`time_to_collision_s` (seconds until ego reaches the lead at current speeds; null = not closing) and `pedestrian_in_path`. " +
      "Stop for pedestrians on or about to enter the road ahead. Slow down only when `clear_ahead_m` is under about twice " +
      "`stopping_distance_m`, or `time_to_collision_s` is under ~4 s. A slower lead that is still far away (large `clear_ahead_m`, " +
      "`time_to_collision_s` above ~6 s) is not a reason to slow down yet. Speed up when the lane is clear and speed is below `ego.max_speed_kmh`.",
    criteria: {
      stop: "Brake to a full stop: a pedestrian is in or entering the path, or a stopped obstacle/vehicle is within `ego.stopping_distance_m` plus a 5 m margin (leave room to steer around it later).",
      slow_down: "Reduce speed: the lead in the current lane is within about twice the stopping distance, or `time_to_collision_s` is under ~4 s.",
      hold: "Keep the current speed: there is a lead in the current lane but the gap is comfortable (`time_to_collision_s` between ~4 and ~8 s, or matching its speed).",
      speed_up: "Accelerate: the current lane is clear well beyond twice the stopping distance (or `time_to_collision_s` is null or above ~8 s) and ego is below the speed limit.",
    },
  },
  hazard: {
    type: "score",
    instructions: "Rate the overall collision hazard for `ego` right now, given everything in the state.",
    criteria: [
      "No hazard: the road ahead is clear for a long distance.",
      "Low: obstacles or vehicles exist but they are far away or in other lanes.",
      "Moderate: something in the current lane is within about twice the stopping distance, or a pedestrian is close to the road.",
      "Severe: a collision is likely within a few seconds unless ego brakes or swerves now.",
    ],
  },
  pedestrian_yield: {
    type: "noul",
    instructions:
      "A pedestrian is on the road, or is walking toward the road and will reach ego's lane, within roughly `ego.stopping_distance_m` " +
      "plus a safety margin ahead of ego, so ego must stop and yield.",
    criteria: {
      true: "`pedestrian_in_path` is not null and is close, or an `objects_ahead` pedestrian is on the road near ego's lane within ~25 m.",
      false: "No pedestrian is in or about to enter ego's path within stopping distance; standing pedestrians on the sidewalk are fine.",
    },
  },
};

/** Ask the server for a decision from `kind` ("jev" or "llm"). Throws on any failure. */
export async function askBrain(kind, state, signal) {
  const t0 = performance.now();
  const res = await fetch(kind === "llm" ? "/api/llm-decide" : "/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, questions: QUESTIONS }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status; err.detail = body.detail;
    throw err;
  }
  return { ...body, roundTripMs: Math.round(performance.now() - t0) };
}
export const askJev = (state, signal) => askBrain("jev", state, signal);

/**
 * Rule-based stand-in with the same answer shape, used when the server has no
 * API key or Jev is unreachable. It is deliberately simple: the point of the
 * demo is Jev's judgment, not this.
 */
export function localDecide(state) {
  const { ego, lanes, pedestrian_in_path: ped, time_to_collision_s: ttc } = state;
  const cur = lanes.current;
  const stop = ego.stopping_distance_m;
  const laneOk = (L) => L && L !== "does_not_exist" && L.clear_ahead_m > Math.max(cur.clear_ahead_m + 8, 22) &&
    !L.alongside && !(L.vehicle_behind && L.vehicle_behind.closing_speed_kmh > 0 && L.vehicle_behind.distance_m < 15);

  let lane = "keep_lane";
  const blocked = cur.blocked_by && (cur.clear_ahead_m < Math.max(2.2 * stop, 18) || (cur.blocked_by.moving && cur.blocked_by.speed_kmh < ego.max_speed_kmh - 12 && cur.clear_ahead_m < 30));
  // Early planning for a double lane change: current + adjacent blocked by static things, far lane open.
  const staticAhead = (L) => L && L !== "does_not_exist" && L.blocked_by && !L.blocked_by.moving;
  const planFar = (L, F) => staticAhead(L) && F && F !== "does_not_exist" && !L.alongside &&
    F.clear_ahead_m > Math.max(L.clear_ahead_m, cur.clear_ahead_m) + 15 && L.clear_ahead_m > stop * 1.2 + 6 &&
    !(L.vehicle_behind && L.vehicle_behind.closing_speed_kmh > 0 && L.vehicle_behind.distance_m < 12);
  const planAhead = staticAhead(cur) && cur.clear_ahead_m < 3 * stop + 30;
  if (planAhead && !blocked && !ego.lane_change_in_progress && ego.seconds_since_lane_change > 2.5) {
    if (ego.can_change_left && planFar(lanes.left, lanes.far_left)) lane = "change_left";
    else if (ego.can_change_right && planFar(lanes.right, lanes.far_right)) lane = "change_right";
  }
  if (blocked && !ego.lane_change_in_progress && ego.seconds_since_lane_change > 2.5) {
    if (ego.can_change_left && laneOk(lanes.left)) lane = "change_left";
    else if (ego.can_change_right && laneOk(lanes.right)) lane = "change_right";
    else if (ego.speed_kmh < 2 && cur.blocked_by && cur.blocked_by.speed_kmh < 2) {
      // Stopped behind something stopped: any lane with a few more meters of room beats waiting forever.
      const stepOk = (L) => L && L !== "does_not_exist" && !L.alongside && L.clear_ahead_m > cur.clear_ahead_m + 4 &&
        !(L.vehicle_behind && L.vehicle_behind.closing_speed_kmh > 0 && L.vehicle_behind.distance_m < 12);
      // Two-step escape: the adjacent lane only needs room to stop if the lane beyond it is open.
      const via = (L, F) => L && L !== "does_not_exist" && F && F !== "does_not_exist" && !L.alongside && L.clear_ahead_m > 4.5 && F.clear_ahead_m > 20 &&
        !(L.vehicle_behind && L.vehicle_behind.closing_speed_kmh > 0 && L.vehicle_behind.distance_m < 12);
      if (ego.can_change_left && stepOk(lanes.left)) lane = "change_left";
      else if (ego.can_change_right && stepOk(lanes.right)) lane = "change_right";
      else if (ego.can_change_left && via(lanes.left, lanes.far_left)) lane = "change_left";
      else if (ego.can_change_right && via(lanes.right, lanes.far_right)) lane = "change_right";
    }
  }
  const pedYield = ped ? (ped.on_road ? 0.95 : Math.max(0.3, 0.9 - (ped.seconds_to_ego_lane ?? 3) * 0.15)) : 0.03;

  let speed = "speed_up";
  if (pedYield >= CONFIG.PED_YIELD_THRESHOLD && ped.distance_m < Math.max(stop * 1.5, 8)) speed = "stop";
  else if (cur.blocked_by) {
    const gap = cur.clear_ahead_m;
    const leadSlower = cur.blocked_by.speed_kmh < ego.speed_kmh - 3;
    const leadStopped = !cur.blocked_by.moving || cur.blocked_by.speed_kmh < 2;
    if (leadStopped && gap < stop * 1.3 + 5.5) speed = "stop";
    else if (gap < stop * 2 + 4 && leadSlower) speed = "slow_down";
    else if (gap < stop * 2 + 4 && !leadSlower) speed = "hold";
    else if (gap < stop * 3 + 6 && (!cur.blocked_by.moving || leadSlower)) speed = "hold";
  }
  let hazard = 0;
  if (cur.blocked_by || ped) hazard = 1;
  if (cur.blocked_by && cur.clear_ahead_m < stop * 2 + 4) hazard = 2;
  if ((ttc !== null && ttc < 2.5) || (ped && ped.on_road && ped.distance_m < stop * 1.5)) hazard = 3;
  const dist = (k, n) => { const p = {}; for (const key of Object.keys(k)) p[key] = key === n ? 0.85 : 0.15 / (Object.keys(k).length - 1); return p; };
  return {
    lane_action: { type: "choice", choice: lane, confidence: 0.8, probabilities: dist(QUESTIONS.lane_action.criteria, lane) },
    speed_action: { type: "choice", choice: speed, confidence: 0.8, probabilities: dist(QUESTIONS.speed_action.criteria, speed) },
    hazard: { type: "score", score: hazard, confidence: 0.75, probabilities: { 0: hazard === 0 ? 0.85 : 0.05, 1: hazard === 1 ? 0.85 : 0.05, 2: hazard === 2 ? 0.85 : 0.05, 3: hazard === 3 ? 0.85 : 0.05 } },
    pedestrian_yield: { type: "noul", noul: pedYield },
  };
}

/**
 * Turn raw answers into an intent, applying the confidence-gated-routing pattern:
 * a low-confidence lane change is ignored, a strong pedestrian noul overrides speed,
 * and a severe hazard score forces at least slowing down.
 */
export function gate(answers, state) {
  const notes = [];
  let laneAction = answers.lane_action.choice;
  if (laneAction !== "keep_lane" && answers.lane_action.confidence < CONFIG.LANE_CHANGE_MIN_CONF) {
    notes.push(`lane change ignored: confidence ${answers.lane_action.confidence.toFixed(2)} < ${CONFIG.LANE_CHANGE_MIN_CONF}`);
    laneAction = "keep_lane";
  }
  if (laneAction === "change_left" && !state.ego.can_change_left) { notes.push("change_left impossible → keep"); laneAction = "keep_lane"; }
  if (laneAction === "change_right" && !state.ego.can_change_right) { notes.push("change_right impossible → keep"); laneAction = "keep_lane"; }

  // "Near" = within 1.5× the stopping distance plus a margin: only then is a full stop justified.
  const nearDist = Math.max(state.ego.stopping_distance_m * 1.5 + 6, 10);
  const ped = state.pedestrian_in_path;
  const pedNear = Boolean(ped && ped.distance_m <= nearDist);
  const laneNear = state.lanes.current.clear_ahead_m <= nearDist;

  let speedAction = answers.speed_action.choice;
  if (answers.pedestrian_yield.noul >= CONFIG.PED_YIELD_THRESHOLD) {
    if (pedNear && speedAction !== "stop") { notes.push(`pedestrian_yield ${answers.pedestrian_yield.noul.toFixed(2)} → stop`); speedAction = "stop"; }
    else if (!pedNear && (speedAction === "speed_up" || speedAction === "hold")) { notes.push(`pedestrian_yield ${answers.pedestrian_yield.noul.toFixed(2)} (far) → slow_down`); speedAction = "slow_down"; }
  }
  if (speedAction === "stop" && !pedNear && !laneNear) {
    notes.push(`stop softened → slow_down (nothing within ${nearDist.toFixed(0)} m)`);
    speedAction = "slow_down";
  }
  if (answers.hazard.score >= 2.5 && (speedAction === "speed_up" || speedAction === "hold")) {
    notes.push(`hazard ${answers.hazard.score.toFixed(2)} → slow_down`);
    speedAction = "slow_down";
  }
  return { laneAction, speedAction, notes };
}
