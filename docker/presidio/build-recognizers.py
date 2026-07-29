"""Merge our extra recognizers into Presidio's own default registry.

Run at image build time. Supplying RECOGNIZER_REGISTRY_CONF_FILE replaces the
registry wholesale, so rather than vendoring a copy of default_recognizers.yaml
(which would silently drift from the base image, potentially dropping built-in
recognizers such as NhsRecognizer) we read the image's own defaults and append
to them.

Also flips on the built-in UK recognizers this deployment wants, which ship
disabled.
"""

import sys

import yaml

DEFAULTS = "/app/presidio_analyzer/conf/default_recognizers.yaml"
EXTRA = "/tmp/uk-postcode-recognizer.yaml"
OUT = "/conf/recognizers.yaml"

# Built-in recognizers that ship `enabled: false` but are wanted here.
ENABLE = {"UkNinoRecognizer"}

with open(DEFAULTS, encoding="utf-8") as fh:
    registry = yaml.safe_load(fh)
with open(EXTRA, encoding="utf-8") as fh:
    extra = yaml.safe_load(fh)

recognizers = registry.get("recognizers")
if not recognizers:
    sys.exit(f"no recognizers found in {DEFAULTS} - base image layout changed")

for entry in recognizers:
    if entry.get("name") in ENABLE:
        entry["enabled"] = True

before = len(recognizers)
recognizers.extend(extra["recognizers"])

with open(OUT, "w", encoding="utf-8") as fh:
    yaml.safe_dump(registry, fh, sort_keys=False, allow_unicode=True)

added = [r["name"] for r in extra["recognizers"]]
print(f"[build-recognizers] {before} built-in recognizers + {len(added)} custom: {', '.join(added)}")
print(f"[build-recognizers] enabled: {', '.join(sorted(ENABLE))}")
print(f"[build-recognizers] wrote {OUT}")
