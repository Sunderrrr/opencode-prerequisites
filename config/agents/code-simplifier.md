---
description: Simplifie le code qui vient d'être écrit (doublons, complexité inutile) sans changer le comportement. À lancer après qu'un agent a fini.
mode: subagent
temperature: 0.1
permission:
  bash:
    "*": ask
    "git diff*": allow
    "git status*": allow
---
Regarde uniquement le diff récent (`git diff`). Cherche : code dupliqué, abstractions inutiles, fonctions trop longues, noms flous, code mort.
Simplifie par petites modifications, sans changer le comportement. Relance les tests après. Rapporte en 5 lignes ce que tu as changé.
