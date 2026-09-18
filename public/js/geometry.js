// Rectangle geometry shared by the world, the car and the sensors.
/** Axis-aligned overlap in world space. */
export function overlaps(a, b, pad = 0) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + pad;
}

/** Corners of a rectangle rotated by `heading` (0 = facing +y). */
export function corners(o) {
  const h = o.heading || 0, c = Math.cos(h), s = Math.sin(h);
  const fx = s, fy = c, rx = c, ry = -s; // forward and right unit vectors
  const hw = o.w / 2, hh = o.h / 2;
  return [
    [o.x + fx * hh + rx * hw, o.y + fy * hh + ry * hw],
    [o.x + fx * hh - rx * hw, o.y + fy * hh - ry * hw],
    [o.x - fx * hh - rx * hw, o.y - fy * hh - ry * hw],
    [o.x - fx * hh + rx * hw, o.y - fy * hh + ry * hw],
  ];
}

/** Horizontal extent [minX, maxX] of a rectangle, honoring rotation. */
export function extentX(o) {
  if (!o.heading) return [o.x - o.w / 2, o.x + o.w / 2];
  const xs = corners(o).map((c) => c[0]);
  return [Math.min(...xs), Math.max(...xs)];
}

/** Separating-axis test between two (possibly rotated) rectangles. */
export function collides(a, b) {
  if (!overlaps(a, b, Math.max(a.h, b.h))) return false; // cheap reject
  const ca = corners(a), cb = corners(b);
  const axes = [];
  for (const poly of [ca, cb]) for (let i = 0; i < 2; i++) {
    const dx = poly[(i + 1) % 4][0] - poly[i][0], dy = poly[(i + 1) % 4][1] - poly[i][1];
    const len = Math.hypot(dx, dy) || 1; axes.push([-dy / len, dx / len]);
  }
  for (const [ax, ay] of axes) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const [x, y] of ca) { const d = x * ax + y * ay; amin = Math.min(amin, d); amax = Math.max(amax, d); }
    for (const [x, y] of cb) { const d = x * ax + y * ay; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

