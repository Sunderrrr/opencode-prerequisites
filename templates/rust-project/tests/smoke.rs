//! Test d'intégration : vérifie l'API publique comme le ferait un utilisateur.

#[test]
fn greeting_uses_given_name() {
    assert!({{name_ident}}::greet("Rust").contains("Rust"));
}
