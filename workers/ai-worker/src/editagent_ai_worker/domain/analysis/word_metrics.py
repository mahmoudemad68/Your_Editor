"""Registry caption_wer normalization and deterministic token Levenshtein alignment."""

from __future__ import annotations

import unicodedata


def normalize(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text).casefold()
    result = []
    for char in text:
        if "\u064b" <= char <= "\u065f" or char in {"\u0670", "\u0640"}:
            continue
        category = unicodedata.category(char)
        if category.startswith("P"):
            result.append(" ")
        elif category == "Nd":
            result.append(str(unicodedata.decimal(char)))
        else:
            result.append(char)
    return "".join(result).split()


def word_error(reference: str, hypothesis: str) -> dict[str, int | float | str | None]:
    gold, predicted = normalize(reference), normalize(hypothesis)
    # Bounded evaluation corpus, not an unbounded public text service.
    if len(gold) > 10000 or len(predicted) > 10000:
        raise ValueError("WER corpus exceeds the evaluation bound")
    previous = [(i, 0, 0, i) for i in range(len(predicted) + 1)]
    for index, word in enumerate(gold, 1):
        row = [(index, 0, index, 0)]
        for j, other in enumerate(predicted, 1):
            cost, s, d, i = previous[j - 1]
            diagonal = (cost + (word != other), s + (word != other), d, i)
            cost, s, d, i = previous[j]
            delete = (cost + 1, s, d + 1, i)
            cost, s, d, i = row[j - 1]
            insert = (cost + 1, s, d, i + 1)
            row.append(min((diagonal, delete, insert), key=lambda v: v[0]))
        previous = row
    errors, s, d, i = previous[-1]
    return {
        "substitutions": s,
        "deletions": d,
        "insertions": i,
        "referenceWords": len(gold),
        "wer": errors / len(gold) if gold else None,
        "unicodeVersion": unicodedata.unidata_version,
    }
