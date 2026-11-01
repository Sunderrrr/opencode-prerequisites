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

- `config/opencode.jsonc` : modèles Go par rôle, permissions, MCP (context7 actif, playwright désactivé), formatage auto.
- `config/AGENTS.md` : règles globales (plan d'abord, boucle d'apprentissage, alignement avant de coder, quota).
- `config/agents/` : `review`, `researcher`, `debugger`, `code-simplifier`, `verify-app`.
- `config/skills/` : `git-commit`, `project-onboarding`, `safe-refactor`, `grill-me`, `tdd`, `handoff`.
- `config/commands/` : `/check`, `/plan-first`, `/simplify`, `/verify`, `/learn`, `/ship`.
- `config/plugins/notify.js` : notification quand une session attend (non testé).

## Sources d'inspiration

Boris Cherny (workflow Claude Code), [mattpocock/skills](https://github.com/mattpocock/skills), docs OpenCode.

Aucune clé API dans ce dépôt : `export CONTEXT7_API_KEY=...` (optionnel).
