#!/usr/bin/env bash
# Diagnostic de l'installation OpenCode (config, agents, MCP, outils, modèles).
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/doctor.mjs" "$@"
