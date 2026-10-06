# US-127 hostile media validation

Uploads publish `media.inspect` through the existing durable outbox/US-129 queue.
Its supervised handler resolves only the persisted asset ID, stages the object once,
re-verifies its SHA-256, validates its bytes, probes metadata and performs a short
actual decode. Inspection completion alone does not confer trust.

`pending`, `validated` and `rejected` are durable, separate from inspection status.
A verdict binds source SHA-256, policy SHA-256 and audit time. Migration 0011 adds
shape/code constraints and a pending index. API reads expose a stable rejection code
and fixed safe message; command output, URLs and paths are never persisted.
Unknown/pending/rejected/stale-policy sources cannot enter `media.derive`, even for
reuse. `ALLOW_UNVALIDATED_DERIVATION=true` is a startup error. Operator derivation
remains explicit; there is no new automatic downstream scheduling or UI. Validation
and derivation share the existing advisory source lock/one connection. Concurrent
writes additionally use the inspection revision CAS. Revalidation repeats checks
and produces the same content/policy verdict. Old assets need revalidation.

## Byte and metadata policy

Filename and browser MIME do not select the parser. ISO-BMFF box magic selects MOV;
EBML plus DocType selects Matroska. Probed MP4/MOV/MKV/WebM container identity must
agree. MOV box walking is bounded by depth/count and rejects external `dref` entries.
HLS, ffconcat, XML/MPD and playlist signatures are rejected before probing. Renamed
valid supported bytes remain accepted. Renamed arbitrary bytes remain invalid.

Video allowlist: H.264, HEVC, VP9, AV1. Audio allowlist: AAC, Opus and PCM s16le,
s16be, s24le, s32le, f32le, u8. Other streams/codecs are rejected. Maximum 8 audio
channels and 8–192 kHz; no external-reference/playlist demuxers are enabled.
Stored dimensions and declared sample-aspect display width/pixels are checked.
Bitrate uses the maximum of reported stream/container bitrate and actual staged
bytes divided by duration. Invalid/non-finite/negative metadata fails closed.

| Variable (`MEDIA_VALIDATION_` prefix) | Default           | Allowed range        |
| ------------------------------------- | ----------------- | -------------------- |
| MAX_BYTES                             | 4294967296        | 1–4294967296         |
| MAX_DURATION_SECONDS                  | 1800              | 1–1800               |
| MAX_DIMENSION                         | 4096              | 2–8192               |
| MAX_PIXELS                            | 8847360           | 4–33177600           |
| MAX_STREAMS                           | 8                 | 1–32                 |
| MAX_BITRATE                           | 100000000 bits/s  | 1000–1000000000      |
| PROBE_TIMEOUT_MS                      | 15000             | 100–60000            |
| DECODE_TIMEOUT_MS                     | 15000             | 100–60000            |
| CPU_SECONDS                           | 10 per subprocess | 1–60                 |
| MEMORY_BYTES                          | 1073741824        | 134217728–2147483648 |
| DECODE_OUTPUT_BYTES                   | 16777216          | 1048576–67108864     |

Only positive decimal integers are accepted from the environment. Invalid values
fail startup; no variable disables validation/protocol restrictions. Product ceilings
4 GiB and 30 minutes cannot be increased. A policy signature includes every limit,
allowlist, decode setting and implementation version (`us127-v1`).

## Actual Linux sandbox

The native helper is built with GCC in the builder, not installed as root or setuid.
Production remains UID/GID 10001. It installs `no_new_privs`, seccomp user
notifications and hard `RLIMIT_AS`, `RLIMIT_FSIZE`, `RLIMIT_CORE=0`, `RLIMIT_NOFILE=64`
and `RLIMIT_CPU` (10 seconds soft / 11 hard by default). CPU accounting includes
threads; fork/process cloning is denied, thread cloning alone is permitted.

The parent brokers every open using kernel `SECCOMP_IOCTL_NOTIF_ADDFD`. It reads
child pathname memory through read-only `/proc/<pid>/mem`, checks the request ID,
and injects an independently opened descriptor. It never continues an open syscall,
avoiding pathname TOCTOU. Allowed files: exact pre-opened staged input, exact
pre-created output, ELF shared libraries under trusted `/usr/lib` or `/lib`, and
`/etc/ld.so.cache`. No directory, credentials, other upload or arbitrary local input
is readable. Initial exec is the single trusted pre-parser exec; later execs,
filesystem mutation, ptrace, io_uring, mount/unshare and network sockets are denied.
No credentials are passed in the subprocess environment. A parent-death signal kills
FFmpeg if the broker dies. Cancellation/wall timeout terminates and reaps the child;
US-129 retains its process-group hard-kill backstop. Broker setup failure is a
retryable infrastructure error, not a media rejection. Startup runs an actual
read-allowed/read-denied/socket-denied capability test; unsupported kernels fail
closed. Requires Linux seccomp USER_NOTIF/ADDFD, accessible child `/proc` memory,
and kernel resource-limit support. There is no unsandboxed fallback.

Both probe and decode force the byte-selected demuxer, `-protocol_whitelist file`,
`-format_whitelist mov|matroska`, MOV external-data references disabled, max allocation
64 MiB, probe size 5 MiB, analysis 5 seconds, 2 codec threads/CPU-count sizing. The subprocess glibc allocator uses at most 2 arenas to keep host multi-stream fixtures within the same address-space bound. Probe output is capped
at 1 MiB. Metadata limits precede short decode. Decode samples up to 1 second/30
frames into a bounded 320×180 MP4 with existing H.264/AAC codecs. This is a short
validation sample, not a promise that every frame is uncorrupted or codec software
has no vulnerabilities. Accepted source processing retains existing US-128 bounded
execution; proxy/poster/sprite algorithms and parameter signatures are unchanged.

## Evidence and operations

`media-validation.test.ts` covers supported/disguised containers, empty/truncated/
non-media bytes, unsupported codecs, 8192-pixel headers, sparse >30-minute timeline,
9 streams, byte/bitrate limits, malformed metadata, HLS/HTTPS/concat/MOV references,
active cancellation and real CPU/address-space limits. A reachable HTTP canary is
positively checked then reset; hostile validation must produce zero requests.
`media-validation.integration.test.ts` uses real PostgreSQL/Redis/BullMQ/SeaweedFS
and the actual supervised handler. Validated input produces 5 private derivatives;
rejected inputs persist deterministic reasons, terminal permanent jobs, no retry
storm and zero derivatives. Revalidation is tested. Fixture generation/independent
inspection may use host FFmpeg; production validation/derivation is additionally
run with pinned 7.1.5-editagent1 binaries. No demuxer/protocol/codec additions.

Apply migration before starting workers/API. Keep the bucket private. Re-enqueue
inspection for historical assets before derivation. Provision private scratch space
for staged source plus bounded decode output. Retain existing upload cleanup and
scratch cleanup after confirmed worker death. No staging/production deployment is
part of this story. Existing US-119 and supply-chain debt remains unchanged.
