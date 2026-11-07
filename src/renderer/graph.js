// Lane layout for a commit graph (commits must be in child-before-parent order).
// Returns, per row, the node column/color plus the edge segments to draw,
// each segment living inside a single row (top -> middle / middle -> bottom / top -> bottom).
// Lane colours are CSS custom properties (--lane-0…11) so they follow the light/dark theme.
const LANE_COLORS = Array.from({ length: 12 }, (_, i) => `var(--lane-${i})`);

function layoutGraph(commits) {
  const lanes = [];       // lanes[i] = hash expected next in lane i (or null)
  const laneColor = [];   // color index of lane i
  let nextColor = 0;
  let maxLanes = 0;
  const rows = [];

  const freeSlot = () => { const i = lanes.indexOf(null); return i === -1 ? lanes.length : i; };
  const alloc = (h) => { const i = freeSlot(); lanes[i] = h; laneColor[i] = nextColor++ % LANE_COLORS.length; return i; };

  for (const c of commits) {
    const before = lanes.slice();
    const beforeColor = laneColor.slice();
    let col = lanes.indexOf(c.hash);
    if (col === -1) col = alloc(c.hash);
    const color = laneColor[col];
    const segs = [];

    // Lanes converging into this commit (other children's branches ending here).
    for (let i = 0; i < before.length; i++) {
      if (before[i] === c.hash) {
        segs.push({ kind: 'in', from: i, to: col, color: beforeColor[i] });
        if (i !== col) lanes[i] = null;
      }
    }

    // First parent continues in this lane; extra parents get (or reuse) a lane.
    const [p0, ...rest] = c.parents;
    lanes[col] = p0 ?? null;
    const outs = [];
    if (p0) outs.push({ to: col, color }); // branches stay parallel and converge at the fork point
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k === -1) k = alloc(p);
      outs.push({ to: k, color: laneColor[k], merge: true });
    }
    for (const o of outs) segs.push({ kind: 'out', from: col, to: o.to, color: o.color, merge: o.merge });

    // Lanes simply passing through this row.
    for (let i = 0; i < before.length; i++) {
      if (before[i] && before[i] !== c.hash) segs.push({ kind: 'pass', from: i, to: i, color: beforeColor[i] });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); laneColor.pop(); }
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
    rows.push({ col, color, segs, merge: c.parents.length > 1 });
  }
  return { rows, maxLanes };
}
