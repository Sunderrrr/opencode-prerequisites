//! Bibliothèque de `{{name}}` : la logique vit ici pour rester testable.

/// Construit le message d'accueil.
#[must_use]
pub fn greet(name: &str) -> String {
    format!("Bonjour, {name} !")
}

#[cfg(test)]
mod tests {
    use super::greet;

    #[test]
    fn greets_by_name() {
        assert_eq!(greet("Maël"), "Bonjour, Maël !");
    }
}
