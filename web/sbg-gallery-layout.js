export function computeMetrics(container, thumbSize, gap, searchActive, perRow, infoHeights) {
  const cw = container.clientWidth;
  if (cw <= 0) return null;
  const colCount = perRow > 0 ? perRow : Math.max(1, Math.floor((cw + gap) / (thumbSize + gap)));
  const colW = (cw - (colCount - 1) * gap) / colCount;

  const infoH = searchActive ? infoHeights[1] : infoHeights[0];
  const rowH = colW + infoH + gap;
  return { colCount, rowH, colW, gap, infoH };
}

export function computeMasonryLayout(items, metrics, fixedPerRow) {
  const { colCount, colW, gap, infoH } = metrics;
  const containerW = colCount * colW + (colCount - 1) * gap;
  const targetH = colW;
  const positions = new Array(items.length);

  const arOf = (it) => {
    const ar = it.w > 0 && it.h > 0 ? it.w / it.h : 1;
    // Bounds how far a very tall or very wide picture can stretch or flatten its row.
    return Math.max(0.4, Math.min(2.5, ar));
  };

  let y = 0;
  let i = 0;
  let prevRowH = 0;
  while (i < items.length) {
    const row = [];
    let sumAR = 0;

    let filled = false;
    while (i < items.length) {
      const ar = arOf(items[i]);
      row.push({ idx: i, ar });
      sumAR += ar;
      i++;
      if (fixedPerRow > 0) {
        if (row.length >= fixedPerRow) { filled = true; break; }
        continue;
      }
      const rowW = sumAR * targetH + (row.length - 1) * gap;
      if (rowW >= containerW) { filled = true; break; }
    }
    const totalGap = (row.length - 1) * gap;
    let rowH;
    if (!filled && fixedPerRow > 0) {
      // A last row that never filled gives its cards as many columns as there
      // are cards, so each is the size it would have in a full row of pictures
      // shaped like these.
      rowH = colW * row.length / sumAR;
    } else if (!filled) {
      // With no fixed count there are no columns to share, so the row keeps the
      // height of the row above.
      rowH = prevRowH || targetH;
    } else if (fixedPerRow > 0) {
      rowH = (containerW - totalGap) / sumAR;
    } else {
      rowH = Math.max(targetH * 0.6, (containerW - totalGap) / sumAR);
    }
    prevRowH = rowH;
    const thumbH = Math.round(rowH);
    const cardH = thumbH + infoH;

    let x = 0;
    for (let k = 0; k < row.length; k++) {
      const r = row[k];
      const w = (filled && k === row.length - 1) ? Math.max(1, containerW - x) : Math.round(rowH * r.ar);
      positions[r.idx] = { x, y, w, h: cardH, thumbH };
      x += w + gap;
    }
    y += cardH + gap;
  }

  const totalHeight = y > 0 ? y - gap : 0;
  return { positions, totalHeight };
}

// Both searches need `positions` in row order, as the layout above emits them.
export function masonryVisibleRange(positions, topEdge, bottomEdge) {
  const n = positions.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = positions[mid];
    if (p.y + p.h > topEdge) hi = mid; else lo = mid + 1;
  }
  const firstIdx = lo;

  lo = firstIdx; hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid].y >= bottomEdge) hi = mid; else lo = mid + 1;
  }
  return [firstIdx, lo];
}
