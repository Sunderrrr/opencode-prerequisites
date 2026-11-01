fn main() {
    let name = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "monde".to_string());
    println!("{}", {{name_ident}}::greet(&name));
}
