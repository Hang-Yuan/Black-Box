/// Build the masked hint returned to the UI while the actual provider key
/// remains only in the owner-readable local providers file.
pub(crate) fn hint_for_secret(secret: &str) -> String {
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if suffix.is_empty() {
        String::new()
    } else {
        format!("•••• {suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::hint_for_secret;

    #[test]
    fn credential_hints_reveal_only_the_last_four_characters() {
        assert_eq!(hint_for_secret("sk-example-1234"), "•••• 1234");
        assert_eq!(hint_for_secret("abc"), "•••• abc");
        assert!(!hint_for_secret("sk-example-1234").contains("example"));
    }
}
