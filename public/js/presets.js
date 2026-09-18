import { CONFIG, laneCenter } from "./config.js";

// Preset courses: static obstacles only (no traffic, no pedestrians), so the models have
// to steer around things. Each preset is a repeating pattern: `period` metres long, with
// obstacles at absolute y positions. Lanes: 0 = left, 1 = middle, 2 = right.
const cone = (lane, y, dx = 0) => ({ type: "cone", lane, x: laneCenter(lane) + dx, y });
const barrier = (lane, y) => ({ type: "barrier", lane, x: laneCenter(lane), y });
const parked = (lane, y) => ({ type: "parked_car", lane, x: laneCenter(lane) + (lane === 0 ? -0.5 : lane === CONFIG.LANES - 1 ? 0.5 : 0), y });

function slalom() {
  // Pairs of cones close two lanes at a time; the open lane moves one step each gate (0,1,2,1,0,...).
  const out = []; let y = 45;
  const open = [1, 2, 1, 0, 1, 2, 1, 0];
  for (let i = 0; i < open.length; i++, y += 32) for (let l = 0; l < CONFIG.LANES; l++) if (l !== open[i]) out.push(cone(l, y));
  return { period: y, events: out };
}

function chicane() {
  // Barriers block two lanes; the open lane steps one lane at a time, with a 65 m run-up between gates.
  const out = []; let y = 60;
  const open = [2, 1, 0, 1, 2, 1, 0, 1];
  for (let i = 0; i < open.length; i++, y += 65) for (let l = 0; l < CONFIG.LANES; l++) if (l !== open[i]) out.push(barrier(l, y));
  return { period: y, events: out };
}

function parkedCars() {
  // Cars parked in changing lanes; the middle lane is blocked regularly so nobody can just cruise.
  const out = []; let y = 45;
  const lanes = [1, 0, 2, 1, 2, 0, 1, 0, 2];
  for (const l of lanes) { out.push(parked(l, y)); y += 38; }
  return { period: y, events: out };
}

function gauntlet() {
  // Mixed obstacles with the spacing tightening from 50 m to 24 m, then it repeats.
  const out = []; let y = 50; const seq = ["cone", "barrier", "parked", "cone", "cone", "barrier", "parked", "cone", "barrier", "parked", "cone", "barrier"];
  const laneSeq = [1, 0, 2, 1, 0, 2, 1, 2, 0, 1, 2, 0];
  for (let i = 0; i < seq.length; i++) {
    const l = laneSeq[i];
    if (seq[i] === "cone") { out.push(cone(l, y)); if (i % 3 === 2) out.push(cone((l + 1) % 3, y + 2)); }
    else if (seq[i] === "barrier") out.push(barrier(l, y));
    else out.push(parked(l, y));
    y += Math.max(24, 50 - i * 2.5);
  }
  return { period: y + 20, events: out };
}

function twoLaneSqueeze() {
  // Long barrier rows leave only one lane open for a stretch, then switch sides.
  const out = []; let y = 50;
  for (let i = 0; i < 4; i++) {
    const open = i % 2 === 0 ? 0 : 2;
    for (let k = 0; k < 3; k++) for (let l = 0; l < CONFIG.LANES; l++) if (l !== open) out.push(barrier(l, y + k * 12));
    y += 36 + 70;
  }
  return { period: y, events: out };
}

export const PRESETS = {
  traffic: { name: "Random traffic & pedestrians", description: "Seeded mix of cars, trucks, pedestrians and obstacles.", pattern: null },
  random_static: { name: "Random obstacles (static only)", description: "Seeded cones, barriers and parked cars, no traffic.", pattern: null, staticOnly: true },
  slalom: { name: "Slalom (cone pairs)", description: "Cone pairs close two lanes at a time; the open lane shifts one step every 32 m.", pattern: slalom() },
  chicane: { name: "Chicane (barriers)", description: "Barriers leave one lane open, shifting one lane every 65 m.", pattern: chicane() },
  parked: { name: "Parked cars", description: "Cars parked in changing lanes every 38 m.", pattern: parkedCars() },
  gauntlet: { name: "Gauntlet (mixed, tightening)", description: "Cones, barriers and parked cars with the gap shrinking from 50 m to 24 m.", pattern: gauntlet() },
  squeeze: { name: "Single-lane squeeze (hard)", description: "Barrier rows leave one lane open for 36 m, alternating left/right: a double lane change each time.", pattern: twoLaneSqueeze() },
  empty: { name: "Empty road", description: "Nothing on the road: a baseline for speed and cost.", pattern: { period: 1000, events: [] } },
};
