//! Перенос `server/contracts.mjs`: инфраструктурные контракты доменного слоя.
//!
//! В JS это базовые классы, чьи методы бросают «… не реализован»; конкретные
//! адаптеры (клиент RouterAI, файловые хранилища) их переопределяют. В Rust —
//! трейты с методами по умолчанию, которые возвращают ту же ошибку. Данные на
//! границе — JSON той же формы, что в JS; методы JS асинхронные, здесь —
//! синхронные: исполнитель (поток или задача) выбирает реализация.

use serde_json::Value;

/// Метод контракта не переопределён (`… не реализован`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContractError {
    #[error("{0} не реализован")]
    NotImplemented(&'static str),
    /// Отказ конкретного адаптера.
    #[error("{0}")]
    Failed(String),
}

pub type ContractResult<T> = Result<T, ContractError>;

/// `LLMClient`: вызов языковой модели (`complete(input, options)`).
pub trait LlmClient {
    fn complete(&self, _input: &Value, _options: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("LLMClient.complete"))
    }
}

/// `EmbeddingClient`.
pub trait EmbeddingClient {
    fn embed(&self, _input: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("EmbeddingClient.embed"))
    }
}

/// `RuleRepository`.
pub trait RuleRepository {
    fn list(&self, _query: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("RuleRepository.list"))
    }
}

/// `CampaignRepository`.
pub trait CampaignRepository {
    fn get(&self, _campaign_id: &str) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("CampaignRepository.get"))
    }
    fn save(&self, _campaign: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("CampaignRepository.save"))
    }
}

/// `EventRepository`.
pub trait EventRepository {
    fn append(&self, _events: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("EventRepository.append"))
    }
    fn list(&self, _query: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("EventRepository.list"))
    }
}

/// `StateSnapshotRepository`.
pub trait StateSnapshotRepository {
    fn latest(&self, _campaign_id: &str) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("StateSnapshotRepository.latest"))
    }
    fn save(&self, _snapshot: &Value) -> ContractResult<Value> {
        Err(ContractError::NotImplemented("StateSnapshotRepository.save"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Bare;
    impl LlmClient for Bare {}
    impl EmbeddingClient for Bare {}
    impl RuleRepository for Bare {}
    impl CampaignRepository for Bare {}
    impl EventRepository for Bare {}
    impl StateSnapshotRepository for Bare {}

    #[test]
    fn default_methods_report_not_implemented_like_js() {
        let bare = Bare;
        let empty = json!({});
        let messages = [
            LlmClient::complete(&bare, &empty, &empty).unwrap_err().to_string(),
            bare.embed(&empty).unwrap_err().to_string(),
            RuleRepository::list(&bare, &empty).unwrap_err().to_string(),
            CampaignRepository::get(&bare, "c").unwrap_err().to_string(),
            CampaignRepository::save(&bare, &empty).unwrap_err().to_string(),
            bare.append(&empty).unwrap_err().to_string(),
            EventRepository::list(&bare, &empty).unwrap_err().to_string(),
            bare.latest("c").unwrap_err().to_string(),
            StateSnapshotRepository::save(&bare, &empty).unwrap_err().to_string(),
        ];
        assert_eq!(
            messages,
            [
                "LLMClient.complete не реализован",
                "EmbeddingClient.embed не реализован",
                "RuleRepository.list не реализован",
                "CampaignRepository.get не реализован",
                "CampaignRepository.save не реализован",
                "EventRepository.append не реализован",
                "EventRepository.list не реализован",
                "StateSnapshotRepository.latest не реализован",
                "StateSnapshotRepository.save не реализован",
            ]
        );
    }

    struct Echo;
    impl LlmClient for Echo {
        fn complete(&self, input: &Value, _options: &Value) -> ContractResult<Value> {
            Ok(input.clone())
        }
    }

    #[test]
    fn adapters_override_the_contract() {
        assert_eq!(Echo.complete(&json!({ "messages": [] }), &json!({})), Ok(json!({ "messages": [] })));
    }
}
