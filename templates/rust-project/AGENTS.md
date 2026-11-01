# {{name}}

Projet Rust. Les règles globales (CEO, validation, git) viennent de `~/.config/opencode/AGENTS.md`.

## Commandes
- Formater : `cargo fmt --all`
- Lint : `cargo clippy --all-targets -- -D warnings`
- Tests : `cargo test --all-targets`
- Lancer : `cargo run -- <arguments>`
- Release : `cargo build --release`

## Structure
- `src/lib.rs` : logique testable. `src/main.rs` : point d'entrée mince (arguments, affichage).
- `tests/` : tests d'intégration. Tests unitaires dans les modules (`#[cfg(test)]`).

## Conventions
- `unsafe` interdit (`unsafe_code = "forbid"`). Pas de `unwrap()` hors tests ; erreurs avec `Result`.
- Une fonctionnalité = un test qui échoue d'abord (skill `tdd`), puis le code.

## Leçons
<!-- /learn ajoute ici les règles tirées des erreurs passées, une ligne chacune -->
