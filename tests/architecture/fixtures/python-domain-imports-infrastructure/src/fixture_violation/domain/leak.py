from fixture_violation.infrastructure.store import marker


def leak() -> str:
    return marker
