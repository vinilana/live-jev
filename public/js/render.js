import { CONFIG, ROAD_HALF_W, laneCenter } from "./config.js";

const PX = CONFIG.PX_PER_M;
const W = CONFIG.CANVAS_W, H = CONFIG.CANVAS_H;
const hash = (n) => { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getBoundingClientRect ? canvas.getContext("2d") : null;
    canvas.width = W; canvas.height = H;
    this.showRays = true;
    this.ghost = null; // {type, x, y} for placement preview
  }

  toScreen(x, y, egoY) { return [W / 2 + x * PX, H * CONFIG.EGO_SCREEN_Y - (y - egoY) * PX]; }
  toWorld(sx, sy, egoY) { return [(sx - W / 2) / PX, egoY + (H * CONFIG.EGO_SCREEN_Y - sy) / PX]; }

  draw(world, perception, ui) {
    const ctx = this.ctx, ego = world.ego;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    this.drawEnvironment(ctx, ego.y);
    this.drawRoad(ctx, ego.y);
    for (const o of world.objects) this.drawObject(ctx, o, ego.y);
    if (this.ghost) this.drawObject(ctx, { ...this.ghost, w: 1.85, h: 4.3, ghost: true }, ego.y);
    if (this.showRays && perception) this.drawRays(ctx, perception.rays, ego.y, ego);
    this.drawEgo(ctx, ego, ui);
    this.drawHud(ctx, world, perception, ui);
    if (world.crashed) this.drawCrash(ctx, world.crashed);
    ctx.restore();
  }

  drawEnvironment(ctx, egoY) {
    ctx.fillStyle = "#1f2a1f"; ctx.fillRect(0, 0, W, H);
    const edge = ROAD_HALF_W + CONFIG.SIDEWALK_W;
    // sidewalks
    const [sxL] = this.toScreen(-edge, 0, egoY), [sxR] = this.toScreen(ROAD_HALF_W, 0, egoY);
    ctx.fillStyle = "#8a8f96";
    ctx.fillRect(sxL, 0, CONFIG.SIDEWALK_W * PX, H);
    ctx.fillRect(sxR, 0, CONFIG.SIDEWALK_W * PX, H);
    // pavement joints
    ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1;
    const jointStart = Math.floor((egoY - 70) / 3) * 3;
    for (let y = jointStart; y < egoY + 70; y += 3) {
      const [, sy] = this.toScreen(0, y, egoY);
      ctx.beginPath(); ctx.moveTo(sxL, sy); ctx.lineTo(sxL + CONFIG.SIDEWALK_W * PX, sy);
      ctx.moveTo(sxR, sy); ctx.lineTo(sxR + CONFIG.SIDEWALK_W * PX, sy); ctx.stroke();
    }
    // buildings + trees, deterministic per 14 m block
    const blockLen = 14;
    const b0 = Math.floor((egoY - 70) / blockLen);
    for (let b = b0; b * blockLen < egoY + 75; b++) {
      for (const side of [-1, 1]) {
        const h1 = hash(b * 2 + (side > 0 ? 1 : 0));
        const h2 = hash(b * 7 + (side > 0 ? 3 : 5));
        const depth = 4 + h1 * 5;
        const len = blockLen - 2 - h2 * 3;
        const xNear = side * (edge + 0.6), xFar = side * (edge + 0.6 + depth);
        const [x1, y1] = this.toScreen(Math.min(xNear, xFar), b * blockLen + len, egoY);
        const [x2, y2] = this.toScreen(Math.max(xNear, xFar), b * blockLen, egoY);
        const palette = ["#3b3f52", "#4a3f3a", "#354a4d", "#4d4a37", "#3f3547"];
        ctx.fillStyle = palette[Math.floor(h1 * palette.length)];
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillStyle = "rgba(255,230,150,0.35)";
        for (let wy = y1 + 8; wy < y2 - 8; wy += 14) for (let wx = x1 + 8; wx < x2 - 8; wx += 14) if (hash(wx * 3 + wy) > 0.45) ctx.fillRect(wx, wy, 6, 8);
        if (h2 > 0.35) { // tree on the sidewalk edge
          const [tx, ty] = this.toScreen(side * (edge - 0.7), b * blockLen + 4 + h1 * 6, egoY);
          ctx.fillStyle = "#2f6b34"; ctx.beginPath(); ctx.arc(tx, ty, 0.9 * PX, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#3f8a45"; ctx.beginPath(); ctx.arc(tx - 3, ty - 3, 0.6 * PX, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  drawRoad(ctx, egoY) {
    const [x0] = this.toScreen(-ROAD_HALF_W, 0, egoY);
    ctx.fillStyle = "#34363b"; ctx.fillRect(x0, 0, ROAD_HALF_W * 2 * PX, H);
    // edge lines
    ctx.strokeStyle = "#e8e8e8"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0 + 2, 0); ctx.lineTo(x0 + 2, H); ctx.moveTo(x0 + ROAD_HALF_W * 2 * PX - 2, 0); ctx.lineTo(x0 + ROAD_HALF_W * 2 * PX - 2, H); ctx.stroke();
    // dashed lane lines
    ctx.strokeStyle = "#d8d8d8"; ctx.lineWidth = 2; ctx.setLineDash([3 * PX, 3 * PX]);
    const dashOffset = -((egoY * PX) % (6 * PX));
    for (let i = 1; i < CONFIG.LANES; i++) {
      const [lx] = this.toScreen(-ROAD_HALF_W + i * CONFIG.LANE_W, 0, egoY);
      ctx.lineDashOffset = dashOffset;
      ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
    }
    ctx.setLineDash([]);
    // direction arrows every 20 m
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    const a0 = Math.floor((egoY - 70) / 20) * 20;
    for (let y = a0; y < egoY + 70; y += 20) for (let i = 0; i < CONFIG.LANES; i++) {
      const [ax, ay] = this.toScreen(laneCenter(i), y, egoY);
      ctx.beginPath(); ctx.moveTo(ax, ay - 14); ctx.lineTo(ax + 7, ay); ctx.lineTo(ax + 2, ay); ctx.lineTo(ax + 2, ay + 12); ctx.lineTo(ax - 2, ay + 12); ctx.lineTo(ax - 2, ay); ctx.lineTo(ax - 7, ay); ctx.closePath(); ctx.fill();
    }
  }

  drawVehicle(ctx, o, egoY, color, opts = {}) {
    const [sx, sy] = this.toScreen(o.x, o.y, egoY);
    const w = o.w * PX, h = o.h * PX;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(o.heading || 0);
    if (opts.ghost) ctx.globalAlpha = 0.45;
    ctx.fillStyle = "rgba(0,0,0,0.35)"; roundRect(ctx, -w / 2 + 3, -h / 2 + 4, w, h, 5); ctx.fill();
    ctx.fillStyle = color; roundRect(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = "rgba(20,30,40,0.75)"; roundRect(ctx, -w / 2 + 3, -h / 2 + h * 0.18, w - 6, h * 0.2, 3); ctx.fill(); // windshield
    ctx.fillStyle = "rgba(20,30,40,0.55)"; roundRect(ctx, -w / 2 + 3, h / 2 - h * 0.3, w - 6, h * 0.14, 3); ctx.fill(); // rear window
    ctx.fillStyle = opts.headlights ? "#fff7c2" : "#ddd"; ctx.fillRect(-w / 2 + 2, -h / 2, 5, 3); ctx.fillRect(w / 2 - 7, -h / 2, 5, 3);
    ctx.fillStyle = opts.braking ? "#ff3b3b" : "#7a1a1a"; ctx.fillRect(-w / 2 + 2, h / 2 - 3, 5, 3); ctx.fillRect(w / 2 - 7, h / 2 - 3, 5, 3);
    if (opts.hazard && Math.floor(performance.now() / 400) % 2 === 0) { ctx.fillStyle = "#ffb020"; ctx.fillRect(-w / 2, -h / 2 + 4, 3, 5); ctx.fillRect(w / 2 - 3, -h / 2 + 4, 3, 5); ctx.fillRect(-w / 2, h / 2 - 9, 3, 5); ctx.fillRect(w / 2 - 3, h / 2 - 9, 3, 5); }
    ctx.restore();
  }

  drawObject(ctx, o, egoY) {
    const [sx, sy] = this.toScreen(o.x, o.y, egoY);
    if (sy < -80 || sy > H + 80) return;
    switch (o.type) {
      case "car": case "truck": return this.drawVehicle(ctx, o, egoY, o.color || "#c44", { ghost: o.ghost, braking: o.speed < (o.cruise || 0) - 0.5 });
      case "parked_car": return this.drawVehicle(ctx, o, egoY, o.color || "#8d95a3", { ghost: o.ghost, hazard: true });
      case "cone": {
        ctx.save(); if (o.ghost) ctx.globalAlpha = 0.5;
        ctx.fillStyle = "#ff7a1a"; ctx.beginPath(); ctx.arc(sx, sy, 0.35 * PX, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 0.2 * PX, 0, Math.PI * 2); ctx.stroke();
        ctx.restore(); return;
      }
      case "barrier": {
        const w = o.w * PX, h = o.h * PX;
        ctx.save(); if (o.ghost) ctx.globalAlpha = 0.5;
        ctx.fillStyle = "#d33"; ctx.fillRect(sx - w / 2, sy - h / 2, w, h);
        ctx.fillStyle = "#fff"; for (let i = 0; i < w; i += 16) ctx.fillRect(sx - w / 2 + i, sy - h / 2, 8, h);
        ctx.strokeStyle = "#400"; ctx.lineWidth = 1.5; ctx.strokeRect(sx - w / 2, sy - h / 2, w, h);
        ctx.restore(); return;
      }
      case "pedestrian": {
        const bob = o.phase === "crossing" ? Math.sin(performance.now() / 120) * 1.5 : 0;
        ctx.save(); if (o.ghost) ctx.globalAlpha = 0.5;
        ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.beginPath(); ctx.ellipse(sx + 2, sy + 3, 0.4 * PX, 0.3 * PX, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = o.color || "#ffd166"; ctx.beginPath(); ctx.ellipse(sx, sy, 0.38 * PX, 0.28 * PX + bob * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#f1c27d"; ctx.beginPath(); ctx.arc(sx, sy, 0.17 * PX, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); return;
      }
    }
  }

  drawRays(ctx, rays, egoY) {
    ctx.save(); ctx.lineWidth = 1.2;
    for (const r of rays) {
      const [x0, y0] = this.toScreen(r.x0, r.y0, egoY), [x1, y1] = this.toScreen(r.x1, r.y1, egoY);
      ctx.strokeStyle = r.hit ? (r.dist < 12 ? "rgba(255,80,80,0.85)" : "rgba(255,190,60,0.7)") : "rgba(90,220,120,0.35)";
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      if (r.hit) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x1, y1, 3, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  drawEgo(ctx, ego, ui) {
    this.drawVehicle(ctx, ego, ego.y, "#2f7cf6", { headlights: true, braking: ego.accel < -0.5 || ego.reflexActive });
    const [sx, sy] = this.toScreen(ego.x, ego.y, ego.y);
    // decision ring colored by hazard score
    const hz = ui?.hazard ?? 0;
    const ring = hz < 1 ? "rgba(90,220,120,0.9)" : hz < 2 ? "rgba(255,210,60,0.9)" : hz < 2.6 ? "rgba(255,140,40,0.95)" : "rgba(255,60,60,1)";
    ctx.save(); ctx.strokeStyle = ring; ctx.lineWidth = 3; ctx.setLineDash([6, 5]); ctx.lineDashOffset = -(performance.now() / 40) % 11;
    ctx.beginPath(); ctx.arc(sx, sy, 3.4 * PX, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    // intent arrow
    const intent = ego.lastIntent;
    ctx.save(); ctx.translate(sx, sy - 3.4 * PX - 14); ctx.fillStyle = "#fff"; ctx.font = "bold 13px system-ui, sans-serif"; ctx.textAlign = "center";
    const arrow = intent.lane === "change_left" ? "⬅ " : intent.lane === "change_right" ? "➡ " : "⬆ ";
    ctx.fillText(`${arrow}${intent.speed.replace("_", " ")}`, 0, 0);
    ctx.restore();
    if (ego.reflexActive || ego.reversing) {
      ctx.save(); ctx.fillStyle = ego.reversing ? "rgba(255,200,0,0.95)" : "rgba(255,60,60,0.95)"; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(ego.reversing ? "REVERSING" : "REFLEX BRAKE", sx, sy + 3.4 * PX + 20); ctx.restore();
    }
  }

  drawHud(ctx, world, perception, ui) {
    const ego = world.ego;
    ctx.save();
    ctx.fillStyle = "rgba(10,12,16,0.7)"; roundRect(ctx, 12, 12, 150, 92, 8); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 30px system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`${Math.abs(Math.round(ego.speed * 3.6))}`, 24, 50);
    ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = "#b7c0cc"; ctx.fillText("km/h", 90, 50);
    ctx.fillText(`lane ${ego.lane}${ego.laneChanging ? " → " + ego.targetLane : ""}`, 24, 72);
    ctx.fillText(`${Math.round(ego.y)} m · ${world.time.toFixed(0)} s`, 24, 92);
    if (ui?.mode) {
      ctx.textAlign = "right"; ctx.fillStyle = ui.mode === "jev" ? "#7ee787" : ui.mode === "llm" ? "#79b8ff" : "#ffb020"; ctx.font = "bold 12px system-ui, sans-serif";
      const title = ui.mode === "jev" ? `JEV · ${ui.model || ""}` : ui.mode === "llm" ? `LLM · ${(ui.model || "").split("/").pop()}` : `${ui.label ? ui.label + " · " : ""}LOCAL FALLBACK`;
      ctx.fillText(title, W - 14, 28);
      ctx.fillStyle = "#b7c0cc"; ctx.font = "12px system-ui, sans-serif";
      if (ui.latency != null) ctx.fillText(`${ui.latency} ms`, W - 14, 46);
    }
    if (ego.reflexActive) { ctx.strokeStyle = "rgba(255,60,60,0.8)"; ctx.lineWidth = 8; ctx.strokeRect(0, 0, W, H); }
    if (ui?.paused) { ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#fff"; ctx.font = "bold 28px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("PAUSED", W / 2, H / 2); }
    ctx.restore();
  }

  drawCrash(ctx, crashed) {
    ctx.save();
    ctx.fillStyle = "rgba(120,0,0,0.45)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "bold 34px system-ui, sans-serif";
    ctx.fillText("CRASHED", W / 2, H / 2 - 20);
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText(`into ${crashed.type.replace("_", " ")} · press R or Restart`, W / 2, H / 2 + 12);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
