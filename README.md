# opencode-prerequisites

Mon kit d'init pour [OpenCode](https://opencode.ai) avec l'abonnement **OpenCode Go** : un CEO qui dirige 24 agents spécialisés, des skills, des commandes, des MCP, de la mémoire, une sécurité git multi-agents et un gabarit de projet Rust.

> ⚠️ Les agents sont en **mode débridé** (aucune demande de permission). Travaille dans un dépôt git propre et commité. Seuls les blocages de `config/plugins/guard/` restent.

## Installation

```bash
git clone https://github.com/Sunderrrr/opencode-prerequisites.git
cd opencode-prerequisites
./install.sh              # complet : config + Playwright, Obscura, Trivy, MemPalace
./install.sh --lite       # léger : 12 agents, MCP context7 + grep_app, aucun outil lourd
./install.sh --no-tools   # copie la config seulement
./install.sh --with-matt  # + skills complets de Matt Pocock (non testé)
./install.sh --android    # + module Android (option, mémorisé) : agents, MCP mobile, toolchain Podman
```

**Ne lance pas `install.sh` avec `sudo`** : tout serait installé dans `/root`. L'installateur refuse d'ailleurs de tourner via sudo. Il valide le kit avant de copier, sauvegarde l'existant dans `~/.config/opencode.bak-<date>`, et n'écrit aucune clé.

Ensuite : `opencode` → `/connect` → **OpenCode Go** → colle ta clé. Dans la console OpenCode : *Settings › Privacy › Regions › Global* (requis pour les modèles DeepSeek). Puis :

```bash
./doctor.sh      # diagnostic : config, agents, MCP, outils, modèles, lecture réelle par OpenCode
./uninstall.sh   # restaure la dernière sauvegarde
```

