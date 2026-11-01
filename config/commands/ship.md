---
description: Simplifier, valider jusqu'au vert, puis préparer le commit
---
1. Utilise @code-simplifier.
2. Utilise @verify-app. S'il répond ÉCHEC, fais corriger par le bon spécialiste puis relance @verify-app, jusqu'à VALIDÉ (5 boucles max).
3. Quand c'est VALIDÉ, charge le skill git-commit et propose le message. Ne push pas.
