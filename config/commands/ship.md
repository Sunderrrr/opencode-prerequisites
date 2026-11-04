---
description: Simplify, validate until green, then prepare the commit
---
1. Use @code-simplifier.
2. Use @verify-app. If it answers FAIL, have the right specialist fix it then rerun @verify-app, until VALIDATED (5 loops max).
3. When it is VALIDATED, load the git-commit skill and suggest the message. Do not push.
