// Jigsaw geometry: build interlocking piece shapes for a rows x cols grid.
//
// Key idea for gap-free seams: every internal edge is generated ONCE in a
// canonical direction. The two pieces that share it use the exact same point
// list (one of them reversed), so the boundary curves match pixel-for-pixel.

// Normalized control points for ONE knobbed edge, going along x in [0,1].
// `py` is perpendicular offset (tab pokes toward +py). Mushroom shape with a
// slight overhang so pieces physically interlock. Tuned to look jigsaw-ish.
const TAB = [
  // [cx1, cy1, cx2, cy2, x, y]  -> cubic bezier triplets after the start (0,0)
  [0.20, 0.00, 0.40, 0.00, 0.40, 0.00],
  [0.45, 0.00, 0.45, -0.10, 0.40, -0.18],
  [0.30, -0.28, 0.30, -0.40, 0.50, -0.40],
  [0.70, -0.40, 0.70, -0.28, 0.60, -0.18],
  [0.55, -0.10, 0.55, 0.00, 0.60, 0.00],
  [0.80, 0.00, 1.00, 0.00, 1.00, 0.00],
];
const TAB_SCALE = 0.55; // shrink knob projection (~0.22 of edge length)

function rand(sign) { return sign; }

// Returns a flat point list [x0,y0, x1,y1, ...] for an edge from A to B.
// type: 0 = straight border edge, +1/-1 = knob to one side or the other.
function edgePoints(ax, ay, bx, by, type) {
  if (type === 0) return [ax, ay, bx, by];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;       // along-edge unit vector
  const px = -uy, py = ux;                   // perpendicular unit vector
  const s = type;                            // tab side
  const pts = [ax, ay];
  for (const seg of TAB) {
    for (let k = 0; k < 6; k += 2) {
      const along = seg[k] * len;
      const perp = seg[k + 1] * len * TAB_SCALE * s;
      pts.push(ax + ux * along + px * perp);
      pts.push(ay + uy * along + py * perp);
    }
  }
  return pts;
}

function reverse(pts) {
  const out = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) { out.push(pts[i], pts[i + 1]); }
  return out;
}

// Build a Path2D for a piece given its four edges' point lists (already in the
// correct walking order). Edges share endpoints; we skip duplicate joints.
function pathFromEdges(edges) {
  const path = new Path2D();
  const first = edges[0];
  path.moveTo(first[0], first[1]);
  for (const e of edges) {
    // consume as cubic triplets when length allows, else lineTo
    if (e.length === 4) {           // straight edge: [ax,ay,bx,by]
      path.lineTo(e[2], e[3]);
    } else {
      for (let i = 2; i + 5 < e.length; i += 6) {
        path.bezierCurveTo(e[i], e[i+1], e[i+2], e[i+3], e[i+4], e[i+5]);
      }
    }
  }
  path.closePath();
  return path;
}

function bbox(edges) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of edges) {
    for (let i = 0; i < e.length; i += 2) {
      minX = Math.min(minX, e[i]); maxX = Math.max(maxX, e[i]);
      minY = Math.min(minY, e[i+1]); maxY = Math.max(maxY, e[i+1]);
    }
  }
  return { minX, minY, maxX, maxY };
}

// Generate the full puzzle model.
//   boardW/boardH: pixel size of the assembled image on the board
//   rows/cols: grid
// Returns { pieces: [...], cellW, cellH } where each piece has:
//   r, c, path (Path2D in board coords), bbox, targetX/Y (board px of bbox topleft)
export function buildPuzzle(boardW, boardH, rows, cols, rng = Math.random) {
  const cellW = boardW / cols;
  const cellH = boardH / rows;

  // Random tab signs for internal edges.
  // hSign[r][c] = sign of the horizontal edge on TOP of piece (r,c), r in 1..rows-1
  // vSign[r][c] = sign of the vertical edge on LEFT of piece (r,c), c in 1..cols-1
  const hSign = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
  const vSign = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++)
      hSign[r][c] = rng() < 0.5 ? 1 : -1;
  for (let r = 0; r < rows; r++)
    for (let c = 1; c < cols; c++)
      vSign[r][c] = rng() < 0.5 ? 1 : -1;

  const pieces = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW, y0 = r * cellH;
      const x1 = x0 + cellW, y1 = y0 + cellH;

      // Canonical edges (top & left use this piece's signs; bottom & right are
      // the next piece's top/left, so identical curves -> perfect seams).
      const topType    = r === 0        ? 0 : hSign[r][c];
      const bottomType = r === rows - 1 ? 0 : hSign[r + 1][c];
      const leftType   = c === 0        ? 0 : vSign[r][c];
      const rightType  = c === cols - 1 ? 0 : vSign[r][c + 1];

      const top    = edgePoints(x0, y0, x1, y0, topType);          // L->R
      const right  = edgePoints(x1, y0, x1, y1, rightType);        // T->B
      const bottom = reverse(edgePoints(x0, y1, x1, y1, bottomType)); // walk R->L
      const left   = reverse(edgePoints(x0, y0, x0, y1, leftType));   // walk B->T

      const edges = [top, right, bottom, left];
      const box = bbox(edges);
      const path = pathFromEdges(edges);

      pieces.push({
        r, c,
        path,
        targetX: box.minX,
        targetY: box.minY,
        w: box.maxX - box.minX,
        h: box.maxY - box.minY,
        bbox: box,
      });
    }
  }
  return { pieces, cellW, cellH };
}
