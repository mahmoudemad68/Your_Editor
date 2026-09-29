from editagent_ai_worker.composition.bootstrap import bootstrap


def main() -> None:
    status = bootstrap()
    print(status["status"])


if __name__ == "__main__":
    main()