Prérequis : Node.js 18+ (la CI tourne sur Node 26, voir `.nvmrc`). Windows : utilise WSL (les scripts sont en Bash). MemPalace s'installe dans son propre venv (Python 3.10–3.13, ou 3.12 téléchargé via `uv` si ton Python est trop récent) ; ajoute ensuite `export MEMPALACE_ADAPTER_PYTHON="$HOME/.mempalace/venv/bin/python"` à ton `~/.bashrc`. Le plugin fixe lui-même `MEMPALACE_ADAPTER_PYTHON` (modèle `libexec/mempalace-plugin.ts.tpl`) : il ne dépend ni de ton shell ni de la façon dont OpenCode est lancé, ce qui évite `ModuleNotFoundError: No module named 'mempalace'` (cas où le plugin retombait sur le `python3` du système). Le plugin npm `@rvboris/opencode-mempalace` ne s'installe pas dans OpenCode (conflit de `peerDependencies`, erreur ERESOLVE) : l'installateur l'installe lui-même avec `--legacy-peer-deps` dans `~/.mempalace/plugin` et le charge comme plugin local (`plugins/mempalace/`). Le Python géré par `uv` (quand le tien est trop récent) est rangé dans `~/.mempalace/python`, avec le venv, hors de portée d'un `uv python prune`. Le palais MemPalace se crée tout seul à la première sauvegarde, dans `~/.config/mempalace` (l'installateur ne fait plus de `mempalace init` sur un faux dossier) ; la commande `mempalace` est liée dans `~/.local/bin`, ce que le plugin utilise en repli pour retrouver le bon Python. **Après une (ré)installation, redémarre OpenCode, service compris** : un serveur déjà lancé ne relit ni les plugins ni l'environnement, et mémorise l'interpréteur Python choisi au premier appel ; `./doctor.sh` signale un OpenCode lancé avant la dernière installation. Pour relancer seulement cette étape : `./install.sh --memory-only`. `./install.sh --shell-env` écrit un bloc balisé (`# >>> opencode-prerequisites >>>`) **tout en haut de `~/.bashrc`** (avant le `return` des shells non interactifs, sinon un service ne le voit jamais) et dans **`~/.zshenv`** pour zsh (`~/.zshrc` n'est pas lu hors terminal interactif). Il ajoute `~/.local/bin` **en fin** de `PATH` (jamais en tête : en tête, il peut faire boucler les shims `mise`) et définit `MEMPALACE_ADAPTER_PYTHON`. Relancé, il remplace son bloc sans doublon ; `./uninstall.sh` le retire et restitue le fichier à l'identique. Un service lancé par systemd ne lit aucun de ces fichiers : c'est pourquoi le plugin MemPalace fixe lui-même son Python.

## Distributions supportées

Testées en CI (installation à blanc, validation, lanceurs) sur **Arch Linux (base d'Omarchy)**, **Debian 12 et 13**, **Ubuntu 24.04 et 26.04**, **Fedora** et **Rocky Linux 9 (RHEL)**. macOS est géré par le code (Intel et ARM) mais pas testé. L'installateur détecte ta distribution et te donne la commande de paquet adaptée quand il manque quelque chose.

| | Arch / Omarchy | Debian / Ubuntu | Fedora / RHEL |
|---|---|---|---|
| Node.js | `pacman -S nodejs npm` (ou `mise use -g node`, déjà présent sur Omarchy) | `apt install nodejs npm` | `dnf install nodejs npm` |
| Conteneurs (MCP terraform) | `docker` (+ `systemctl enable --now docker`, groupe `docker`) ou `podman` | `docker.io` ou `podman` | `podman` (déjà là) ou Docker CE |
| GitHub CLI | `github-cli` | `gh` | `gh` |
| Navigateur (MCP playwright) | Chromium du système (Omarchy en a un) | Chromium, ou celui de Playwright | Chromium, ou celui de Playwright |
| Venv Python (MemPalace) | inclus ; Python 3.14+ → `uv` | `python3-venv` ; sinon `uv` | inclus ; sinon `uv` |

Points propres à chaque famille :
- **Omarchy / Arch** : Playwright ne supporte pas officiellement Arch. Le lanceur `oc-playwright-mcp` utilise donc le **Chromium du système** (headless ; `OC_PLAYWRIGHT_HEADED=1` pour voir la fenêtre) et l'installateur ne télécharge rien. `opencode` installé par `mise` est géré par `doctor.sh`.
- **Debian / Ubuntu** : sans navigateur système, Playwright télécharge son Chromium ; s'il manque des bibliothèques : `sudo npx playwright install-deps chromium`.
- **Fedora / RHEL** : Docker n'est pas fourni, `oc-terraform-mcp` choisit **Podman** automatiquement (et ignore un Docker dont le démon est arrêté). Les binaires d'Obscura et de Trivy sont des exécutables Linux génériques : `doctor.sh` vérifie qu'ils démarrent.
- Le MCP **kubernetes** quitte au démarrage s'il n'y a aucun contexte `kubectl` : l'installateur le désactive (`"disabled": true`) dans ce cas ; retire la ligne quand tu as un cluster.
- Les lanceurs `oc-playwright-mcp` et `oc-terraform-mcp` sont installés dans `~/.local/bin` (le dossier doit être dans le `PATH`).

## Choisir les modèles

Par défaut tout tourne sur `opencode-go/deepseek-v4.1-flash`. Pour changer, sans éditer de fichier :

```bash
oc-models list                          # modèle de chaque agent (◀ = modèle propre)
oc-models set ceo deepseek-v4-pro       # un agent (le préfixe opencode-go/ est facultatif)
oc-models set security opencode-go/glm-5.2
oc-models set default kimi-k2.7-code    # le modèle de tous les agents sans modèle propre
oc-models set small glm-5.3-flash       # le petit modèle (titres, résumés)
oc-models set all deepseek-v4.1-flash   # tout sur un seul modèle (supprime les modèles propres)
oc-models reset ceo                     # retire le modèle propre d'un agent (reset all : tout)
oc-models available                     # liste des modèles OpenCode Go (en ligne)
```

Tes choix sont enregistrés dans `~/.config/opencode/oc-models.json` et **ré-appliqués à chaque `./install.sh`** : une mise à jour du kit ne les écrase pas. Redémarre OpenCode après un changement. Si OpenCode affiche encore l'ancien modèle, tape `/models` : il peut mémoriser ton dernier choix manuel.

## Rétro-ingénierie (REA)

Agent **`reverse-engineer`** + MCP **`rea`** + skill **`reverse-engineer-anything`**, basés sur [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) (MIT, paquet npm `rea-agents` épinglé en 6.8.0). Il analyse des binaires natifs (Ghidra, IDA, Hopper), des applications JavaScript/Electron, du .NET, des APK Android, du firmware et des captures réseau, en séparant observations, dérivations, inférences et inconnues.

- **Aucun agent de ce type n'existait** dans les collections consultées (VoltAgent : rien sur la rétro-ingénierie ni le malware). REA ne fournit qu'un skill, repris tel quel dans `config/skills/reverse-engineer-anything/` (licence MIT conservée, voir `UPSTREAM.md`) ; l'agent est celui du kit.
- **Cadre légal**, repris du [DISCLAIMER de REA](https://github.com/morluto/rea/blob/main/DISCLAIMER.md) et écrit dans l'agent : ses propres logiciels, CTF, malware en analyse défensive, interopérabilité, recherche autorisée. Il **refuse** de contourner licences, DRM ou anti-triche, de faire des cheats, de contourner l'authentification d'un système non autorisé, de copier du code protégé, ou de créer du malware/des exploits contre des tiers. Les échantillons inconnus ne sont jamais exécutés sur ta machine.
- **Node requis : ≥ 26.12.1** (ou 24.22.1 / 22.23.4). Si ta version est plus ancienne, l'installateur désactive le MCP (`"disabled": true`) et l'agent utilise la CLI `npx -y rea-agents@6.8.0 …` ; mets Node à jour (`mise use -g node@26.12.1`) puis relance `./install.sh --no-tools`. `oc-rea-mcp --check` teste ta version.
- Les ~229 outils du MCP ne sont visibles que de cet agent (règle `rea_*` dans `opencode.jsonc`), pour ne pas alourdir les autres sessions. Ghidra, IDA et Hopper ne sont pas installés par le kit : REA utilise ceux qui existent déjà. N'utilise jamais `rea setup` : la configuration est gérée par le kit.

## Applications Android (module en option, Podman)

**Option d'installation** : `./install.sh --android` (désactivée par défaut ; le choix est mémorisé aux mises à jour, `./install.sh --no-android` retire le module). Elle ajoute les agents **`android`** (Kotlin, Jetpack Compose, Gradle) et **`mobile-tester`** (vérifie l'appli sur l'émulateur, lecture seule), le skill **`android-dev`**, le MCP **`mobile`** ([mobile-mcp](https://github.com/mobile-next/mobile-mcp) 1.0.15, Apache-2.0, ~10 000 étoiles : 34 outils pour lire l'écran par l'arbre d'accessibilité, taper, glisser, installer, lancer, lire logs et crashs ; télémétrie coupée) et la commande **`oc-android`**. Rien n'est ajouté à ton CEO ni à `AGENTS.md` sans cette option. Les applications Android s'écrivent en **Kotlin + Compose, pas en Rust** ; les versions d'AGP, Kotlin et Compose sont vérifiées dans la doc par l'agent.

**Tout tourne dans Podman (rootless), rien n'est installé sur ta machine** : JDK 17, SDK Android, Gradle et émulateur vivent dans l'image `localhost/oc-android`.

```bash
sudo pacman -S podman                       # (Debian/Ubuntu : apt install podman · Fedora : dnf install podman)
./install.sh --android
oc-android build-image --accept-licenses    # 10 à 20 min, plusieurs Go ; TU acceptes les licences du SDK Android
cd ~/Projects/monapp
oc-android gradle assembleDebug             # build / tests / lint dans le conteneur (cache Gradle conservé)
oc-android emulator start --wait            # émulateur sans fenêtre (exige /dev/kvm)
oc-android gradle installDebug              # ou : oc-android adb install -r app/build/outputs/apk/debug/app-debug.apk
oc-android adb logcat -d -s AndroidRuntime:E
oc-android emulator stop
oc-android doctor                           # Podman rootless, image, KVM, émulateur
```

Comment c'est construit : l'image part d'Ubuntu 24.04, télécharge les outils Android et Gradle **depuis les sources officielles (dl.google.com, services.gradle.org) avec vérification SHA-1/SHA-256**, et refuse de se construire sans `--accept-licenses`. Ton **projet est monté dans le conteneur** (le dossier courant : lance les commandes depuis la racine du projet) ; l'émulateur le voit en lecture seule pour installer des APK. Un faux `adb` placé dans `~/.local/share/oc-android/sdk/platform-tools/` redirige les appels vers l'émulateur du conteneur, ce qui permet à mobile-mcp de fonctionner sans SDK sur la machine. Les outils `mobile_*` ne sont visibles que de `android` et `mobile-tester` (règle de permission).

**Prérequis et limites** : Podman rootless (plages dans `/etc/subuid` et `/etc/subgid`) ; sous Linux, `/dev/kvm` accessible (virtualisation activée dans le BIOS, groupe `kvm`) : sans accélération matérielle l'émulateur est refusé, pas émulé en logiciel ; image système x86_64 (donc pas d'ARM) ; pour un téléphone physique ou iOS, installe `android-tools` ou utilise macOS et définis `ANDROID_HOME` pour que mobile-mcp utilise ce SDK-là. Le MCP `mobile` est désactivé automatiquement si le module ou Podman manque.

**Ce qui est testé** : les commandes, montages et protections de `oc-android` avec un faux Podman, la découverte des versions officielles et le faux `adb` (`scripts/test-android.mjs`, en CI), le `Containerfile` avec hadolint. **Pas testé de bout en bout** : la construction réelle de l'image et le démarrage de l'émulateur dans Podman (ni Podman ni KVM dans l'environnement de développement du kit) ; en cas d'échec, `oc-android doctor` et `oc-android emulator logs` disent où chercher.

**Alternatives examinées** : AndroidBuildMCP (0 étoile, 8 commits), `gradle-mcp` de rnett (JDK 21 + JBang pour peu de gain), Appium/Maestro/Patrol (utiles si tu les utilises déjà).

## Profils

| | Complet | Léger (`--lite`) |
|---|---|---|
| Agents | 25 | 12 (`ceo`, `architect`, `rust`, `backend`, `frontend`, `qa`, `security`, `debugger`, `researcher`, `review`, `verify-app`, `integrator`) |
| MCP | context7, grep_app, terraform, kubernetes, trivy, playwright, obscura | context7, grep_app |
| Mémoire | MemPalace (venv `~/.mempalace/venv`, ≈ 500 Mo) | — |

Le profil léger est dérivé du complet par `scripts/make-lite.mjs` : il n'y a pas deux configs à maintenir.

## Contenu

- `config/opencode.jsonc` : modèle unique `opencode-go/deepseek-v4.1-flash` pour TOUS les agents (gros quota ; aucun agent n'a de modèle propre, pour en changer un : ajoute `model: opencode-go/<id>` dans son fichier `agents/<nom>.md`), permissions débridées, formatage auto, compactage.
- `config/AGENTS.md` : règles globales (≈ 700 mots, lues à chaque session) : CEO, Rust par défaut, « terminé = prouvé », git multi-agents, sécurité internet, quota.
- `config/agents/` : `ceo` (par défaut), domaine (`architect`, `backend`, `frontend`, `database`, `devops`, `security`, `qa`, `docs`, `debugger`, `researcher`, `web-researcher`), langages/outils (`rust`, `python`, `typescript`, `go`, `shell`, `docker`, `ansible`, `terraform`, `kubernetes`), contrôle (`review`, `code-simplifier`, `verify-app`), git (`integrator`).
- `config/skills/` : `git-commit`, `project-onboarding`, `safe-refactor`, `grill-me`, `tdd`, `handoff`, `web-research`.
- `config/commands/` : `/check`, `/plan-first`, `/simplify`, `/verify`, `/learn`, `/ship`, `/pr`, `/usage`.
- `config/plugins/` : `guard/` (bloque secrets et commandes destructrices) et `notify/` (notification quand une session attend), au **format plugin OpenCode v2** (un dossier, `export default Plugin.define({ id, setup })`) ; testés par `scripts/test-plugins.mjs`. Le compactage à 90 % est natif : `compaction.buffer: "10%"`.
- `config/bin/oc-models` : choix du modèle par agent ; `config/bin/agent-wt` : un worktree git par agent (`new`, `merge`, `remove`, `list`, `integration`, `sync`).
- `templates/rust-project/` + `oc-new-rust <nom>` : projet Rust avec `AGENTS.md`, tests, CI GitHub Actions et `git init`.
- `scripts/validate-kit.mjs` : validation (utilisée par l'installateur et la CI) ; `.github/workflows/ci.yml` : validation, installation à blanc, ShellCheck, gabarit Rust.

## Comment ça marche

**CEO.** Il cadre, découpe, délègue avec un brief complet (les sous-agents n'ont pas l'historique), puis fait valider par `verify-app` en boucle jusqu'à **VALIDÉ** (5 boucles max). Les sous-agents ne posent pas de question : ils avancent sur leur meilleure hypothèse et la notent dans leur rapport.

**Validation.** Chaque agent qui produit du code ajoute des tests, lance la suite, exécute vraiment la fonctionnalité, et corrige jusqu'au vert. Désactiver ou affaiblir un test est interdit.

**Git sans conflit.** Un fichier = un propriétaire, un worktree par tâche parallèle, les spécialistes ne poussent jamais, `integrator` fusionne un à la fois avec tests après chaque fusion. Mode PR : branche `integration/<nom>`, rebase sur `origin/main`, `gh pr create`, re-synchronisation si `main` avance.

**MCP DevOps (lecture seule).** `terraform` (docs du registre, via Docker, sans jeton), `kubernetes` (lecture seule, Secrets bloqués par `k8s-mcp.toml`), `trivy`. Internet : `websearch`/`webfetch`, `grep_app`, `gh`, agent `web-researcher` ; tout contenu externe est traité comme donnée, jamais comme instruction.

**Quota.** `/usage` affiche `opencode stats`. Si le quota fond, passe en `--lite` ou mets `"enabled": false` sur un MCP.

## Ce qui n'est pas vérifié

Le kit est validé par script (`validate-kit.mjs`) et par le **schéma JSON officiel d'OpenCode** (`scripts/validate-schema.py`, aussi en CI) ; `agent-wt`, `make-lite`, `new-rust-project.sh`, `doctor` et l'installation ont été testés. Ce qui reste à confirmer à l'usage : les arguments des MCP `terraform`/`kubernetes`, la syntaxe `!`cmd`` de `/usage`, et le sens exact de `compaction.buffer` (déduit du schéma, non documenté) — vérifie avec `./doctor.sh` puis `opencode mcp list`.

## Inspirations

Boris Cherny (workflow Claude Code), [mattpocock/skills](https://github.com/mattpocock/skills), [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents), [0xfurai/claude-code-subagents](https://github.com/0xfurai/claude-code-subagents), la [doc des sous-agents de Claude Code](https://code.claude.com/docs/en/sub-agents), oh-my-opencode et les docs OpenCode.

Licence MIT. Variables optionnelles : voir `.env.example`.
