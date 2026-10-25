"""QA-authored stalled SSE client (PR #77): tiny receive window, connects directly to the API container
(bypassing the Docker userland proxy's buffering) and does not read until the hold expires.
Prints one JSON line: bytes later readable, whether the server reset the connection, and timing."""
import json
import socket
import sys
import time

host, port, path, cookie, rcvbuf, hold = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5]), float(sys.argv[6])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
start = time.monotonic()
s.connect((host, port))
req = (f"GET {path} HTTP/1.1\r\nHost: localhost:3001\r\nAccept: text/event-stream\r\nOrigin: http://localhost:3000\r\n"
       f"Cookie: {cookie}\r\nConnection: keep-alive\r\n\r\n")
s.sendall(req.encode())
time.sleep(hold)  # stalled consumer: never reads, so the advertised window closes
got, reset, eof, status = 0, False, False, None
s.settimeout(3)
head = b""
try:
    while True:
        chunk = s.recv(65536)
        if not chunk:
            eof = True
            break
        if status is None:
            head += chunk
            if b"\r\n" in head:
                status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        got += len(chunk)
except ConnectionResetError:
    reset = True
except socket.timeout:
    pass
print(json.dumps({"status": status, "bytesReadableAfterHold": got, "serverReset": reset, "eof": eof,
                  "effectiveRcvbuf": s.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF), "seconds": round(time.monotonic() - start, 2)}))
