#!/usr/bin/env bash
# OpenCode installation diagnostic (config, agents, MCP, tools, models).
# --offline (or OC_DOCTOR_OFFLINE=1): no network requests. Exit code: 0 = healthy, 1 = error.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/doctor.mjs" "$@"
