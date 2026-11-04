---
name: project-onboarding
description: Discovers an unknown project (stack, build/test commands, structure) and prepares a project AGENTS.md. Use when arriving on a new repository.
---
## Steps
1. List the root and read README, package.json / pyproject.toml / Cargo.toml / Makefile.
2. Identify: language, framework, package manager, install/build/test/lint commands.
3. Map the folder structure and conventions (naming, formatting, CI in `.github/`).
4. Write or improve `AGENTS.md` at the root: Commands, Structure, Conventions, Known pitfalls sections. Maximum ~40 lines, verified facts only.
5. Do not modify any other file.
