---
name: safe-refactor
description: Refactor par petites étapes avec tests verts à chaque étape. À utiliser pour renommer, extraire, simplifier ou déplacer du code existant.
---
## Étapes
1. Lance les tests existants : ils doivent passer avant de commencer (sinon, signale-le et arrête).
2. S'il n'y a pas de test couvrant la zone, propose d'en écrire un minimal d'abord.
3. Un seul type de changement à la fois (renommer OU extraire OU déplacer).
4. Relance les tests après chaque étape ; en cas d'échec, annule l'étape et analyse.
5. Ne change pas le comportement : un refactor n'ajoute pas de fonctionnalité.
6. Termine par un résumé : ce qui a bougé, résultat des tests.
