# {{name}}

Rust project. Global rules (CEO, validation, git) come from `~/.config/opencode/AGENTS.md`.

## Commands
- Format: `cargo fmt --all`
- Lint: `cargo clippy --all-targets -- -D warnings`
- Tests: `cargo test --all-targets`
- Run: `cargo run -- <arguments>`
- Release: `cargo build --release`

## Structure
- `src/lib.rs`: testable logic. `src/main.rs`: thin entry point (arguments, output).
- `tests/`: integration tests. Unit tests inside modules (`#[cfg(test)]`).

## Conventions
- `unsafe` forbidden (`unsafe_code = "forbid"`). No `unwrap()` outside tests; errors with `Result`.
- One feature = a test that fails first (skill `tdd`), then the code.

## Lessons
<!-- /learn adds rules learned from past mistakes here, one per line -->
