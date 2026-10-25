"""PR #84 independent QA, T01: does the byte estimate (UTF-8 bytes + 256) ever undercount real tokenizers?
Proxy tokenizers only (tiktoken gpt2 / cl100k_base / o200k_base): the planned provider tokenizer is unknown and
must still be validated before US-301/US-305. Synthetic samples only. QA-authored."""
import json
import os
import sys
from pathlib import Path

out = Path(os.environ["QA_OUT"])
samples = sorted((out / "tok-samples").glob("*.txt"))
result = {"id": "T01", "title": "Byte-based token estimate vs independent tokenizers (proxies) on 60-minute contexts and adversarial Unicode",
          "expected": "estimate (bytes+256) >= token count for every sample and tokenizer; ratios recorded", "mode": "tokenizer-proxy"}
try:
    import tiktoken
    rows, under = [], []
    for enc_name in ("gpt2", "cl100k_base", "o200k_base"):
        enc = tiktoken.get_encoding(enc_name)
        for f in samples:
            text = f.read_text(encoding="utf-8")
            tokens = len(enc.encode(text, disallowed_special=()))
            estimate = len(text.encode("utf-8")) + 256
            rows.append({"enc": enc_name, "sample": f.stem, "bytes": estimate - 256, "tokens": tokens, "tokensPerByte": round(tokens / max(1, estimate - 256), 3)})
            if tokens > estimate:
                under.append(f"{enc_name}:{f.stem}")
    worst = max(rows, key=lambda r: r["tokensPerByte"]) if rows else None
    result.update(status="PASS" if samples and not under else "FAIL", actual={"samples": len(samples), "undercounts": under, "worstTokensPerByte": worst, "rows": rows})
except Exception as exc:  # noqa: BLE001
    result.update(status="ERROR", actual=f"{type(exc).__name__}: {exc}"[:400])
path = out / "qa84-results.json"
doc = json.loads(path.read_text()) if path.exists() else {"results": []}
doc["results"].append({**result, "ms": 0})
path.write_text(json.dumps(doc, indent=2))
print(f"[QA84] T01 {result['status']}")
sys.exit(0)
