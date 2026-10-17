import pytest

from editagent_ai_worker.domain.analysis.word_metrics import normalize, word_error


def test_registry_normalization_preserves_arabic_letters_and_maps_digits() -> None:
    assert normalize("مَرْحَبًا، ١٢! أ إ ا ى ي ة ه ـ") == [
        "مرحبا",
        "12",
        "أ",
        "إ",
        "ا",
        "ى",
        "ي",
        "ة",
        "ه",
    ]
    assert normalize("Hello, WORLD!") == ["hello", "world"]


@pytest.mark.parametrize(
    "gold,pred,s,d,i,wer",
    [
        ("one two", "one two", 0, 0, 0, 0),
        ("one two", "one three", 1, 0, 0, 0.5),
        ("one two", "one", 0, 1, 0, 0.5),
        ("one", "one two", 0, 0, 1, 1),
        ("", "", 0, 0, 0, None),
        ("", "one", 0, 0, 1, None),
    ],
)
def test_independent_metric_cases(
    gold: str, pred: str, s: int, d: int, i: int, wer: float | None
) -> None:
    result = word_error(gold, pred)
    assert (result["substitutions"], result["deletions"], result["insertions"], result["wer"]) == (
        s,
        d,
        i,
        wer,
    )
