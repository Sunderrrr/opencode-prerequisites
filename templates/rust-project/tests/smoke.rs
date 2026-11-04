//! Integration test: exercises the public API as a user would.

#[test]
fn greeting_uses_given_name() {
    assert!({{name_ident}}::greet("Rust").contains("Rust"));
}
