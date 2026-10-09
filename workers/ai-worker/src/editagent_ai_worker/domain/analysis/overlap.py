"""US-110 duration-overlap arithmetic: half-open unions, no collar, integer microseconds."""

from collections.abc import Iterable
from dataclasses import dataclass

from editagent_ai_worker.domain.analysis.voice_activity import MAX_DURATION_US, integer

Interval = tuple[int, int]


def union(intervals: Iterable[Interval], scope: Interval) -> tuple[Interval, ...]:
    integer(scope[0], 0, MAX_DURATION_US)
    integer(scope[1], scope[0] + 1, MAX_DURATION_US)
    clipped = []
    for start, end in intervals:
        integer(start, 0, MAX_DURATION_US)
        integer(end, start + 1, MAX_DURATION_US)
        a, b = max(start, scope[0]), min(end, scope[1])
        if a < b:
            clipped.append((a, b))
    result: list[Interval] = []
    for start, end in sorted(clipped):
        if result and start <= result[-1][1]:
            result[-1] = result[-1][0], max(end, result[-1][1])
        else:
            result.append((start, end))
    return tuple(result)


def complement(intervals: Iterable[Interval], scope: Interval) -> tuple[Interval, ...]:
    result = []
    cursor = scope[0]
    for start, end in union(intervals, scope):
        if cursor < start:
            result.append((cursor, start))
        cursor = end
    if cursor < scope[1]:
        result.append((cursor, scope[1]))
    return tuple(result)


@dataclass(frozen=True)
class OverlapMetrics:
    tp_us: int
    fp_us: int
    fn_us: int

    @property
    def precision(self) -> float:
        return self.tp_us / (self.tp_us + self.fp_us) if self.tp_us + self.fp_us else 1.0

    @property
    def recall(self) -> float:
        return self.tp_us / (self.tp_us + self.fn_us) if self.tp_us + self.fn_us else 1.0

    @property
    def f1(self) -> float:
        denominator = 2 * self.tp_us + self.fp_us + self.fn_us
        return 2 * self.tp_us / denominator if denominator else 1.0


def overlap(
    predicted: Iterable[Interval], gold: Iterable[Interval], scope: Interval
) -> OverlapMetrics:
    p, g = union(predicted, scope), union(gold, scope)
    i = j = tp = 0
    while i < len(p) and j < len(g):
        tp += max(0, min(p[i][1], g[j][1]) - max(p[i][0], g[j][0]))
        if p[i][1] <= g[j][1]:
            i += 1
        else:
            j += 1
    return OverlapMetrics(tp, sum(b - a for a, b in p) - tp, sum(b - a for a, b in g) - tp)
