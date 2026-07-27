use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::provider_protocol::{ProviderAuthScheme, ProviderProtocol};

const EMBEDDED_PROVIDER_CATALOG: &str = include_str!("../../src/lib/provider-catalog.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCatalog {
    version: u32,
    providers: Vec<ProviderCatalogEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCatalogEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api_format: String,
    pub(crate) auth_scheme: String,
    pub(crate) default_models: HashMap<String, String>,
}

static PROVIDER_CATALOG: OnceLock<Result<ProviderCatalog, String>> = OnceLock::new();

fn parse_catalog() -> Result<ProviderCatalog, String> {
    let catalog: ProviderCatalog = serde_json::from_str(EMBEDDED_PROVIDER_CATALOG)
        .map_err(|error| format!("Embedded provider catalog is invalid: {error}"))?;
    if catalog.version != 2 {
        return Err(format!(
            "Unsupported embedded provider catalog version {}",
            catalog.version
        ));
    }
    if catalog.providers.len() != 9 {
        return Err(format!(
            "Embedded provider catalog must contain exactly 9 providers, found {}",
            catalog.providers.len()
        ));
    }

    let mut ids = HashSet::new();
    for provider in &catalog.providers {
        if provider.id.trim().is_empty() || !ids.insert(provider.id.clone()) {
            return Err(format!(
                "Embedded provider catalog contains an empty or duplicate id '{}'",
                provider.id
            ));
        }
        if !provider.base_url.starts_with("https://") {
            return Err(format!(
                "Provider '{}' must use an HTTPS compatibility endpoint",
                provider.id
            ));
        }
        let protocol = ProviderProtocol::parse(&provider.api_format).map_err(|error| {
            format!("Provider '{}' has invalid transport: {error}", provider.id)
        })?;
        let auth_scheme = ProviderAuthScheme::parse(&provider.auth_scheme).map_err(|error| {
            format!(
                "Provider '{}' has invalid authentication: {error}",
                provider.id
            )
        })?;
        if !protocol.accepts_auth_scheme(auth_scheme) {
            return Err(format!(
                "Provider '{}' cannot use '{}' authentication with the '{}' protocol",
                provider.id,
                auth_scheme.id(),
                protocol.id()
            ));
        }
        for tier in ["fable", "opus", "sonnet", "haiku"] {
            if provider
                .default_models
                .get(tier)
                .map_or(true, |model| model.trim().is_empty())
            {
                return Err(format!(
                    "Provider '{}' is missing the '{}' model mapping",
                    provider.id, tier
                ));
            }
        }
    }
    Ok(catalog)
}

pub(crate) fn entries() -> Result<&'static [ProviderCatalogEntry], String> {
    match PROVIDER_CATALOG.get_or_init(parse_catalog) {
        Ok(catalog) => Ok(&catalog.providers),
        Err(error) => Err(error.clone()),
    }
}

pub(crate) fn find(id: &str) -> Result<Option<&'static ProviderCatalogEntry>, String> {
    Ok(entries()?.iter().find(|provider| provider.id == id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid_and_keeps_user_order() {
        let providers = entries().unwrap();
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            [
                "anthropic",
                "openai",
                "gemini",
                "deepseek",
                "zhipu",
                "doubao",
                "qwen",
                "minimax",
                "kimi",
            ]
        );
        let gemini = find("gemini").unwrap().unwrap();
        assert_eq!(gemini.api_format, "gemini");
        assert_eq!(gemini.auth_scheme, "x-goog-api-key");
        assert_eq!(
            gemini.base_url,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(find("minimax").unwrap().unwrap().auth_scheme, "x-api-key");
        assert!(find("unknown").unwrap().is_none());
    }
}
