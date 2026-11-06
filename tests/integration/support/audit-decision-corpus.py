"""Synthetic QA reference methodology, seed 106103; never evaluation gold.

The fixed decision digest is generated from immutable pre-diagnostic b9484e0,
not from the implementation under test. Only rejection/counters are compared;
E1 intentionally replaces unsafe exception strings with fixed categories.
In-memory files permit identical adversarial names on Windows and Linux. Real
filesystem, ZIP and CLI errors are independently tested in the calling suite.
"""

import base64
import hashlib
import io
import json
import random
import struct
import zipfile
import zlib
from pathlib import PurePosixPath


def png(comment, kind=b"tEXt", crc_ok=True, end=True, trailing=b""):
    def chunk(k, v, good=True):
        c = zlib.crc32(k + v) & 0xFFFFFFFF
        return (
            struct.pack(">I", len(v)) + k + v + struct.pack(">I", c if good else c ^ 1)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(kind, b"Comment\0note " + comment, crc_ok)
        + chunk(b"IDAT", zlib.compress(b"\0\0\0\0"))
        + (chunk(b"IEND", b"") if end else b"")
        + trailing
    )


def zbytes(items, method=zipfile.ZIP_DEFLATED):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", method) as z:
        for n, v in items:
            z.writestr(n, v)
    return b.getvalue()


U, P, H, D = "QAUSERCANARY", "QAPASSCANARY", "qahostcanary.invalid", "QADIRCANARY"
URI = f"postgres://{U}:{P}@{H}/db"
UB = URI.encode()
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJRQSJ9.QASIGCANARY"
KNOWN = "qa-known-secret-canary-value"
CANARIES = [U, P, H, D, KNOWN, "QASIGCANARY", URI]


def b64(s):
    return base64.b64encode(s if isinstance(s, bytes) else s.encode()).decode()


def trace(**kw):
    return json.dumps(kw).encode()


def nest(n, inner, name="p.network"):
    z = zbytes([(name, inner)])
    for i in range(n - 1):
        z = zbytes([(f"{D}/l{i}.zip", z)])
    return z


