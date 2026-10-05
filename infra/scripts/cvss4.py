"""CVSS v4.0 base score.

The lookup tables and macro-vector scoring follow the FIRST CVSS v4.0
calculator (BSD-2-Clause, Copyright FIRST, Red Hat, and contributors).
A vector that is not a complete v4.0 base vector returns None.
"""

import json
import math
from pathlib import Path

_TABLES = json.loads(
    (Path(__file__).with_name("cvss4_tables.json")).read_text(encoding="utf-8")
)

_LOOKUP = _TABLES["lookup"]
_MAX_COMPOSED = _TABLES["maxComposed"]
_MAX_SEVERITY = _TABLES["maxSeverity"]

_BASE = ("AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA")
_OPTIONAL = (
    "E",
    "CR",
    "IR",
    "AR",
    "MAV",
    "MAC",
    "MAT",
    "MPR",
    "MUI",
    "MVC",
    "MVI",
    "MVA",
    "MSC",
    "MSI",
    "MSA",
)
_SUPPLEMENTAL = {"S", "AU", "R", "V", "RE", "U"}
_ALLOWED = {
    "AV": {"N", "A", "L", "P"},
    "AC": {"L", "H"},
    "AT": {"N", "P"},
    "PR": {"N", "L", "H"},
    "UI": {"N", "P", "A"},
    "VC": {"H", "L", "N"},
    "VI": {"H", "L", "N"},
    "VA": {"H", "L", "N"},
    "SC": {"H", "L", "N"},
    "SI": {"S", "H", "L", "N"},
    "SA": {"S", "H", "L", "N"},
    "E": {"X", "A", "P", "U"},
    "CR": {"X", "H", "M", "L"},
    "IR": {"X", "H", "M", "L"},
    "AR": {"X", "H", "M", "L"},
    "MAV": {"X", "N", "A", "L", "P"},
    "MAC": {"X", "L", "H"},
    "MAT": {"X", "N", "P"},
    "MPR": {"X", "N", "L", "H"},
    "MUI": {"X", "N", "P", "A"},
    "MVC": {"X", "H", "L", "N"},
    "MVI": {"X", "H", "L", "N"},
    "MVA": {"X", "H", "L", "N"},
    "MSC": {"X", "H", "L", "N"},
    "MSI": {"X", "S", "H", "L", "N"},
    "MSA": {"X", "S", "H", "L", "N"},
}

_AV = {"N": 0.0, "A": 0.1, "L": 0.2, "P": 0.3}
_PR = {"N": 0.0, "L": 0.1, "H": 0.2}
_UI = {"N": 0.0, "P": 0.1, "A": 0.2}
_AC = {"L": 0.0, "H": 0.1}
_AT = {"N": 0.0, "P": 0.1}
_IMPACT = {"H": 0.0, "L": 0.1, "N": 0.2}
_SUBSEQUENT = {"H": 0.1, "L": 0.2, "N": 0.3, "S": 0.0}
_REQUIREMENT = {"H": 0.0, "M": 0.1, "L": 0.2}


def _lookup_score(key):
    if key not in _LOOKUP:
        return float("nan")
    return float(_LOOKUP[key])


def _parse(vector):
    if not isinstance(vector, str) or not vector.startswith("CVSS:4.0/"):
        return None
    selected = {metric: "X" for metric in _OPTIONAL}
    seen = set()
    for part in vector.split("/")[1:]:
        if ":" not in part:
            return None
        metric, raw = part.split(":", 1)
        if metric in _SUPPLEMENTAL:
            continue
        if metric not in _ALLOWED or raw not in _ALLOWED[metric]:
            return None
        if metric in seen:
            return None
        seen.add(metric)
        selected[metric] = raw
    if any(metric not in seen for metric in _BASE):
        return None
    return selected


def _metric(selected, metric):
    if metric == "E" and selected.get(metric) == "X":
        return "A"
    if metric in {"CR", "IR", "AR"} and selected.get(metric) == "X":
        return "H"
    modified = "M" + metric
    if modified in selected and selected[modified] != "X":
        return selected[modified]
    return selected[metric]


