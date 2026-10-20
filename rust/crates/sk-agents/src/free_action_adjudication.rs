//! `server/free-action-adjudication.mjs` — задача А3 переноса `sk-agents`.
//!
//! Таблицы подписей перенёс ведущий в каркасе: их читает рассказчик (А5),
//! и он не должен ждать А3. Остальной модуль — А3.

/// `ABILITY_LABELS_RU` (порядок ключей — как в JS).
pub const ABILITY_LABELS_RU: [(&str, &str); 6] = [
    ("str", "Сила"),
    ("dex", "Ловкость"),
    ("con", "Телосложение"),
    ("int", "Интеллект"),
    ("wis", "Мудрость"),
    ("cha", "Харизма"),
];

/// `SKILL_LABELS_RU` (порядок ключей — как в JS).
pub const SKILL_LABELS_RU: [(&str, &str); 18] = [
    ("acrobatics", "Акробатика"),
    ("animal-handling", "Уход за животными"),
    ("arcana", "Магия"),
    ("athletics", "Атлетика"),
    ("deception", "Обман"),
    ("history", "История"),
    ("insight", "Проницательность"),
    ("intimidation", "Запугивание"),
    ("investigation", "Расследование"),
    ("medicine", "Медицина"),
    ("nature", "Природа"),
    ("perception", "Восприятие"),
    ("performance", "Выступление"),
    ("persuasion", "Убеждение"),
    ("religion", "Религия"),
    ("sleight-of-hand", "Ловкость рук"),
    ("stealth", "Скрытность"),
    ("survival", "Выживание"),
];

/// `ABILITY_LABELS_RU[key]` — поиск по ключу таблицы.
pub fn ability_label_ru(key: &str) -> Option<&'static str> {
    ABILITY_LABELS_RU.iter().find(|(id, _)| *id == key).map(|(_, label)| *label)
}

/// `SKILL_LABELS_RU[key]` — поиск по ключу таблицы.
pub fn skill_label_ru(key: &str) -> Option<&'static str> {
    SKILL_LABELS_RU.iter().find(|(id, _)| *id == key).map(|(_, label)| *label)
}
