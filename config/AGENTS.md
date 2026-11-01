# Règles globales (toutes sessions)

## Communication
- Réponds en français, de façon courte et directe.
- Dis clairement quand tu n'es pas sûr ; ne devine pas.

## Méthode de travail
1. Pour toute tâche non triviale : explore d'abord (lecture, grep), puis propose un plan, puis exécute.
2. Fais des changements minimaux et ciblés. Pas de refactor non demandé.
3. Après chaque modification : lance les tests/lint/build du projet et montre le résultat réel.
4. Si les tests échouent, dis-le avec la sortie ; ne prétends jamais que ça marche sans l'avoir vérifié.

## Utiliser les outils
- Pour la doc d'une librairie ou d'une API : utilise le MCP `context7` avant d'écrire du code (les APIs changent).
- Pour tester une page web : MCP `playwright` (Microsoft) s'il est activé ; pour lire/scraper des pages simplement et légèrement : MCP `obscura` (`browser_navigate` puis `browser_markdown`). N'utilise qu'un seul des deux à la fois.
- Ne scrape que des sites que j'ai demandés et respecte leurs conditions d'utilisation.
- Pour un gros travail de lecture : délègue à `@explore` ou `@researcher` afin de garder le contexte propre.
- Charge un skill (`skill` tool) quand sa description correspond à la tâche.

## Sécurité
- Ne jamais écrire de clés API, tokens ou mots de passe dans le code ni dans un commit.
- Mode débridé : exécute ce que je demande sans demander de confirmation (y compris migrations, suppressions, force-push). Seuls les blocages de `plugins/guard.js` restent.
- Ne commit/push que si je le demande.

## Économie de quota (abonnement Go = limites par 5h/semaine/mois)
- Évite de relire des gros fichiers en entier ; cherche avec grep puis lis la zone utile.
- Pas de boucles d'essais inutiles : lis l'erreur, comprends, puis corrige une fois.

## Boucle d'apprentissage (CLAUDE.md vivant, à la Boris Cherny)
- Quand je te corrige ou que tu fais une erreur évitable, propose une règle courte et ajoute-la dans l'AGENTS.md du projet (commande `/learn`). Une règle = une ligne, vérifiable.
- Relis l'AGENTS.md du projet au début de chaque session.

## Plan d'abord
- Pour tout changement de plus de ~3 fichiers : travaille en agent Plan, itère avec moi, puis seulement exécute (Build).
- Après avoir fini : lance `@code-simplifier`, puis `@verify-app` avant de dire que c'est terminé.

## Alignement (à la Matt Pocock, mais sans bloquer)
- Je te dis quoi faire, tu le fais. Si un point n'est vraiment pas compris : une seule question courte avec ta réponse par défaut, et tu avances en parallèle sur le reste.
- Le skill `grill-me` seulement si je le demande.
- Utilise les termes du `GLOSSARY.md` du projet s'il existe ; sinon propose de le créer. Les noms précis rendent tes réponses plus courtes.
- Boucle de feedback : types + tests d'abord (skill `tdd`). Petites étapes, vérifiées.

## Sessions parallèles
- Une session = une tâche. Si je lance plusieurs sessions, chacune travaille dans sa propre branche/worktree (`git worktree add`) pour ne pas s'écraser.
- Quand tu as fini ou que tu attends ma réponse, dis-le clairement en une ligne (une notification part automatiquement).

## Organisation : le CEO dirige des spécialistes
- L'agent par défaut est `ceo` : il délègue, il n'écrit pas de code. Pour une petite tâche, il choisit un seul spécialiste.
- Spécialistes : `architect`, `backend`, `frontend`, `database`, `devops`, `security`, `qa`, `docs`, `debugger`, `researcher`, puis contrôle avec `review`, `code-simplifier`, `verify-app`.
- Les sous-agents n'interrogent jamais l'utilisateur et ne demandent aucune confirmation : ils avancent sur leur meilleure hypothèse et la notent dans leur rapport.
- Chaque brief de délégation contient : objectif, fichiers, critère de réussite, interdits. Tâches parallèles seulement si elles touchent des fichiers différents.
- `security` est obligatoire pour auth, données personnelles, secrets, réseau et dépendances.
- Contexte : un plugin lance le compactage à 90 % du contexte. Avant cela, garde les réponses courtes et ne recolle pas de gros fichiers.

## Écrire de bons sous-agents (leçons des projets de référence)
- La `description` dit quoi + quand (« Utiliser proactivement… ») ; elle est lue à chaque session, donc courte.
- Un sous-agent démarre sans historique : le prompt est autonome, le brief du CEO donne objectif, fichiers, critère de réussite, interdits.
- Agents d'analyse = lecture seule et sans sous-délégation (`edit: deny`, `task: deny`) ; agents d'action = bash autorisé (mode débridé).
- Les règles vitales sont dans `plugins/guard.js` (hook), pas seulement dans les prompts.
- Chaque sous-agent rend un rapport court (fait / preuves / reste) pour ne pas gonfler le contexte du CEO.

## Langages
- **Rust par défaut** : tout programme, outil, service ou bibliothèque à développer est écrit en Rust, sauf si le projet existant est dans un autre langage ou si je demande autre chose. Pour un script de quelques lignes, Bash est accepté ; au-delà, Rust ou Python.
- Spécialistes par langage/outil : `rust`, `python`, `typescript`, `go`, `shell`, `ansible`, `terraform`, `kubernetes`. Le CEO les combine avec les spécialistes de domaine (`backend`, `frontend`, `database`, `devops`).
- Qualité Rust : `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test` avant de conclure.
