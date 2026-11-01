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

- `config/opencode.jsonc` : modèle unique DeepSeek V4.1 Flash, permissions, formatage auto et MCP : **context7** (actif), **playwright** (Microsoft, désactivé) et **obscura** (désactivé).
- `config/AGENTS.md` : règles globales (plan d'abord, boucle d'apprentissage, alignement avant de coder, quota).
- `config/agents/` : **`ceo`** (agent par défaut, délègue), spécialistes par langage/outil (`rust` par défaut, `python`, `typescript`, `go`, `shell`, `docker`, `ansible`, `terraform`, `kubernetes`) et par domaine `architect`, `backend`, `frontend`, `database`, `devops`, `security`, `qa`, `docs`, et `review`, `researcher`, `debugger`, `code-simplifier`, `verify-app`.
- `config/skills/` : `git-commit`, `project-onboarding`, `safe-refactor`, `grill-me`, `tdd`, `handoff`.
- `config/commands/` : `/check`, `/plan-first`, `/simplify`, `/verify`, `/learn`, `/ship`.
- `config/mempalace.jsonc` : réglages de la mémoire persistante (plugin `@rvboris/opencode-mempalace`).
- `config/plugins/notify.js` : notification quand une session attend (non testé).
- `config/plugins/guard.js` : bloque la lecture des fichiers de secrets (`.env`, clés) et les commandes destructrices (`rm -rf /`, `push --force`, `DROP TABLE`, `curl | sh`).
- `config/plugins/auto-compact.js` : compactage automatique à 90 % du contexte (non testé, ratio réglable avec `OPENCODE_COMPACT_RATIO`).

## Sources d'inspiration

Boris Cherny (workflow Claude Code), [mattpocock/skills](https://github.com/mattpocock/skills), docs OpenCode.

Aucune clé API dans ce dépôt : `export CONTEXT7_API_KEY=...` (optionnel).

## Navigateurs MCP (playwright / obscura)

`install.sh` les installe et les active obligatoirement (il s'arrête si Node.js manque ou si le téléchargement échoue) :

- **context7** : documentation à jour des librairies.
- **playwright** (Microsoft) : `npx playwright install chromium`, nécessite Node.js.
- **obscura** : télécharge `obscura` + `obscura-worker` depuis les [releases](https://github.com/h4ckf0r0day/obscura/releases) dans `~/.local/bin` (change avec `OBSCURA_BIN_DIR`). Assure-toi que ce dossier est dans ton `PATH`. Doc MCP : [wiki](https://github.com/h4ckf0r0day/obscura/wiki/Use-the-MCP-server).

Chaque MCP ajoute du contexte : si ton quota Go fond trop vite, passe `"enabled": false` sur celui que tu n'utilises pas.

## Mémoire (MemPalace)

`install.sh` fait `pip install --user mempalace` et `mempalace init ~/.mempalace/palace`, et la config charge le plugin [`@rvboris/opencode-mempalace`](https://github.com/rvboris/opencode-mempalace) (licence MIT, tout reste en local). Il demande Python 3.10+ et, d'après sa doc, OpenCode v2. Les réglages sont dans `~/.config/opencode/mempalace.jsonc` ; garde `privacyRedactionEnabled` à `true`.

Supermemory n'est pas inclus : il exige un compte et une clé API (`SUPERMEMORY_API_KEY`).

## Équipe d'agents (CEO)

`ceo` reçoit ta demande, la cadre (`grill-me`, `@architect`), délègue aux spécialistes puis contrôle (`@review`, `@verify-app`, `@security` si sensible). Ajoute un spécialiste en créant `config/agents/<nom>.md` avec `mode: subagent`. Change d'agent avec Tab dans OpenCode. Les spécialistes tournent en profondeur 1 (`subagent_depth`), donc pas de cascade qui brûle le quota.

## Modèle

Tout tourne sur `opencode-go/deepseek-v4.1-flash`. Prérequis côté console OpenCode : *Settings › Privacy › Regions › Global* (obligatoire pour les modèles DeepSeek, réglable par un owner/admin). Vérifie l'ID avec `/models`.

### D'où viennent ces conventions

Inspiré de [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (rôle, étapes « quand appelé », checklists, rapport final), de la [doc des sous-agents de Claude Code](https://code.claude.com/docs/en/sub-agents) (descriptions courtes avec « utiliser proactivement », prompt autonome, outils restreints, règles dures par hooks) et du schéma d'oh-my-opencode (orchestrateur + assistants en lecture seule qui ne délèguent pas).
