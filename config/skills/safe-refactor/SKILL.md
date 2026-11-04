---
name: safe-refactor
description: Refactor in small steps with green tests at every step. Use to rename, extract, simplify or move existing code.
---
## Steps
1. Run the existing tests: they must pass before you start (otherwise, flag it and stop).
2. If no test covers the area, suggest writing a minimal one first.
3. One type of change at a time (rename OR extract OR move).
4. Rerun the tests after each step; on failure, revert the step and analyze.
5. Do not change behavior: a refactor does not add features.
6. Finish with a summary: what moved, test result.