def _macro_vector(selected):
    av = _metric(selected, "AV")
    pr = _metric(selected, "PR")
    ui = _metric(selected, "UI")
    if av == "N" and pr == "N" and ui == "N":
        eq1 = "0"
    elif (av == "N" or pr == "N" or ui == "N") and av != "P":
        eq1 = "1"
    elif av == "P" or not (av == "N" or pr == "N" or ui == "N"):
        eq1 = "2"
    else:
        return None

    ac = _metric(selected, "AC")
    at = _metric(selected, "AT")
    eq2 = "0" if ac == "L" and at == "N" else "1"

    vc = _metric(selected, "VC")
    vi = _metric(selected, "VI")
    va = _metric(selected, "VA")
    if vc == "H" and vi == "H":
        eq3 = "0"
    elif vc == "H" or vi == "H" or va == "H":
        eq3 = "1"
    else:
        eq3 = "2"

    msi = selected.get("MSI", "X")
    msa = selected.get("MSA", "X")
    sc = _metric(selected, "SC")
    si = _metric(selected, "SI")
    sa = _metric(selected, "SA")
    if msi == "S" or msa == "S":
        eq4 = "0"
    elif sc == "H" or si == "H" or sa == "H":
        eq4 = "1"
    else:
        eq4 = "2"

    exploit = _metric(selected, "E")
    eq5 = {"A": "0", "P": "1", "U": "2"}.get(exploit)
    if eq5 is None:
        return None

    cr = _metric(selected, "CR")
    ir = _metric(selected, "IR")
    ar = _metric(selected, "AR")
    if (
        (cr == "H" and vc == "H")
        or (ir == "H" and vi == "H")
        or (ar == "H" and va == "H")
    ):
        eq6 = "0"
    else:
        eq6 = "1"
    return eq1 + eq2 + eq3 + eq4 + eq5 + eq6


def _eq_maxes(macro, eq):
    return _MAX_COMPOSED[f"eq{eq}"][macro[eq - 1]]


def _extract(metric, text):
    start = text.find(metric + ":")
    if start < 0:
        return None
    extracted = text[start + len(metric) + 1 :]
    slash = extracted.find("/")
    return extracted if slash < 0 else extracted[:slash]


def _distance(levels, selected, metric, maximum):
    found = _extract(metric, maximum)
    if found not in levels or selected not in levels:
        return None
    return levels[selected] - levels[found]


