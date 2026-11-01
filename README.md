# opencode-prerequisites

Mon kit d'init pour [OpenCode](https://opencode.ai) avec l'abonnement **OpenCode Go** : `AGENTS.md` global, agents, skills, commandes, MCP et notifications.

## Installation

```bash
git clone https://github.com/Sunderrrr/opencode-prerequisites.git
cd opencode-prerequisites
./install.sh              # copie dans ~/.config/opencode (sauvegarde l'existant)
./install.sh --with-matt  # + skills complets de Matt Pocock (non testé)
```

Puis dans OpenCode : `/connect` → OpenCode Go → colle ta clé, et `/models` pour vérifier que les IDs de `config/opencode.jsonc` existent encore.

## Contenu

- `config/opencode.jsonc` : modèles Go par rôle, permissions, formatage auto et MCP : **context7** (actif), **playwright** (Microsoft, désactivé) et **obscura** (désactivé).
- `config/AGENTS.md` : règles globales (plan d'abord, boucle d'apprentissage, alignement avant de coder, quota).
- `config/agents/` : `review`, `researcher`, `debugger`, `code-simplifier`, `verify-app`.
- `config/skills/` : `git-commit`, `project-onboarding`, `safe-refactor`, `grill-me`, `tdd`, `handoff`.
- `config/commands/` : `/check`, `/plan-first`, `/simplify`, `/verify`, `/learn`, `/ship`.
- `config/plugins/notify.js` : notification quand une session attend (non testé).

## Sources d'inspiration

Boris Cherny (workflow Claude Code), [mattpocock/skills](https://github.com/mattpocock/skills), docs OpenCode.

Aucune clé API dans ce dépôt : `export CONTEXT7_API_KEY=...` (optionnel).

## Navigateurs MCP (playwright / obscura)

Les deux sont désactivés par défaut car chaque MCP ajoute du contexte. Dans `~/.config/opencode/opencode.jsonc`, mets `"enabled": true` sur **un seul** des deux.

- **playwright** : rien à installer (`npx`), nécessite Node.js. Navigateurs : `npx playwright install chromium`.
- **obscura** : télécharge le binaire (`obscura` + `obscura-worker`, dans le même dossier) depuis les [releases](https://github.com/h4ckf0r0day/obscura/releases), mets-le dans ton `PATH`, puis vérifie `obscura mcp`. Doc MCP : [wiki](https://github.com/h4ckf0r0day/obscura/wiki/Use-the-MCP-server).
