---
name: git-commit
description: Prépare un commit propre (Conventional Commits) à partir du diff. À utiliser quand l'utilisateur demande de commit ou de rédiger un message de commit.
---
## Étapes
1. `git status` puis `git diff --staged` (si rien n'est staged, `git diff`).
2. Propose un message au format `type(scope): résumé` (feat, fix, docs, refactor, test, chore), ≤ 72 caractères, impératif.
3. Ajoute un corps court si le « pourquoi » n'est pas évident.
4. Montre le message. En mode débridé (aucune demande de permission), commite directement ; ne demande confirmation que si c'est l'utilisateur qui a demandé le commit lui-même.
5. Ne fais jamais `git push` sans demande explicite.
