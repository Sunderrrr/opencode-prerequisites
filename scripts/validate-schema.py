#!/usr/bin/env python3
"""Validate config/opencode.jsonc (and the generated lite profile) against the official OpenCode JSON schema.
Usage: python3 scripts/validate-schema.py   (requires: pip install jsonschema; network)"""

import json, re, subprocess, sys, tempfile, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA_URL = "https://opencode.ai/config.json"


def to_json(path):
    # Reuse the kit's JSONC reader (Node) so the logic is not duplicated
    code = (
        "import('%s').then(m=>console.log(JSON.stringify(m.parseJsonc(require('fs').readFileSync(process.argv[1],'utf8')))))"
        % (ROOT / "scripts/lib/jsonc.mjs")
    )
    out = subprocess.run(
        ["node", "-e", code, str(path)], capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


try:
    from jsonschema import Draft202012Validator, Draft7Validator
except ImportError:
    sys.exit("pip install jsonschema")

req = urllib.request.Request(
    SCHEMA_URL, headers={"User-Agent": "opencode-prerequisites-ci"}
)
schema = json.load(urllib.request.urlopen(req, timeout=20))
V = Draft202012Validator if "2020-12" in schema.get("$schema", "") else Draft7Validator

targets = [("config/opencode.jsonc", ROOT / "config/opencode.jsonc")]
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(["cp", "-a", str(ROOT / "config") + "/.", tmp], check=True)
    subprocess.run(
        ["node", str(ROOT / "scripts/make-lite.mjs"), tmp],
        check=True,
        capture_output=True,
    )
    targets.append(("lite profile", pathlib.Path(tmp) / "opencode.jsonc"))
    bad = 0
    for name, path in targets:
        errors = sorted(
            V(schema).iter_errors(to_json(path)), key=lambda e: list(map(str, e.path))
        )
        if errors:
            bad += len(errors)
            for e in errors[:20]:
                print(
                    f"❌ {name}: {'/'.join(map(str, e.path)) or '(root)'} → {e.message[:200]}"
                )
        else:
            print(f"✅ {name}: conforms to the official schema")
sys.exit(1 if bad else 0)