def cvss_v4_score(vector):
    """Return the CVSS v4.0 score, or None when the vector cannot be scored."""
    selected = _parse(vector)
    if selected is None:
        return None
    macro = _macro_vector(selected)
    if macro is None or macro not in _LOOKUP:
        return None
    if all(
        _metric(selected, metric) == "N"
        for metric in ("VC", "VI", "VA", "SC", "SI", "SA")
    ):
        return 0.0

    def lower(key):
        return _lookup_score(key)

    eq = [int(part) for part in macro]
    value = float(_LOOKUP[macro])
    eq1_next = lower(f"{eq[0] + 1}{eq[1]}{eq[2]}{eq[3]}{eq[4]}{eq[5]}")
    eq2_next = lower(f"{eq[0]}{eq[1] + 1}{eq[2]}{eq[3]}{eq[4]}{eq[5]}")
    if eq[2] == 0 and eq[5] == 0:
        left = lower(f"{eq[0]}{eq[1]}{eq[2]}{eq[3]}{eq[4]}{eq[5] + 1}")
        right = lower(f"{eq[0]}{eq[1]}{eq[2] + 1}{eq[3]}{eq[4]}{eq[5]}")
        eq36_next = max(right, left)
    elif eq[2] == 1 and eq[5] == 0:
        eq36_next = lower(f"{eq[0]}{eq[1]}{eq[2]}{eq[3]}{eq[4]}{eq[5] + 1}")
    elif (eq[2] == 0 and eq[5] == 1) or (eq[2] == 1 and eq[5] == 1):
        eq36_next = lower(f"{eq[0]}{eq[1]}{eq[2] + 1}{eq[3]}{eq[4]}{eq[5]}")
    else:
        eq36_next = lower(f"{eq[0]}{eq[1]}{eq[2] + 1}{eq[3]}{eq[4]}{eq[5] + 1}")
    eq4_next = lower(f"{eq[0]}{eq[1]}{eq[2]}{eq[3] + 1}{eq[4]}{eq[5]}")
    eq5_next = lower(f"{eq[0]}{eq[1]}{eq[2]}{eq[3]}{eq[4] + 1}{eq[5]}")

    try:
        eq1_maxes = _eq_maxes(macro, 1)
        eq2_maxes = _eq_maxes(macro, 2)
        eq36_maxes = _eq_maxes(macro, 3)[macro[5]]
        eq4_maxes = _eq_maxes(macro, 4)
        eq5_maxes = _eq_maxes(macro, 5)
    except KeyError:
        return None

    distances = None
    for part1 in eq1_maxes:
        for part2 in eq2_maxes:
            for part36 in eq36_maxes:
                for part4 in eq4_maxes:
                    for part5 in eq5_maxes:
                        maximum = part1 + part2 + part36 + part4 + part5
                        pieces = [
                            _distance(_AV, _metric(selected, "AV"), "AV", maximum),
                            _distance(_PR, _metric(selected, "PR"), "PR", maximum),
                            _distance(_UI, _metric(selected, "UI"), "UI", maximum),
                            _distance(_AC, _metric(selected, "AC"), "AC", maximum),
                            _distance(_AT, _metric(selected, "AT"), "AT", maximum),
                            _distance(_IMPACT, _metric(selected, "VC"), "VC", maximum),
                            _distance(_IMPACT, _metric(selected, "VI"), "VI", maximum),
                            _distance(_IMPACT, _metric(selected, "VA"), "VA", maximum),
                            _distance(
                                _SUBSEQUENT, _metric(selected, "SC"), "SC", maximum
                            ),
                            _distance(
                                _SUBSEQUENT, _metric(selected, "SI"), "SI", maximum
                            ),
                            _distance(
                                _SUBSEQUENT, _metric(selected, "SA"), "SA", maximum
                            ),
                            _distance(
                                _REQUIREMENT, _metric(selected, "CR"), "CR", maximum
                            ),
                            _distance(
                                _REQUIREMENT, _metric(selected, "IR"), "IR", maximum
                            ),
                            _distance(
                                _REQUIREMENT, _metric(selected, "AR"), "AR", maximum
                            ),
                        ]
                        if any(piece is None for piece in pieces):
                            return None
                        distances = pieces
                        if any(piece < 0 for piece in pieces):
                            continue
                        break
                    else:
                        continue
                    break
                else:
                    continue
                break
            else:
                continue
            break
        else:
            continue
        break
    if distances is None:
        return None

    (
        av_d,
        pr_d,
        ui_d,
        ac_d,
        at_d,
        vc_d,
        vi_d,
        va_d,
        sc_d,
        si_d,
        sa_d,
        cr_d,
        ir_d,
        ar_d,
    ) = distances
    current = [
        av_d + pr_d + ui_d,
        ac_d + at_d,
        vc_d + vi_d + va_d + cr_d + ir_d + ar_d,
        sc_d + si_d + sa_d,
        0,
    ]
    available = [
        value - eq1_next,
        value - eq2_next,
        value - eq36_next,
        value - eq4_next,
        value - eq5_next,
    ]
    try:
        depths = [
            _MAX_SEVERITY["eq1"][str(eq[0])] * 0.1,
            _MAX_SEVERITY["eq2"][str(eq[1])] * 0.1,
            _MAX_SEVERITY["eq3eq6"][str(eq[2])][str(eq[5])] * 0.1,
            _MAX_SEVERITY["eq4"][str(eq[3])] * 0.1,
            _MAX_SEVERITY["eq5"][str(eq[4])] * 0.1,
        ]
    except KeyError:
        return None
    total = 0.0
    count = 0
    for distance, depth, gap in zip(current, depths, available, strict=True):
        if math.isnan(gap):
            continue
        if depth == 0:
            return None
        total += gap * (distance / depth)
        count += 1
    mean = 0.0 if count == 0 else total / count
    score = value - mean
    if score < 0:
        score = 0.0
    if score > 10:
        score = 10.0
    return round(score * 10) / 10
