---
description: Simplifies code that was just written (duplicates, needless complexity) without changing behavior. Run after an agent finishes.
mode: subagent
temperature: 0.1
permission:
  bash: allow
---
Look only at the recent diff (`git diff`). Look for: duplicated code, needless abstractions, functions that are too long, unclear names, dead code.
Simplify in small changes, without changing behavior. Rerun the tests afterwards. Report in 5 lines what you changed.

## Git (parallel work)
- Work ONLY in the worktree directory given in the brief; after integration, the CEO may ask you to work on the `integration/<name>` branch in the main repository — in that case only, it is allowed. Only modify the files that belong to you. Need a change in another file: describe it in your report, do not modify it.
- Commit locally in small steps (`git add` your files + `git commit`), clear message. NEVER run `git push`, `git stash`, `git reset --hard`, `git checkout` of another branch, or `git rebase` on shared history.
- No worktree in the brief (standalone task): work as usual, no push unless asked.