REJECT = {
    "uri_plain": {"a.log": UB},
    "uri_mysql": {"a.log": f"mysql://{U}:{P}@{H}/x".encode()},
    "uri_user_only": {"a.log": f"https://{U}@{H}/".encode()},
    "uri_redis": {"a.log": f"redis://:{P}@{H}:6379/0".encode()},
    "uri_upper": {"a.log": f"POSTGRES://{U}:{P}@{H}/".encode()},
    "uri_pct_pass": {"a.log": f"postgres://{U}:a%2Fb%40{P}@{H}/".encode()},
    "uri_repeat": {"a.log": (URI + "\n").encode() * 5},
    "uri_same_line_twice": {"a.log": f"{URI} {URI}".encode()},
    "uri_two_values": {"a.log": f"{URI}\npostgres://other:{P}2@{H}/".encode()},
    "uri_in_json": {"a.json": trace(url=URI)},
    "uri_json_escaped": {
        "a.json": json.dumps({"u": URI}).replace("@", "\\u0040").encode()
    },
    "uri_nested_json": {"a.json": trace(v=json.dumps({"w": json.dumps({"x": URI})}))},
    "uri_json_body_b64": {"a.json": trace(body=b64(URI))},
    "uri_utf16le": {"a.log": URI.encode("utf-16-le")},
    "uri_utf16bom": {"a.log": URI.encode("utf-16")},
    "uri_utf16be": {"a.log": URI.encode("utf-16-be")},
    "uri_utf32": {"a.log": URI.encode("utf-32")},
    "uri_ansi": {"a.log": f"\x1b[31mpostgres://{U}\x1b[0m:{P}@{H}/".encode()},
    "uri_ctrl_split": {"a.log": f"post\x00gres://{U}:\x01{P}@{H}/".encode()},
    "uri_highbyte_split": {
        "a.bin": b"h\xfftt\xffps\xff://" + U.encode() + b"@" + H.encode()
    },
    "uri_png_text": {"a.png": png(UB)},
    "uri_png_ztxt_label": {"a.png": png(UB, kind=b"zTXt")},
    "uri_png_badcrc": {"a.png": png(UB, crc_ok=False)},
    "uri_png_noend": {"a.png": png(UB, end=False)},
    "uri_png_trailing": {"a.png": png(b"x", trailing=UB)},
    "uri_png_truncated": {"a.png": png(UB)[: 40 + len(UB)]},
    "uri_png_hugechunk": {"a.png": b"\x89PNG\r\n\x1a\n\xff\xff\xff\xfftEXt" + UB},
    "uri_png_spoof_ext": {"a.txt": png(UB)},
    "uri_jpeg_trailer": {"a.jpg": b"\xff\xd8\xff\xe0" + UB},
    "uri_mp4": {"a.mp4": b"\0\0\0\x18ftypisom" + UB},
    "uri_opaque": {"a.bin": bytes(range(1, 9)) + UB + bytes(range(128, 200))},
    "uri_zip_member": {"t.zip": zbytes([("r.network", UB)])},
    "uri_zip_stored": {"t.zip": zbytes([("r.network", UB)], zipfile.ZIP_STORED)},
    "uri_zip_name": {"t.zip": zbytes([(f"{D}/{URI}", b"x")])},
    "uri_zip_noext": {"t": zbytes([("r", UB)])},
    "uri_zip_utf16": {"trace.zip": zbytes([(f"{D}/p.network", URI.encode("utf-16"))])},
    "uri_zip_l2": {"t.zip": nest(2, UB)},
    "uri_zip_l3": {"t.zip": nest(3, UB)},
    "uri_zip_png": {"t.zip": zbytes([(f"{D}/s.png", png(UB))])},
    "uri_many_files": {
        f"{D}{i}/f{i}.log": (UB if i == 37 else b"clean\n") for i in range(60)
    },
    "pw_trace_network": {
        "trace.zip": zbytes(
            [
                (
                    "trace.network",
                    trace(
                        snapshot={
                            "request": {
                                "headers": [
                                    {"name": "Authorization", "value": f"Bearer {P}"}
                                ],
                                "url": URI,
                            }
                        }
                    ),
                )
            ]
        )
    },
    "pw_trace_fill": {
        "trace.zip": zbytes(
            [("trace.trace", trace(method="fill", params={"value": P}, password=P))]
        )
    },
    "pw_resource_body": {
        "t.zip": zbytes([("resources/ab.dat", trace(body=b64(f"token={P}")))])
    },
    "bearer": {"a.log": f"Authorization: Bearer {P}".encode()},
    "bearer_lower": {"a.log": f"bearer {P}".encode()},
    "bearer_marker_suffix": {"a.log": f"Bearer [REDACTED]{P}".encode()},
    "jwt": {"a.log": JWT.encode()},
    "jwt_zip": {"t.zip": zbytes([("x", JWT.encode())])},
    "pw_assign": {"a.log": f"password={P}".encode()},
    "token_assign": {"a.log": f"api_token: {P}".encode()},
    "secret_json": {"a.json": trace(client_secret=P)},
    "signature": {"a.log": f"X-Amz-Signature={P}".encode()},
    "cookie_pair": {"a.json": trace(name="cookie", value=P)},
    "apikey": {"a.log": f"api-key={P}".encode()},
    "assign_suffix": {"a.log": f"password=[REDACTED]{P}".encode()},
    "default_secret": {"a.log": b"editagent-dev-password"},
    "default_b64": {"a.log": b64("editagent-dev-secret").encode()},
    "default_pct": {"a.log": b"local-development-jwt-secret-32chars"},
    "known_raw": {"a.bin": b"\x00\xff" + KNOWN.encode()},
    "known_utf16": {"a.bin": KNOWN.encode("utf-16-le")},
    "known_b64": {"a.log": b64(KNOWN).encode()},
    "known_zip": {"t.zip": zbytes([("r", KNOWN.encode())])},
    "known_png": {"a.png": png(KNOWN.encode())},
    "service_log": {"services.log": UB},
    "svc_nested": {"negative/runtime/services.log": UB},
}
FAILCLOSED = {
    "zip_too_deep": {"t.zip": nest(5, UB)},
    "zip_not_zip": {"t.zip": b"not a zip"},
    "pk_prefix": {"t.bin": b"PKgarbage" + UB},
    "json_too_deep": {"a.json": ("[" * 64 + "1" + "]" * 64).encode()},
}
ACCEPT = {
    "empty": {"a.log": b""},
    "plain": {"a.log": b"status=200 hello\n"},
    "uri_no_user": {"a.log": b"https://example.invalid/path?x=1"},
    "uri_redacted": {"a.log": b"postgres://[REDACTED]@db:5432/x"},
    "uri_pct_redacted": {"a.log": b"postgres://%5BREDACTED%5D@db/"},
    "pw_redacted": {"a.log": b'password="[REDACTED]"'},
    "bearer_redacted": {"a.log": b"Bearer [REDACTED]"},
    "clean_png": {"a.png": png(b"clean note")},
    "clean_zip": {
        "t.zip": zbytes(
            [("resources/a.png", png(b"ok")), ("trace.network", trace(status=200))]
        )
    },
    "email_like": {"a.log": b"contact a@b.example no scheme"},
}

