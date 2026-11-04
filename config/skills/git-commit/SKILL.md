---
name: git-commit
description: Prepares a clean commit (Conventional Commits) from the diff. Use when the user asks to commit or to write a commit message.
---
## Steps
1. `git status` then `git diff --staged` (if nothing is staged, `git diff`).
2. Propose a message in the format `type(scope): summary` (feat, fix, docs, refactor, test, chore), ≤ 72 characters, imperative.
3. Add a short body if the "why" is not obvious.
4. Show the message. In unrestricted mode (no permission prompt), commit directly; only ask for confirmation when the user themself asked for the commit.
5. Never run `git push` without an explicit request.
