import { CONFIG, SIZES, ROAD_HALF_W, laneCenter, laneOf, clamp } from "./config.js";
import { corners } from "./geometry.js";

// The ego vehicle. Jev decides *what* to do (lane + speed intent); this class
// turns that intent into steering/throttle with plain code (the "System One
// decides, code executes" pattern).
/** Lane-centering steering law, shared with the swept-path predictor in sensors.js. */
export function steerFor(x, heading, speed, targetLane) {
  const err = laneCenter(targetLane) - x;
  const lookahead = clamp(4 + Math.abs(speed) * 0.6, 4, 12);
  const desiredHeading = Math.atan2(err, lookahead);
  return clamp((desiredHeading - heading) * 2.2, -CONFIG.EGO_STEER_MAX, CONFIG.EGO_STEER_MAX);
}

/** One kinematic step (also used by the predictor). Mutates and returns `s`. */
export function stepKinematics(s, dt) {
  const yawRate = Math.abs(s.speed) > 0.05 ? (s.speed / CONFIG.EGO_WHEELBASE) * Math.tan(s.steer) : 0;
  s.heading = clamp(s.heading + yawRate * dt, -0.9, 0.9);
  s.x += Math.sin(s.heading) * s.speed * dt;
  s.y += Math.cos(s.heading) * s.speed * dt;
  return s;
}

export class EgoCar {
  constructor() {
    this.type = "ego";
    this.w = SIZES.car.w; this.h = SIZES.car.h;
    this.x = laneCenter(1); this.y = 0;
    this.heading = 0;             // rad, 0 = straight ahead, + = turning right
    this.speed = 0;               // m/s
    this.steer = 0;
    this.accel = 0;
    this.maxSpeed = CONFIG.EGO_MAX_SPEED_KMH / 3.6;
    this.targetLane = 1;
    this.targetSpeed = this.maxSpeed;
    this.laneChangeStartedAt = -99;
    this.laneChanging = false;
    this.reflexActive = false;
    this.reflexEnabled = true;
    this.reversing = false;
    this.lastIntent = { lane: "keep_lane", speed: "speed_up" };
  }

  get lane() { return laneOf(this.x); }

  /** Apply a decision produced by the brain (already gated/validated). */
  applyIntent({ laneAction, speedAction }, simTime) {
    this.lastIntent = { lane: laneAction, speed: speedAction };
    if (!this.laneChanging) {
      if (laneAction === "change_left" && this.targetLane > 0) { this.targetLane -= 1; this.laneChanging = true; this.laneChangeStartedAt = simTime; }
      if (laneAction === "change_right" && this.targetLane < CONFIG.LANES - 1) { this.targetLane += 1; this.laneChanging = true; this.laneChangeStartedAt = simTime; }
    }
    // Steps scale with the time since the last decision, so a fast Jev (3-4 answers/s)
    // does not brake harder than a slow one: ~5 m/s of change per second of "slow_down".
    const elapsed = clamp(simTime - (this.lastDecisionAt ?? simTime - 0.5), 0.15, 1.0);
    this.lastDecisionAt = simTime;
    const step = 5 * elapsed;
    switch (speedAction) {
      case "stop": this.targetSpeed = 0; break;
      case "slow_down": this.targetSpeed = clamp(Math.min(this.speed, this.targetSpeed) - step, 0, this.maxSpeed); break;
      case "hold": this.targetSpeed = clamp(this.speed, 0, this.maxSpeed); break;
      case "speed_up": this.targetSpeed = clamp(Math.max(this.speed, this.targetSpeed) + step * 1.2, 0, this.maxSpeed); break;
    }
  }

  /**
   * dt in seconds. `reflex` = {brake, frontClearance, rearClearance} from sensors:
   * `brake` is the emergency stop; the clearances drive the low-speed unboxing maneuver.
   */
  update(dt, reflex, simTime) {
    const front = reflex?.sweptClearance ?? 99, rear = reflex?.rearClearance ?? 99;
    // --- lateral controller: pure-pursuit style lane centering
    const err = laneCenter(this.targetLane) - this.x;
    this.holdingLateral = Boolean(this.laneChanging && reflex?.blindSpotHold);
    // Something sits beside us in the target lane and our own lane is not safe to return to:
    // straighten out and wait where we are instead of merging into it.
    this.steer = this.holdingLateral
      ? clamp(-this.heading * 2.5, -CONFIG.EGO_STEER_MAX, CONFIG.EGO_STEER_MAX)
      : steerFor(this.x, this.heading, this.speed, this.targetLane);
    if (this.laneChanging && Math.abs(err) < 0.25 && Math.abs(this.heading) < 0.04) this.laneChanging = false;
    if (this.laneChanging && simTime - this.laneChangeStartedAt > 9) { // give up: go back to the lane we are in
      if (reflex?.returnSafe !== false) { this.laneChanging = false; this.targetLane = this.lane; this.reversing = false; }
      else this.laneChangeStartedAt = simTime - 6; // going back would hit something: keep trying a bit longer
    }

    // --- blind-spot abort: something moved into the target lane -> go back to our lane
    if (this.laneChanging && reflex?.blindSpot && this.targetLane !== this.lane) {
      this.targetLane = this.lane; this.reversing = false; this.abortedAt = simTime;
    }

    // --- boxed in? (wants to change lane, is stopped, cannot swing out) -> back up a little
    const nearCurb = corners(this).some(([cx]) => Math.abs(cx) > ROAD_HALF_W - 0.25);
    if (this.laneChanging && !this.reversing && this.speed < 0.4 && front < 3.0 && rear > 3.5 && !reflex?.holdForPedestrian && !nearCurb) this.reversing = true;
    if (this.reversing && (front >= 4.5 || rear < 1.2 || !this.laneChanging || reflex?.holdForPedestrian || nearCurb)) this.reversing = false;

    // --- longitudinal controller
    this.reflexActive = Boolean(reflex && reflex.brake && this.reflexEnabled && !this.reversing);
    let target = this.targetSpeed;
    // creep through the maneuver: a "stop" intent means "don't drive into the obstacle", not "freeze mid-lane-change"
    if (this.laneChanging && target < 2.0 && !reflex?.holdForPedestrian && front > 3.0 && !this.holdingLateral) target = 2.0;
    if (this.holdingLateral) target = Math.min(target, front > 4 ? 1.0 : 0);
    if (this.reversing) { target = -1.3; this.steer = clamp(this.heading * 2.0, -CONFIG.EGO_STEER_MAX, CONFIG.EGO_STEER_MAX); } // back up while straightening
    if (this.reflexActive) target = 0;
    const diff = target - this.speed;
    if (diff > 0) this.accel = Math.min(CONFIG.EGO_ACCEL, diff * 1.5);
    else this.accel = Math.max(this.reflexActive ? -CONFIG.EGO_EMERGENCY_BRAKE : -CONFIG.EGO_BRAKE, diff * 2.0);
    this.speed = clamp(this.speed + this.accel * dt, this.reversing ? -1.3 : 0, this.maxSpeed);

    // --- kinematic bicycle model (works for reverse too)
    stepKinematics(this, dt);
  }
}
