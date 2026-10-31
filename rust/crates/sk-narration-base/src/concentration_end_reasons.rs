//! Перенос `server/concentration-end-reasons.mjs`: почему кончилась
//! концентрация — по-русски, для хроники и боевого журнала.
//!
//! `ConcentrationEnded.payload.reason` — машинный ключ. Незнакомый ключ
//! подписью не становится: нейтральное «эффект завершён» лучше сырого
//! идентификатора посреди русского текста.

use serde_json::Value;

use crate::jsx;

/// `CONCENTRATION_END_REASON_LABELS` в порядке объявления JS.
pub const CONCENTRATION_END_REASON_LABELS: &[(&str, &str)] = &[
    ("replaced", "начато другое заклинание"),
    ("voluntary", "по своей воле"),
    ("failed-saving-throw", "спасбросок концентрации провален"),
    ("incapacitated", "заклинатель выведен из строя"),
    ("duration-expired", "время действия истекло"),
    ("duration_expired", "время действия истекло"),
    ("effect-finished", "эффект исчерпан"),
    ("long-rest", "долгий отдых"),
    ("long-cast-started", "начато долгое заклинание"),
    ("dispelled", "заклинание рассеяно"),
    ("readied-released", "заготовленное заклинание выпущено"),
    ("readied-expired", "заготовка не дождалась повода"),
    ("resistance-used", "бонус спасброска использован"),
    ("repeat-save", "цель прошла повторный спасбросок"),
    ("turn-start-save", "цель прошла спасбросок в начале хода"),
    ("damage-save", "цель прошла спасбросок после урона"),
    ("save-success", "цель прошла спасбросок"),
    ("action-save", "цель вырвалась, потратив действие"),
    ("action-other", "эффект снят действием"),
    ("break-free", "цель вырвалась"),
    ("steady-nerves", "цель совладала со страхом"),
    ("extinguished", "пламя потушено"),
    ("sleet-storm", "буря сбила сосредоточенность"),
    ("form-destroyed", "принятый облик разрушен"),
    ("target-defeated", "цель повержена"),
    ("next-weapon-hit-saved", "цель увернулась от эффекта удара"),
    ("next-weapon-hit-resolved", "эффект удара исполнен"),
    ("duel-violated", "дуэль нарушена"),
    ("duelist-too-far", "дуэлянт слишком далеко"),
    ("ally-damaged-duel-target", "союзник ранил соперника по дуэли"),
];

/// Подпись незнакомого ключа.
pub const UNKNOWN_CONCENTRATION_END_REASON_LABEL: &str = "эффект завершён";

/// `concentrationEndReasonLabel(reason)`: ключ — `String(reason ?? '')`.
pub fn concentration_end_reason_label(reason: Option<&Value>) -> &'static str {
    concentration_end_reason_label_str(&jsx::string(reason))
}

/// То же для строки-ключа.
pub fn concentration_end_reason_label_str(reason: &str) -> &'static str {
    CONCENTRATION_END_REASON_LABELS
        .iter()
        .find(|(key, _)| *key == reason)
        .map_or(UNKNOWN_CONCENTRATION_END_REASON_LABEL, |(_, label)| *label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sk_core::{re, text};

    #[test]
    fn every_reason_written_by_the_server_has_a_label() {
        // Сторож из JS-теста: причины, которые сервер пишет литералом в
        // `ConcentrationEnded`, ищутся прямо в исходниках `server/*.mjs`.
        let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server");
        let pattern = re!(r"'ConcentrationEnded',\s*\{[^}]*?reason:\s*'([a-z_-]+)'", "gu");
        let mut literal = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(&server).expect("каталог server") {
            let path = entry.expect("файл").path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("mjs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("исходник");
            for captures in pattern.captures_iter(&source).filter_map(Result::ok) {
                if let Some(reason) = captures.get(1) {
                    literal.insert(reason.as_str().to_string());
                }
            }
        }
        assert!(literal.len() >= 20, "найдено причин: {}", literal.len());
        let missing: Vec<&String> = literal.iter().filter(|reason| !CONCENTRATION_END_REASON_LABELS.iter().any(|(key, _)| key == reason)).collect();
        assert!(missing.is_empty(), "без подписи: {missing:?}");
    }

    #[test]
    fn labels_are_russian_and_unknown_keys_do_not_leak() {
        for (_, label) in CONCENTRATION_END_REASON_LABELS {
            assert!(text::test(re!(r"^[а-яё ,]+$", "u"), label), "{label}");
        }
        assert_eq!(concentration_end_reason_label(Some(&json!("failed-saving-throw"))), "спасбросок концентрации провален");
        assert_eq!(concentration_end_reason_label(Some(&json!("some-future-reason"))), "эффект завершён");
        assert_eq!(concentration_end_reason_label(None), "эффект завершён");
        assert_eq!(concentration_end_reason_label(Some(&json!("constructor"))), "эффект завершён", "Object.hasOwn не видит прототип");
    }
}
