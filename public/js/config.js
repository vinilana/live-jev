// World units are meters; y grows in the driving direction, x grows to the right (0 = road center).
export const CONFIG = {
  PX_PER_M: 14,
  LANE_W: 3.5,
  LANES: 3,                 // one-way road, lane 0 = leftmost, lane 2 = rightmost
  SIDEWALK_W: 2.6,
  CANVAS_W: 600,
  CANVAS_H: 840,
  EGO_SCREEN_Y: 0.78,       // ego drawn at 78% down the canvas

  EGO_MAX_SPEED_KMH: 45,
  EGO_ACCEL: 2.6,           // m/s^2
  EGO_BRAKE: 6.0,           // m/s^2 (normal braking to a stop)
  EGO_EMERGENCY_BRAKE: 9.5, // m/s^2 (reflex)
  EGO_STEER_MAX: 0.55,      // rad
  EGO_WHEELBASE: 2.6,       // m

  SENSOR_RANGE: 60,         // m ahead the perception summary looks
  SENSOR_BEHIND: 35,        // m behind for adjacent-lane traffic
  RAY_COUNT: 9,
  RAY_RANGE: 45,

  DECISION_MIN_INTERVAL_MS: 180,
  LANE_CHANGE_MIN_CONF: 0.45,
  PED_YIELD_THRESHOLD: 0.6,

  SPAWN_AHEAD_MIN: 62, SPAWN_AHEAD_MAX: 80,
  SPAWN_BEHIND: 48,
  DESPAWN_BEHIND: 70,
  DESPAWN_AHEAD: 140,
};

export const SIZES = {
  car: { w: 1.85, h: 4.3 },
  truck: { w: 2.4, h: 7.5 },
  parked_car: { w: 1.85, h: 4.3 },
  cone: { w: 0.55, h: 0.55 },
  barrier: { w: 3.1, h: 0.8 },
  pothole: { w: 1.2, h: 1.2 },
  pedestrian: { w: 0.7, h: 0.7 },
};

export const ROAD_HALF_W = (CONFIG.LANES * CONFIG.LANE_W) / 2;
export const laneCenter = (i) => (i - (CONFIG.LANES - 1) / 2) * CONFIG.LANE_W;
export const laneOf = (x) => {
  const i = Math.floor((x + ROAD_HALF_W) / CONFIG.LANE_W);
  return Math.max(0, Math.min(CONFIG.LANES - 1, i));
};
export const kmh = (ms) => Math.round(ms * 3.6);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
