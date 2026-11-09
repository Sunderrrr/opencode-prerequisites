#!/usr/bin/env bash
# OpenCode installation diagnostic (config, agents, MCP, tools, models).
# --offline (or OC_DOCTOR_OFFLINE=1): no network requests. Exit code: 0 = healthy, 1 = error.
# --fix: after the diagnosis, apply safe reversible fixes (re-enable MCPs whose prerequisite is
#        back, tighten config permissions). --fix --dry-run: report only, write nothing.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/doctor.mjs" "$@"
