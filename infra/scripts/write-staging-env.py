#!/usr/bin/env python3
"""Write a staging env file that the shell can source without executing values."""

import os
import shlex
import stat
import sys


def quote_assignment(name, value):
    if "\n" in value or "\r" in value or "\0" in value:
        raise SystemExit(
            f"{name} contains a newline or NUL and cannot be stored safely."
        )
    if not name or not name.replace("_", "").isalnum() or name[0].isdigit():
        raise SystemExit(f"{name} is not a safe environment variable name.")
    return f"{name}={shlex.quote(value)}"


def main(path, names):
    lines = []
    for name in names:
        if name not in os.environ:
            raise SystemExit(f"missing {name}")
        lines.append(quote_assignment(name, os.environ[name]))
    text = "\n".join(lines) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(descriptor, text.encode())
    finally:
        os.close(descriptor)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: write-staging-env.py <path> <NAME>...")
    main(sys.argv[1], sys.argv[2:])
