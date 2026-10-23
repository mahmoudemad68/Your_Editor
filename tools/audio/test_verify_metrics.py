"""Independent scorer fixtures; no production inference or annotation writes."""

import unittest

from verify_metrics import score


def ranges(mask: int) -> list[dict[str, str]]:
    return [
        {"startUs": str(i), "endUs": str(i + 1)} for i in range(4) if mask & (1 << i)
    ]


class IntervalVerificationTests(unittest.TestCase):
    def test_exhaustive_cell_occupancy(self) -> None:
        for p in range(16):
            for g in range(16):
                actual = score(ranges(p) * 2, list(reversed(ranges(g))))
                self.assertEqual(int(actual["tpUs"]), (p & g).bit_count())
                self.assertEqual(int(actual["fpUs"]), (p & ~g).bit_count())
                self.assertEqual(int(actual["fnUs"]), (g & ~p).bit_count())

    def test_large_time_and_empty_conventions(self) -> None:
        self.assertEqual(score([], [])["f1"], 1)
        self.assertEqual(score([], ranges(1))["recall"], 0)
        self.assertEqual(score(ranges(1), [])["precision"], 0)
        start = 9007199254740993
        p = [{"startUs": str(start), "endUs": str(start + 10)}]
        g = [{"startUs": str(start + 1), "endUs": str(start + 11)}]
        self.assertEqual(score(p, g)["tpUs"], "9")


if __name__ == "__main__":
    unittest.main()