rng = None
ATOMS = [
    b"postgres://",
    b"http://",
    b"h\xfftt\xffps://",
    U.encode(),
    b":",
    P.encode(),
    b"@",
    H.encode(),
    b"/",
    b" ",
    b"\n",
    b"\r\n",
    b"\t",
    b"\x00",
    b"\xff",
    b"\x1b[31m",
    b"\x1b[0m",
    b"\x1b]0;t\x07",
    b"\x9b1m",
    b"{",
    b"}",
    b'"',
    b"'",
    b"[",
    b"]",
    b"\\",
    b"\\u0040",
    b"%40",
    b"%3A",
    b"+",
    b"=",
    b"&",
    b"[REDACTED]",
    b"password=",
    b"token:",
    b"Bearer ",
    b"PK",
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xfe",
    b"\xfe\xff",
    b"\xef\xbb\xbf",
    b'"body":"',
    b'"url":"',
    b"name",
    b"value",
    b"eyJhbGciOiJ.eyJz.abc",
    KNOWN.encode(),
    b"x" * 40,
    b"\xc3\xa9",
    b"\xd8\x00",
]


def blob():
    return b"".join(rng.choice(ATOMS) for _ in range(rng.randint(0, 40)))


def mk(depth=0):
    r = rng.random()
    if r < 0.45:
        return blob()
    if r < 0.6:
        v = blob()
        return png(
            v,
            kind=rng.choice([b"tEXt", b"iTXt", b"zTXt", b"IDAT", b"qaXt"]),
            crc_ok=rng.random() < 0.7,
            end=rng.random() < 0.7,
            trailing=blob() if rng.random() < 0.3 else b"",
        )
    if r < 0.67:
        v = png(blob())
        return v[: rng.randint(0, len(v))]
    if r < 0.75:
        v = bytearray(png(blob()))
        for _ in range(rng.randint(1, 6)):
            v[rng.randrange(len(v))] = rng.randrange(256)
        return bytes(v)
    if r < 0.85:
        return json.dumps(
            {
                "a": blob().decode("latin1"),
                "url": blob().decode("latin1"),
                "body": base64.b64encode(blob()).decode(),
            }
        ).encode()
    if depth < 3 and r < 0.95:
        return zbytes(
            [
                (
                    rng.choice(
                        [
                            "r",
                            "a/b.network",
                            "trace.zip",
                            f"{D}/{rng.randint(0, 9)}.json",
                            URI,
                            "..\\x",
                            "x" * 300,
                        ]
                    )
                    + str(i),
                    mk(depth + 1),
                )
                for i in range(rng.randint(0, 3))
            ],
            rng.choice([zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]),
        )
    if r < 0.975:
        return blob().decode("latin1").encode("utf-16")
    return bytes(rng.randrange(256) for _ in range(rng.randint(0, 300)))


def cases():
    global rng
    rng = random.Random(106103)
    for group in (REJECT, FAILCLOSED, ACCEPT):
        yield from group.items()
    for i in range(6000):
        yield (
            f"fuzz{i}",
            {
                f"{rng.choice([D, 'runtime', 'negative', 'healthy/resources'])}/{i}_{j}{rng.choice(['.log', '.png', '.zip', '.json', '.bin', '', '.network', '.trace', '.weird'])}": mk()
                for j in range(rng.randint(1, 4))
            },
        )


class MemoryFile:
    def __init__(self, name, raw):
        self.path, self.raw = PurePosixPath(name), raw
        self.name = self.path.name

    def __str__(self):
        return str(self.path)

    def relative_to(self, directory):
        return self.path

    def is_file(self):
        return True

    def read_bytes(self):
        return self.raw


class MemoryDirectory:
    def __init__(self, files):
        self.files = files

    def rglob(self, pattern):
        return (MemoryFile(name, raw) for name, raw in self.files.items())


class SyntheticSecrets:
    def exists(self):
        return True

    def read_text(self):
        return json.dumps([KNOWN])


def decision(module, tree):
    try:
        return ["accept", module.audit(MemoryDirectory(tree), SyntheticSecrets())]
    except ValueError as error:
        message = str(error)
        if message.startswith("Artifact credential audit failed: "):
            counters = json.loads(message.split(": ", 1)[1])
            counters.pop("first_uri_diagnostic", None)
            return ["reject", counters]
        return ["closed"]
    except Exception:  # noqa: BLE001 -- reference compares all fail-closed errors
        return ["closed"]


def decisions(module):
    digest = hashlib.sha256()
    totals = {"accept": 0, "reject": 0, "closed": 0}
    count = 0
    for name, tree in cases():
        result = decision(module, tree)
        totals[result[0]] += 1
        count += 1
        digest.update(
            json.dumps([name, result], sort_keys=True, separators=(",", ":")).encode()
            + b"\n"
        )
    return count, totals, digest.hexdigest()
