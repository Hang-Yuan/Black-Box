#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderProtocol {
    AnthropicMessages,
    OpenAiChatCompletions,
    GeminiGenerateContent,
}

impl ProviderProtocol {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Ok(Self::AnthropicMessages),
            "openai" => Ok(Self::OpenAiChatCompletions),
            "gemini" => Ok(Self::GeminiGenerateContent),
            unsupported => Err(format!("Unsupported provider protocol '{unsupported}'")),
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic",
            Self::OpenAiChatCompletions => "openai",
            Self::GeminiGenerateContent => "gemini",
        }
    }

    pub(crate) fn default_auth_scheme(self) -> ProviderAuthScheme {
        match self {
            Self::AnthropicMessages => ProviderAuthScheme::XApiKey,
            Self::OpenAiChatCompletions => ProviderAuthScheme::Bearer,
            Self::GeminiGenerateContent => ProviderAuthScheme::XGoogApiKey,
        }
    }

    pub(crate) fn accepts_auth_scheme(self, scheme: ProviderAuthScheme) -> bool {
        match self {
            Self::AnthropicMessages => matches!(
                scheme,
                ProviderAuthScheme::XApiKey | ProviderAuthScheme::Bearer
            ),
            Self::OpenAiChatCompletions => scheme == ProviderAuthScheme::Bearer,
            Self::GeminiGenerateContent => scheme == ProviderAuthScheme::XGoogApiKey,
        }
    }

    pub(crate) fn uses_translation_gateway(self) -> bool {
        !matches!(self, Self::AnthropicMessages)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderAuthScheme {
    XApiKey,
    Bearer,
    XGoogApiKey,
}

impl ProviderAuthScheme {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "x-api-key" => Ok(Self::XApiKey),
            "bearer" => Ok(Self::Bearer),
            "x-goog-api-key" => Ok(Self::XGoogApiKey),
            unsupported => Err(format!(
                "Unsupported provider authentication scheme '{unsupported}'"
            )),
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::XApiKey => "x-api-key",
            Self::Bearer => "bearer",
            Self::XGoogApiKey => "x-goog-api-key",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_contracts_keep_transport_and_auth_explicit() {
        let gemini = ProviderProtocol::parse("gemini").unwrap();
        assert_eq!(gemini.id(), "gemini");
        assert!(gemini.uses_translation_gateway());
        assert_eq!(
            gemini.default_auth_scheme(),
            ProviderAuthScheme::XGoogApiKey
        );
        assert!(gemini.accepts_auth_scheme(ProviderAuthScheme::XGoogApiKey));
        assert!(!gemini.accepts_auth_scheme(ProviderAuthScheme::Bearer));

        let anthropic = ProviderProtocol::parse("anthropic").unwrap();
        assert!(!anthropic.uses_translation_gateway());
        assert!(anthropic.accepts_auth_scheme(ProviderAuthScheme::XApiKey));
        assert!(anthropic.accepts_auth_scheme(ProviderAuthScheme::Bearer));
    }
}
