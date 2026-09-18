# Jev Self-Driving Sim

A 2D, top-down autonomous car that runs in the browser and uses
[TypeSafe's Jev](https://docs.typesafe.ai/introduction) (a "System One" decision model)
as its driving classifier. Every ~200 ms the car turns what its sensors see into a JSON
state, sends it to Jev with four typed questions, and executes the answers:

| question           | type   | what Jev decides                                  |
|--------------------|--------|---------------------------------------------------|
| `lane_action`      | choice | `keep_lane` / `change_left` / `change_right`      |
| `speed_action`     | choice | `stop` / `slow_down` / `hold` / `speed_up`        |
| `hazard`           | score  | 0 (clear) … 3 (collision likely within seconds)   |
| `pedestrian_yield` | noul   | probability that ego must stop for a pedestrian   |

All four go in a single API call (speculative fan-out). Code then applies
confidence-gated routing: a low-confidence lane change is ignored, a strong
`pedestrian_yield` overrides speed, a severe `hazard` forces at least `slow_down`,
and a `stop` is softened to `slow_down` when nothing is within 1.5× the stopping
distance (so far-away pedestrians or obstacles cause a gentle slowdown, not a halt).
Speed steps are scaled by the time since the previous answer, so a fast Jev does not
brake harder than a slow one.
A small "reflex" in code (emergency brake, blind-spot abort) exists only for
imminent impacts and can be switched off in the UI.

## Jev vs LLM, side by side

With an OpenRouter key the page offers a **Compare** mode: two tracks on the same
course, the left car driven by Jev and the right one by an LLM (DeepSeek V4.1 Flash by
default) that receives the very same state and questions and must answer in the same
JSON shape. The course (`public/js/course.js`) is generated once from the seed as a list
of spawn events with absolute road positions; each event fires when that track's car
passes its mark, so both cars meet the same cones, barriers, parked cars, traffic and
pedestrians in the same places, each at its own pace. Obstacles you click are placed on
both tracks at the same distance ahead.
A live table shows, per driver: distance, average speed, decisions, latency, input and
output tokens, cost so far, cost per decision and projected cost per hour of driving.
Pricing: Jev $0.042 per million input tokens (output free); the LLM price is fetched
from OpenRouter. Both can be overridden in `.env`.

## Run it

```sh
npm install
cp .env.example .env      # TYPESAFE_API_KEY from https://console.typesafe.ai/settings/keys
                          # optional OPENROUTER_API_KEY for the comparison mode
npm start                 # http://localhost:3000
```

Without a key the app still runs, with a clearly labelled rule-based fallback brain,
so you can test the world before wiring Jev in. The key never reaches the browser:
`server.js` proxies `/api/decide` to the TypeSafe API with the official SDK
(the API also rejects browser origins, so a proxy is required anyway).

## Using the simulator

* **Click the road** to add objects at runtime: cone, barrier, parked car, traffic car,
  truck, pedestrian, or remove (keys 1–7 select the tool).
* **Auto traffic** keeps spawning slow cars ahead, faster cars from behind, trucks,
  pedestrians that cross the street, and static obstacles. Density is adjustable.
* **Restart** (R) resets the world. Enter a seed to replay the same scenario.
* The right panel shows every Jev answer with its probabilities, confidence,
  latency, the gating notes, the exact state JSON sent, and the questions.
* Space pauses.

## Layout

```
server.js            static hosting, /api/decide (Jev via @typesafe-ai/sdk), /api/llm-decide (OpenRouter)
public/js/brain.js   the four questions, fetch to /api/decide, local fallback, gating
public/js/sensors.js perception → state JSON, swept-path reflex, ray casting
public/js/car.js     ego vehicle: lane-centering + speed controller, bicycle model
public/js/course.js  deterministic spawn schedule shared by every track
public/js/world.js   road, NPC cars, pedestrians, collisions
public/js/render.js  canvas drawing
public/js/main.js    game loop, decision loop, UI wiring
scripts/headless.js  runs the sim in Node with the fallback brain (no browser)
```

`node scripts/headless.js 150 42 500` simulates 150 s with seed 42 and a 500 ms
decision interval and prints a summary; set `TRACE=1` to dump the last states.
With the server running, `BRAIN=jev node scripts/headless.js 60 7` drives the same
simulation with real Jev answers and `BRAIN=llm` with the LLM (`TRACE=1 TRACE_ACTION=slow_down`
lists those decisions); the summary includes tokens and cost.

## Tuning

Constants live in `public/js/config.js` (speeds, sensor range, decision interval,
confidence thresholds). Question wording lives in `public/js/brain.js`; the state
schema Jev sees is built in `public/js/sensors.js`.
