/** Duration metrics operate on unions, never summed overlapping labels (METRICS.md). */
export function rangeUnion(ranges) {
  if (!Array.isArray(ranges) || ranges.length > 56250)
    throw new Error("Invalid metric range count.");
  const ordered = ranges.map((r) => {
    if (
      typeof r?.startUs !== "string" ||
      typeof r?.endUs !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$(?![\s\S])/.test(r.startUs) ||
      !/^(0|[1-9][0-9]{0,19})$(?![\s\S])/.test(r.endUs) ||
      BigInt(r.startUs) >= BigInt(r.endUs)
    )
      throw new Error("Invalid metric interval.");
    return { start: BigInt(r.startUs), end: BigInt(r.endUs) };
  });
  ordered.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const union = [];
  for (const r of ordered) {
    const last = union.at(-1);
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else union.push({ ...r });
  }
  return union;
}

/** Exact TP/FP/FN ranges make source-coordinate errors independently inspectable. */
export function overlapIntervals(predictions, gold) {
  const p = rangeUnion(predictions),
    g = rangeUnion(gold);
  const intersection = [];
  let i = 0,
    j = 0;
  while (i < p.length && j < g.length) {
    const a = p[i],
      b = g[j],
      start = a.start > b.start ? a.start : b.start,
      end = a.end < b.end ? a.end : b.end;
    if (start < end) intersection.push({ start, end });
    if (a.end <= b.end) i++;
    else j++;
  }
  function difference(left, right) {
    const result = [];
    let cursor = 0;
    for (const a of left) {
      let start = a.start;
      while (cursor < right.length && right[cursor].end <= start) cursor++;
      for (let k = cursor; k < right.length && right[k].start < a.end; k++) {
        const b = right[k];
        if (start < b.start) result.push({ start, end: b.start });
        if (b.end > start) start = b.end;
        if (start >= a.end) break;
      }
      if (start < a.end) result.push({ start, end: a.end });
    }
    return result;
  }
  const encode = (rs) => rs.map((r) => ({ startUs: String(r.start), endUs: String(r.end) }));
  return {
    tp: encode(intersection),
    fp: encode(difference(p, g)),
    fn: encode(difference(g, p)),
  };
}

export function intervalDuration(ranges) {
  return ranges.reduce((n, r) => n + BigInt(r.endUs) - BigInt(r.startUs), 0n);
}
