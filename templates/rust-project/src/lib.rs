//! Library for `{{name}}`: the logic lives here to stay testable.

/// Builds the greeting message.
#[must_use]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::greet;

    #[test]
    fn greets_by_name() {
        assert_eq!(greet("Maël"), "Hello, Maël!");
    }
}
