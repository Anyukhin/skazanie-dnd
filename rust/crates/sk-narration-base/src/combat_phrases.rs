//! Перенос `server/combat-phrases.mjs`: голос боевой хроники без модели —
//! варианты реплик, их выбор и склонения.
//!
//! Выбор формулировки **детерминированный**: зерно — идентификатор события
//! ([`phrase_seed`]), индекс — первые 8 шестнадцатеричных знаков SHA-256 от
//! `зерно\0вид` по модулю числа вариантов. Одно и то же событие при повторе,
//! повторной проекции и replay даёт ту же строку; на этом держится
//! идемпотентность летописи. [`Phrasebook`] не даёт двум соседним строкам одного
//! вида одну формулировку.
//!
//! Правила языка: только настоящее время и безличные обороты (рода в данных
//! нет); косвенный падеж имени — только когда склонение надёжно
//! ([`confident_accusative`]); числа чужого листа сюда не приходят — видимость
//! решает вызывающий. Русские тексты — байт в байт как в JS.

use std::collections::HashMap;

use serde_json::Value;
use sk_core::fancy_regex::Regex;
use sk_core::{js, re, text};

use crate::jsx;

/// Зерно выбора формулировки (`phraseSeed`): идентификатор события, а у события
/// без него — его же поля `event_type|actor_id|target_ids|command_id|state_version_after`.
pub fn phrase_seed(event: Option<&Value>) -> String {
    let field = |key: &str| event.and_then(|event| event.get(key));
    let id = jsx::string(field("event_id"));
    let id = text::trim(&id);
    if !id.is_empty() {
        return id.to_string();
    }
    let targets = match field("target_ids") {
        Some(list @ Value::Array(_)) => jsx::string(Some(list)),
        _ => String::new(),
    };
    [
        jsx::string(field("event_type")),
        jsx::string(field("actor_id")),
        targets,
        jsx::string(field("command_id")),
        jsx::string(field("state_version_after")),
    ]
    .join("|")
}

/// `variantIndex(count, seed, salt)`: `parseInt(sha256(seed\0salt)[0..8], 16) % count`.
fn variant_index(count: usize, seed: &str, salt: &str) -> usize {
    let digest = sk_core::hash::sha256(format!("{seed}\u{0}{salt}"));
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    value as usize % count
}

/// Выбор формулировок в пределах одного рассказа.
#[derive(Debug, Default, Clone)]
pub struct Phrasebook {
    last: HashMap<String, usize>,
}

impl Phrasebook {
    pub fn new() -> Self {
        Self::default()
    }

    /// `pick(kind, variants, event)`: пустые варианты отбрасываются; если индекс
    /// совпал с прошлым выбором того же вида — берётся следующий.
    pub fn pick<S: AsRef<str>>(&mut self, kind: &str, variants: &[S], event: Option<&Value>) -> String {
        let options: Vec<&str> = variants.iter().map(AsRef::as_ref).filter(|variant| !variant.is_empty()).collect();
        if options.is_empty() {
            return String::new();
        }
        let mut index = variant_index(options.len(), &phrase_seed(event), kind);
        if options.len() > 1 && self.last.get(kind) == Some(&index) {
            index = (index + 1) % options.len();
        }
        self.last.insert(kind.to_string(), index);
        options[index].to_string()
    }
}

// ---------------------------------------------------------------------------
// Склонения
// ---------------------------------------------------------------------------

fn masculine_consonant() -> &'static Regex {
    re!(r"[бвгджзклмнпрстфхцчшщ]$", "u")
}

fn ends(regex: &Regex, word: &str) -> bool {
    text::test(regex, word)
}

/// `part.slice(0, -n)`.
fn drop_last(part: &str, count: i64) -> String {
    text::slice(part, 0, Some(-count))
}

/// `accusativeName(name)`: винительный однословного имени (через дефис — по
/// частям, номер не трогается) с однозначным окончанием; иначе имя как есть.
pub fn accusative_name(name: &str) -> String {
    let source = text::trim(name);
    let pattern = re!(r"^([А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*)(\s+\d+)?$", "u");
    let Some(captures) = pattern.captures(source).ok().flatten() else {
        return name.to_string();
    };
    let base = captures.get(1).map_or("", |m| m.as_str());
    let number = captures.get(2).map_or("", |m| m.as_str());
    let mut declined = Vec::new();
    for part in base.split('-') {
        let lower = text::lower(part);
        let result = if ends(masculine_consonant(), &lower) {
            format!("{part}а")
        } else if ends(re!(r"[^и]а$", "u"), &lower) {
            format!("{}у", drop_last(part, 1))
        } else if ends(re!(r"я$", "u"), &lower) && jsx::utf16_len(&lower) > 2 {
            format!("{}ю", drop_last(part, 1))
        } else {
            return name.to_string();
        };
        declined.push(result);
    }
    format!("{}{number}", declined.join("-"))
}

/// Несклоняемые имена существ: винительный совпадает с именительным.
const INDECLINABLE_NAMES: &[&str] = &["зомби"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gender {
    Masculine,
    Feminine,
}

fn cyrillic_lower_word() -> &'static Regex {
    re!(r"^[а-яё]+$", "u")
}

fn adjective_gender(word: &str) -> Option<Gender> {
    let lower = text::lower(word);
    if jsx::utf16_len(&lower) < 4 || !text::test(cyrillic_lower_word(), &lower) {
        return None;
    }
    if ends(re!(r"(?:ый|ий|ой)$", "u"), &lower) {
        return Some(Gender::Masculine);
    }
    if ends(re!(r"(?:ая|яя)$", "u"), &lower) {
        return Some(Gender::Feminine);
    }
    None
}

/// Одушевлённый винительный прилагательного: «Лютого», «Гигантскую».
fn adjective_accusative(word: &str, gender: Gender) -> String {
    if gender == Gender::Feminine {
        return if ends(re!(r"яя$", "u"), word) { format!("{}юю", drop_last(word, 2)) } else { format!("{}ую", drop_last(word, 2)) };
    }
    if ends(re!(r"[ыо]й$", "u"), word) || ends(re!(r"[гкх]ий$", "u"), word) {
        return format!("{}ого", drop_last(word, 2));
    }
    format!("{}его", drop_last(word, 2))
}

/// Винительный существительного, род которого известен по прилагательному.
fn noun_accusative(word: &str, gender: Gender) -> Option<String> {
    let mut declined = Vec::new();
    for part in word.split('-') {
        let lower = text::lower(part);
        if !text::test(cyrillic_lower_word(), &lower) {
            return None;
        }
        let result = if ends(re!(r"[оеё]$", "u"), &lower) {
            // Средний род: винительный совпадает с именительным.
            part.to_string()
        } else if gender == Gender::Masculine {
            if ends(masculine_consonant(), &lower) {
                format!("{part}а")
            } else if ends(re!(r"[ьй]$", "u"), &lower) {
                format!("{}я", drop_last(part, 1))
            } else if ends(re!(r"[^и]а$", "u"), &lower) {
                format!("{}у", drop_last(part, 1))
            } else {
                return None;
            }
        } else if ends(re!(r"ая$", "u"), &lower) {
            format!("{}ую", drop_last(part, 2))
        } else if ends(re!(r"яя$", "u"), &lower) {
            format!("{}юю", drop_last(part, 2))
        } else if ends(re!(r"[^и]а$", "u"), &lower) {
            format!("{}у", drop_last(part, 1))
        } else if ends(re!(r"я$", "u"), &lower) {
            format!("{}ю", drop_last(part, 1))
        } else if ends(re!(r"ь$", "u"), &lower) {
            part.to_string()
        } else {
            return None;
        };
        declined.push(result);
    }
    Some(declined.join("-"))
}

/// `confidentAccusative(name)`: винительный падеж имени существа, когда
/// склонение надёжно, иначе `None`. Сверх [`accusative_name`] понимает
/// прилагательные перед существительным («Лютого волка», «Чёрную слизь») и
/// несогласованное определение в родительном («Скелета минотавра»).
pub fn confident_accusative(name: &str) -> Option<String> {
    let collapsed = text::replace_all(re!(r"\s+", "gu"), name, " ");
    let source = text::trim(&collapsed);
    if source.is_empty() {
        return None;
    }
    let single = accusative_name(source);
    if single != source {
        return Some(single);
    }
    let captures = re!(r"^(.+?)((?:\s+\d+)?)$", "u").captures(source).ok().flatten()?;
    let body = captures.get(1).map_or("", |m| m.as_str());
    let number = captures.get(2).map_or("", |m| m.as_str());
    let words: Vec<&str> = body.split(' ').collect();
    if words.len() == 1 {
        let lower = text::lower(words[0]);
        if INDECLINABLE_NAMES.contains(&lower.as_str()) || text::test(re!(r"^[а-яё]+[оеё]$", "u"), &lower) {
            return Some(source.to_string());
        }
        return None;
    }
    let head = words[words.len() - 1];
    let adjectives = &words[..words.len() - 1];
    let genders: Vec<Option<Gender>> = adjectives.iter().map(|word| adjective_gender(word)).collect();
    if let Some(gender) = genders[0] {
        if genders.iter().all(|value| *value == Some(gender)) {
            if let Some(noun) = noun_accusative(head, gender) {
                let mut parts: Vec<String> = adjectives.iter().map(|word| adjective_accusative(word, gender)).collect();
                parts.push(noun);
                return Some(format!("{}{number}", parts.join(" ")));
            }
        }
    }
    // «Скелет минотавра»: склоняется первое слово, определение в родительном — нет.
    let (first, tail) = (words[0], &words[1..]);
    if tail.iter().all(|word| text::test(cyrillic_lower_word(), word) && adjective_gender(word).is_none()) {
        let declined = accusative_name(first);
        if declined != first {
            let mut parts = vec![declined];
            parts.extend(tail.iter().map(|word| word.to_string()));
            return Some(format!("{}{number}", parts.join(" ")));
        }
    }
    None
}

/// `hoursLabelRu(value)`: «1 час», «2 часа», «8 часов». Число — уже `Number(value)`;
/// `NaN` считается нулём, как `Number(value) || 0`.
pub fn hours_label_ru(value: f64) -> String {
    let number = if value.is_nan() { 0.0 } else { value };
    let count = js::round(number).max(0.0);
    let last_two = count % 100.0;
    let last = count % 10.0;
    let word = if (11.0..=14.0).contains(&last_two) {
        "часов"
    } else if last == 1.0 {
        "час"
    } else if (2.0..=4.0).contains(&last) {
        "часа"
    } else {
        "часов"
    };
    format!("{} {word}", js::f64_string(count))
}

/// `lowerFirst(value)`: первая буква строчная, если это не аббревиатура.
pub fn lower_first(value: &str) -> String {
    let source = text::trim(value);
    if jsx::utf16_len(source) > 1 && text::test(re!(r"^[А-ЯЁ][а-яё]", "u"), source) {
        let mut chars = source.chars();
        let first = chars.next().map(|ch| text::lower(&ch.to_string())).unwrap_or_default();
        return format!("{first}{}", chars.as_str());
    }
    source.to_string()
}

/// `joinRu(items)`: «а, б и в»; пустые после обрезки отбрасываются.
pub fn join_ru<S: AsRef<str>>(items: &[S]) -> String {
    let list: Vec<&str> = items.iter().map(|item| text::trim(item.as_ref())).filter(|item| !item.is_empty()).collect();
    if list.len() <= 1 {
        return list.concat();
    }
    format!("{} и {}", list[..list.len() - 1].join(", "), list[list.len() - 1])
}

/// `joinRu(items)` для значения JSON: не массив — пусто, элементы — `String(x ?? '')`.
pub fn join_ru_value(items: Option<&Value>) -> String {
    let list: Vec<String> = match items {
        Some(Value::Array(items)) => items.iter().map(|item| jsx::string(Some(item))).collect(),
        _ => Vec::new(),
    };
    join_ru(&list)
}

// ---------------------------------------------------------------------------
// Оружие и способ атаки
// ---------------------------------------------------------------------------

/// Чем бьют вблизи: творительный падеж. Ключ — название без регистра и «+1».
const MELEE_WEAPON_INSTRUMENTAL: &[(&str, &str)] = &[
    ("дубинка", "дубинкой"), ("большая дубинка", "большой дубинкой"), ("дубина", "дубиной"), ("палица", "палицей"),
    ("кинжал", "кинжалом"), ("ручной топор", "ручным топором"), ("боевой топор", "боевым топором"), ("топор", "топором"),
    ("лёгкий молот", "лёгким молотом"), ("боевой молот", "боевым молотом"), ("молот", "молотом"), ("булава", "булавой"),
    ("боевой посох", "боевым посохом"), ("посох", "посохом"), ("серп", "серпом"), ("копьё", "копьём"),
    ("метательное копьё", "копьём"), ("кистень", "кистенём"), ("глефа", "глефой"), ("секира", "секирой"),
    ("двуручный меч", "двуручным мечом"), ("длинный меч", "длинным мечом"), ("короткий меч", "коротким мечом"), ("меч", "мечом"),
    ("алебарда", "алебардой"), ("пика всадника", "пикой"), ("длинная пика", "длинной пикой"), ("пика", "пикой"),
    ("моргенштерн", "моргенштерном"), ("рапира", "рапирой"), ("скимитар", "скимитаром"), ("трезубец", "трезубцем"),
    ("боевой клевец", "боевым клевцом"), ("кнут", "кнутом"),
];

/// Из чего стреляют: родительный падеж после «из».
const RANGED_WEAPON_GENITIVE: &[(&str, &str)] = &[
    ("короткий лук", "короткого лука"), ("длинный лук", "длинного лука"), ("лук", "лука"),
    ("лёгкий арбалет", "лёгкого арбалета"), ("тяжёлый арбалет", "тяжёлого арбалета"), ("ручной арбалет", "ручного арбалета"),
    ("арбалет", "арбалета"), ("праща", "пращи"), ("духовая трубка", "духовой трубки"), ("мушкет", "мушкета"), ("пистолет", "пистолета"),
];

/// Что мечут: неодушевлённый винительный совпадает с именительным.
const THROWN_WEAPON_ACCUSATIVE: &[(&str, &str)] = &[
    ("дротик", "дротик"), ("метательный дротик", "дротик"), ("копьё", "копьё"), ("метательное копьё", "копьё"),
    ("ручной топор", "топор"), ("кинжал", "кинжал"), ("камень", "камень"), ("лёгкий молот", "молот"), ("трезубец", "трезубец"),
];

/// Естественное оружие существа: глагол с прямым дополнением в винительном.
const NATURAL_ATTACK_VERBS: &[(&str, &[&str])] = &[
    ("укус", &["кусает", "вцепляется зубами в"]),
    ("клык", &["кусает", "вцепляется клыками в"]),
    ("когти", &["полосует когтями", "рвёт когтями"]),
    ("коготь", &["полосует когтем", "бьёт когтем"]),
    ("бодание", &["бодает", "с разбегу бодает"]),
    ("рога", &["бодает", "поддевает рогами"]),
    ("жало", &["жалит"]),
    ("клюв", &["клюёт", "бьёт клювом"]),
    ("клешня", &["хватает клешнёй", "бьёт клешнёй"]),
    ("щупальце", &["хлещет щупальцем"]),
    ("щупальца", &["хлещет щупальцами"]),
    ("хвост", &["хлещет хвостом"]),
    ("захлёст", &["хлещет"]),
    ("копыта", &["бьёт копытами"]),
    ("ложноножка", &["хлещет ложноножкой"]),
    ("кулак", &["бьёт кулаком"]),
    ("разлагающий кулак", &["бьёт гниющим кулаком"]),
    ("размашистый удар", &["с размаху бьёт", "наотмашь бьёт"]),
    ("раздирание", &["раздирает"]),
    ("сжимание", &["сдавливает"]),
    ("растаптывание", &["топчет"]),
];

/// `lookupWeapon(table, name)`: точное название, иначе самое длинное известное
/// в конце («Жестокий длинный меч»), иначе в начале («Длинный меч предупреждения»).
fn lookup_weapon<T: Copy>(table: &[(&'static str, T)], name: &str) -> Option<T> {
    let lowered = text::lower(name);
    let without_bonus = text::replace_first(re!(r"\s*\+\d+\s*$", "u"), &lowered, "");
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &without_bonus, " ");
    let key = text::trim(&collapsed);
    if key.is_empty() {
        return None;
    }
    if let Some((_, value)) = table.iter().find(|(candidate, _)| *candidate == key) {
        return Some(*value);
    }
    let mut known: Vec<&(&'static str, T)> = table.iter().collect();
    known.sort_by_key(|(candidate, _)| std::cmp::Reverse(jsx::utf16_len(candidate)));
    if let Some((_, value)) = known.iter().find(|(candidate, _)| key.ends_with(&format!(" {candidate}"))) {
        return Some(*value);
    }
    known.iter().find(|(candidate, _)| key.starts_with(&format!("{candidate} "))).map(|(_, value)| *value)
}

/// Вид атаки одним словом: рука, выстрел, бросок или чары.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttackMode {
    Melee,
    Ranged,
    Thrown,
    Spell,
}

impl AttackMode {
    fn key(self) -> &'static str {
        match self {
            AttackMode::Melee => "melee",
            AttackMode::Ranged => "ranged",
            AttackMode::Thrown => "thrown",
            AttackMode::Spell => "spell",
        }
    }

    /// Непереходный оборот того же действия: «бьёт», «стреляет», «метает оружие».
    fn intransitive(self) -> &'static [&'static str] {
        match self {
            AttackMode::Melee => &["атакует", "наносит удар", "бросается в атаку"],
            AttackMode::Ranged => &["стреляет", "посылает выстрел", "бьёт издали"],
            AttackMode::Thrown => &["метает оружие", "бросает оружие"],
            AttackMode::Spell => &["направляет чары", "пускает в ход магию"],
        }
    }

    /// Существительное удара — для «уходит от …».
    fn noun_genitive(self) -> &'static str {
        match self {
            AttackMode::Melee => "удара",
            AttackMode::Ranged => "выстрела",
            AttackMode::Thrown => "броска",
            AttackMode::Spell => "чар",
        }
    }

    fn hit_words(self) -> &'static [&'static str] {
        match self {
            AttackMode::Melee => &["попадание", "удар достигает цели", "точно в цель"],
            AttackMode::Ranged => &["попадание", "выстрел достигает цели", "точно в цель"],
            AttackMode::Thrown => &["попадание", "бросок достигает цели", "точно в цель"],
            AttackMode::Spell => &["попадание", "чары достигают цели", "точно в цель"],
        }
    }

    fn miss_words(self) -> &'static [&'static str] {
        match self {
            AttackMode::Melee => &["промах", "мимо", "удар уходит в пустоту"],
            AttackMode::Ranged => &["промах", "мимо", "выстрел уходит в сторону"],
            AttackMode::Thrown => &["промах", "мимо", "бросок уходит в сторону"],
            AttackMode::Spell => &["промах", "мимо", "чары рассеиваются впустую"],
        }
    }
}

fn field<'a>(payload: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    payload.and_then(|payload| payload.get(key))
}

fn attack_mode(payload: Option<&Value>) -> AttackMode {
    if js::truthy(field(payload, "spell_id")) || js::truthy(field(payload, "spell_name")) {
        return AttackMode::Spell;
    }
    match jsx::string(field(payload, "attack_kind")).as_str() {
        "ranged" => AttackMode::Ranged,
        "thrown" => AttackMode::Thrown,
        _ => AttackMode::Melee,
    }
}

/// Глаголы ближнего удара по виду урона: «рубит», «колет», «бьёт».
fn melee_verbs(damage_type: &str) -> &'static [&'static str] {
    match damage_type {
        "slashing" => &["рубит", "полосует", "бьёт"],
        "piercing" => &["колет", "бьёт", "целит остриём в"],
        "bludgeoning" => &["бьёт", "обрушивает удар на", "с размаху бьёт"],
        _ => &["бьёт", "атакует", "обрушивает удар на"],
    }
}

/// Переходные глаголы атаки: «X <глагол> <цель в винительном>».
fn transitive_attack_verbs(payload: Option<&Value>) -> Vec<String> {
    let mode = attack_mode(payload);
    let item_name = field(payload, "item_name");
    let weapon_name = jsx::string(if js::truthy(item_name) { item_name } else { field(payload, "action_name") });
    match mode {
        AttackMode::Spell => return vec!["направляет чары в".into(), "обрушивает магию на".into()],
        AttackMode::Ranged => {
            let source = lookup_weapon(RANGED_WEAPON_GENITIVE, &weapon_name).map(|from| format!(" из {from}")).unwrap_or_default();
            return vec![format!("стреляет{source} в"), format!("целится и стреляет{source} в"), format!("посылает выстрел{source} в")];
        }
        AttackMode::Thrown => {
            return match lookup_weapon(THROWN_WEAPON_ACCUSATIVE, &weapon_name) {
                Some(thrown) => vec![format!("метает {thrown} в"), format!("с размаху бросает {thrown} в")],
                None => vec!["метает оружие в".into(), "бросает оружие в".into()],
            };
        }
        AttackMode::Melee => {}
    }
    if let Some(natural) = lookup_weapon(NATURAL_ATTACK_VERBS, &jsx::string(field(payload, "action_name"))) {
        return natural.iter().map(|verb| verb.to_string()).collect();
    }
    let instrument = lookup_weapon(MELEE_WEAPON_INSTRUMENTAL, &weapon_name);
    melee_verbs(&jsx::string(field(payload, "damage_type")))
        .iter()
        .map(|verb| match instrument {
            // Оружие называется там, где глагол оставляет ему место: «рубит Волка
            // длинным мечом», но не «обрушивает удар на Волка длинным мечом».
            Some(instrument) if !text::test(re!(r" (?:в|на)$", "u"), verb) => format!("{verb} {{target}} {instrument}"),
            _ => verb.to_string(),
        })
        .collect()
}

/// Вход реплики атаки (`AttackPhraseInput`).
#[derive(Debug, Clone, Copy, Default)]
pub struct AttackPhraseInput<'a> {
    /// Имя атакующего.
    pub actor: &'a str,
    /// Имя цели.
    pub target: &'a str,
    /// Цель — противник отряда: числа её листа закрыты.
    pub target_is_enemy: bool,
    /// payload `AttackResolved`.
    pub payload: Option<&'a Value>,
    /// Пояснение броска: преимущество, укрытие, высота.
    pub reason: Option<&'a str>,
    /// Разбор броска, например «15 против КД 12»; только для цели-героя.
    pub numbers: Option<&'a str>,
    /// Хвост урона: «, 7 урона» или «, 9 урона; ОЗ 9 → 0».
    pub damage: Option<&'a str>,
    /// Атака по возможности вдогонку.
    pub opportunity: bool,
    /// Вступление по тактике существа: «Почуяв слабину, ».
    pub lead: Option<&'a str>,
}

/// Начало реплики об атаке — кто, кого и чем, без исхода. `None` — имя цели
/// надёжно не склоняется.
fn attack_lead(book: &mut Phrasebook, input: &AttackPhraseInput<'_>, event: Option<&Value>) -> Option<String> {
    let mode = attack_mode(input.payload);
    let accusative = confident_accusative(input.target);
    if input.opportunity {
        let mut variants = vec![
            format!("{} выходит из досягаемости, и {} бьёт вдогонку", input.target, input.actor),
            format!("Отступая, {} открывается, и {} успевает ударить", input.target, input.actor),
        ];
        if let Some(accusative) = &accusative {
            variants.push(format!("{} ловит {accusative} на отходе", input.actor));
        }
        return Some(book.pick("attack-opportunity", &variants, event));
    }
    let accusative = accusative?;
    let variants: Vec<String> = transitive_attack_verbs(input.payload)
        .into_iter()
        .map(|candidate| {
            if candidate.contains("{target}") {
                format!("{} {}", input.actor, jsx::replace_first_str(&candidate, "{target}", &accusative))
            } else {
                format!("{} {candidate} {accusative}", input.actor)
            }
        })
        .collect();
    Some(format!("{}{}", input.lead.unwrap_or(""), book.pick(&format!("attack-{}", mode.key()), &variants, event)))
}

fn hero_target_outcome(payload: Option<&Value>) -> &'static str {
    if !js::truthy(field(payload, "hit")) {
        return "промах";
    }
    if js::truthy(field(payload, "automatic_critical")) {
        return "критическое попадание — цель не может защищаться";
    }
    if js::truthy(field(payload, "critical")) {
        "критическое попадание"
    } else {
        "попадание"
    }
}

/// `attackPhrase(book, input, event)`: реплика атаки целиком. Цель-противник —
/// исход словами и урон; цель-герой — разбор броска «15 против КД 12 — попадание».
pub fn attack_phrase(book: &mut Phrasebook, input: &AttackPhraseInput<'_>, event: Option<&Value>) -> String {
    let payload = input.payload;
    let mode = attack_mode(payload);
    let lead = attack_lead(book, input, event);
    let reason = input.reason.unwrap_or("");
    let damage = input.damage.unwrap_or("");
    let numbers = match input.numbers {
        Some(numbers) if !input.target_is_enemy && !numbers.is_empty() => numbers,
        _ => "",
    };
    let hit = js::truthy(field(payload, "hit"));
    let Some(lead) = lead else {
        // Имя без надёжного склонения: «Огр атакует, цель — Мирель», «Борин
        // стреляет — Тень не успевает уйти от выстрела».
        let plain = book.pick(&format!("attack-{}-plain", mode.key()), mode.intransitive(), event);
        let subject = format!("{}{} {plain}{reason}", input.lead.unwrap_or(""), input.actor);
        let noun = mode.noun_genitive();
        if !numbers.is_empty() {
            return format!("{subject}, цель — {}: {numbers} — {}{damage}.", input.target, hero_target_outcome(payload));
        }
        if hit {
            return format!("{subject} — {} не успевает уйти от {noun}: {}{damage}.", input.target, hero_target_outcome(payload));
        }
        return book.pick(
            "miss-plain",
            &[format!("{subject}, но {} уходит от {noun}.", input.target), format!("{subject} — мимо: {} успевает увернуться.", input.target)],
            event,
        );
    };
    if !numbers.is_empty() {
        return format!("{lead}{reason}: {numbers} — {}{damage}.", hero_target_outcome(payload));
    }
    if hit {
        let outcome = if js::truthy(field(payload, "automatic_critical")) {
            "критическое попадание — цель не может защищаться".to_string()
        } else if js::truthy(field(payload, "critical")) {
            let second = if mode == AttackMode::Melee { "сокрушительный удар, критическое попадание" } else { "критическое попадание в уязвимое место" };
            book.pick(&format!("crit-{}", mode.key()), &["критическое попадание", second], event)
        } else {
            book.pick(&format!("hit-{}", mode.key()), mode.hit_words(), event)
        };
        return format!("{lead}{reason} — {outcome}{damage}.");
    }
    // Как в JS: вложенный выбор слова промаха делается раньше выбора формы и
    // всегда, даже если форма выйдет второй.
    let miss_word = book.pick(&format!("miss-{}", mode.key()), mode.miss_words(), event);
    book.pick("miss-shape", &[format!("{lead}{reason} — {miss_word}."), format!("{lead}{reason}, но промахивается.")], event)
}

// ---------------------------------------------------------------------------
// Урон, падение, спасение
// ---------------------------------------------------------------------------

/// `damagePhrase({ target, amount, hp })`: урон без удара рядом. `hp` по
/// умолчанию пуст.
pub fn damage_phrase(target: &str, amount: f64, hp: Option<&str>) -> String {
    format!("{target} получает {} урона{}.", js::f64_string(amount), hp.unwrap_or(""))
}

/// `downedPhrase(book, { target, side }, event)`: `side` — `hero`, `enemy` или иное.
pub fn downed_phrase(book: &mut Phrasebook, target: &str, side: &str, event: Option<&Value>) -> String {
    match side {
        "hero" => book.pick(
            "downed-hero",
            &[
                format!("{target} падает без сознания — теперь всё решат спасброски от смерти."),
                format!("{target} оседает на землю без сознания: начинаются спасброски от смерти."),
                format!("{target} теряет сознание и падает. Дальше — спасброски от смерти."),
            ],
            event,
        ),
        "enemy" => book.pick(
            "downed-enemy",
            &[
                format!("{target} падает и выбывает из боя."),
                format!("{target} рушится наземь — этот противник выбыл."),
                format!("{target} валится с ног и больше не сражается."),
            ],
            event,
        ),
        _ => format!("{target} выбывает из боя."),
    }
}

/// `stabilizedPhrase(book, target, event)`.
pub fn stabilized_phrase(book: &mut Phrasebook, target: &str, event: Option<&Value>) -> String {
    book.pick(
        "stabilized",
        &[format!("{target} без сознания, но кровь остановлена — жизнь вне опасности."), format!("Кровь остановлена: {target} без сознания, но вне опасности.")],
        event,
    )
}

/// `spellSourceText(spellLabel)`: «от заклинания «Священное пламя»» или «от заклинания».
pub fn spell_source_text(spell_label: &str) -> String {
    if spell_label.is_empty() {
        "от заклинания".into()
    } else {
        format!("от заклинания {spell_label}")
    }
}

/// `savePhrase(book, { target, saved, source }, event)`: `saved` — `true`,
/// `false` или неизвестно; `source` по умолчанию пуст.
pub fn save_phrase(book: &mut Phrasebook, target: &str, saved: Option<bool>, source: &str, event: Option<&Value>) -> String {
    let from = if source.is_empty() { String::new() } else { format!(" {source}") };
    match saved {
        Some(true) => {
            let variants = if source.is_empty() {
                [format!("{target} успешно проходит спасбросок."), format!("{target} выдерживает — спасбросок успешен.")]
            } else {
                [format!("{target} успешно проходит спасбросок{from}."), format!("{target} выдерживает: спасбросок{from} успешен.")]
            };
            book.pick("save-success", &variants, event)
        }
        Some(false) => {
            let variants = if source.is_empty() {
                [format!("{target} проваливает спасбросок."), format!("{target} не выдерживает — спасбросок провален.")]
            } else {
                [format!("{target} проваливает спасбросок{from}."), format!("{target} не может устоять: спасбросок{from} провален.")]
            };
            book.pick("save-fail", &variants, event)
        }
        None => format!("{target} делает спасбросок{from}."),
    }
}

// ---------------------------------------------------------------------------
// Перемещение и ход
// ---------------------------------------------------------------------------

/// Публичная тактика существа (`npc-turn-scheduler.mjs`) → оборот перемещения.
fn tactic_moves(tactic: &str) -> Option<&'static [&'static str]> {
    Some(match tactic {
        "сокращает дистанцию" => &["{actor} сокращает дистанцию — {feet} фт.", "{actor} рвётся вперёд на {feet} фт."],
        "выходит на линию атаки" => &["{actor} выходит на линию атаки — {feet} фт.", "{actor} занимает позицию для выстрела ({feet} фт)."],
        "держит дистанцию" => &["{actor} разрывает дистанцию — {feet} фт.", "{actor} отходит на {feet} фт, держа дистанцию."],
        "пытается спастись" => &["{actor} пытается вырваться из боя — {feet} фт."],
        _ => return None,
    })
}

/// `tacticLead(tactic)`: вступление к первой атаке существа в ходе.
pub fn tactic_lead(tactic: Option<&str>) -> &'static str {
    match tactic.unwrap_or("") {
        "тактика стаи" => "Пользуясь поддержкой стаи, ",
        "давит на раненого" => "Почуяв слабину, ",
        "загнан в угол" => "Отступать некуда — ",
        _ => "",
    }
}

/// `movePhrase(book, { actor, feet, tactic, mode }, event)`: `mode` — поле
/// `movement_mode` события (`long_jump`, `swing`).
pub fn move_phrase(book: &mut Phrasebook, actor: &str, feet: f64, tactic: Option<&str>, mode: Option<&Value>, event: Option<&Value>) -> String {
    let feet_text = js::f64_string(feet);
    match jsx::string(mode).as_str() {
        "long_jump" => return format!("{actor} прыгает на {feet_text} фт."),
        "swing" => return format!("{actor} перелетает на люстре {feet_text} фт."),
        _ => {}
    }
    let tactic_variants = tactic_moves(tactic.unwrap_or(""));
    let variants: &[&str] = tactic_variants.unwrap_or(&["{actor} перемещается на {feet} фт.", "{actor} проходит {feet} фт.", "{actor} смещается на {feet} фт."]);
    let picked = book.pick(if tactic_variants.is_some() { "move-tactic" } else { "move" }, variants, event);
    jsx::replace_first_str(&jsx::replace_first_str(&picked, "{actor}", actor), "{feet}", &feet_text)
}

/// Обычные боевые действия, у которых есть свой оборот вместо «использует «…»».
fn action_phrases(action_id: &str) -> Option<&'static [&'static str]> {
    Some(match action_id {
        "dash" => &["{actor} срывается с места — «{name}».", "{actor} бросается вперёд: «{name}»."],
        "disengage" => &["{actor} осторожно выходит из ближнего боя — «{name}».", "{actor} отступает, не подставляясь: «{name}»."],
        "dodge" => &["{actor} уходит в глухую оборону — «{name}».", "{actor} сосредотачивается на защите: «{name}»."],
        "help" => &["{actor} приходит на помощь союзнику — «{name}»."],
        "hide" => &["{actor} ищет укрытие — «{name}»."],
        _ => return None,
    })
}

/// `actionPhrase(book, { actor, actionId, name }, event)`.
pub fn action_phrase(book: &mut Phrasebook, actor: &str, action_id: Option<&Value>, name: &str, event: Option<&Value>) -> String {
    let action_key = jsx::string(action_id);
    let Some(variants) = action_phrases(&action_key) else {
        return format!("{actor} использует «{name}».");
    };
    let picked = book.pick(&format!("action-{action_key}"), variants, event);
    jsx::replace_first_str(&jsx::replace_first_str(&picked, "{actor}", actor), "{name}", name)
}

/// `turnEndPhrase(book, actor, event)`.
pub fn turn_end_phrase(book: &mut Phrasebook, actor: &str, event: Option<&Value>) -> String {
    book.pick("turn-end", &[format!("{actor} завершает ход."), format!("{actor} заканчивает ход."), format!("{actor} передаёт ход дальше.")], event)
}

/// `turnStartPhrase(book, actor, round, event)`.
pub fn turn_start_phrase(book: &mut Phrasebook, actor: &str, round: f64, event: Option<&Value>) -> String {
    let round = js::f64_string(round);
    book.pick("turn-start", &[format!("Раунд {round}: ходит {actor}."), format!("Раунд {round}. Теперь ходит {actor}.")], event)
}

// ---------------------------------------------------------------------------
// Начало и конец столкновения
// ---------------------------------------------------------------------------

/// Вступления к составу: [множественное, единственное].
fn encounter_intros(setting: &str) -> &'static [[&'static str; 2]] {
    match setting {
        "underground" => &[["Из темноты выходят", "Из темноты выходит"], ["В глубине прохода шевелятся тени — это", "В глубине прохода шевелится тень — это"], ["Из мрака показываются", "Из мрака показывается"]],
        "night" => &[["Из ночной темноты выступают", "Из ночной темноты выступает"], ["В темноте вспыхивают глаза — это", "В темноте вспыхивают глаза — это"]],
        "forest" => &[["Из-за деревьев выходят", "Из-за деревьев выходит"], ["Кусты раздвигаются — навстречу выходят", "Кусты раздвигаются — навстречу выходит"]],
        "road" => &[["Путь преграждают", "Путь преграждает"], ["На дороге показываются", "На дороге показывается"]],
        "graveyard" => &[["Между надгробиями показываются", "Между надгробиями показывается"], ["Среди могил шевелятся тени — это", "Среди могил шевелится тень — это"]],
        "settlement" => &[["Навстречу выходят", "Навстречу выходит"], ["Путь преграждают", "Путь преграждает"]],
        "ambush" => &[["Засада! Из укрытий выскакивают", "Засада! Из укрытия выскакивает"], ["Засада: со всех сторон появляются", "Засада: из укрытия появляется"]],
        _ => &[["Путь преграждают", "Путь преграждает"], ["Навстречу выходят", "Навстречу выходит"], ["Перед отрядом вырастают", "Перед отрядом вырастает"]],
    }
}

/// `encounterIntroPhrase(book, { names, setting }, event)`: где, кто и сколько.
/// Обстановка — `underground`, `night`, `forest`, `road`, `graveyard`,
/// `settlement`, `ambush` или `generic`. Книга фраз не используется — выбор
/// идёт по зерну события напрямую, как в JS.
pub fn encounter_intro_phrase<S: AsRef<str>>(_book: &mut Phrasebook, names: &[S], setting: &str, event: Option<&Value>) -> String {
    let roster = if names.is_empty() { "противники".to_string() } else { join_ru(names) };
    let plural = names.len() != 1;
    let intros = encounter_intros(setting);
    let [many, one] = intros[variant_index(intros.len(), &phrase_seed(event), &format!("intro-{setting}"))];
    format!("{} {roster}.", if plural { many } else { one })
}

/// `encounterEndPhrase(book, { endText }, event)`.
pub fn encounter_end_phrase(book: &mut Phrasebook, end_text: &str, event: Option<&Value>) -> String {
    book.pick(
        "encounter-end",
        &[format!("Столкновение завершено: {end_text}."), format!("Бой стихает: {end_text}."), format!("Всё кончено: {end_text}.")],
        event,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accusative_name_declines_single_words() {
        assert_eq!(accusative_name("Разбойник 1"), "Разбойника 1");
        assert_eq!(accusative_name("Гоблин-воин"), "Гоблина-воина");
        assert_eq!(accusative_name("Гиена"), "Гиену");
        assert_eq!(accusative_name("Тень"), "Тень");
        assert_eq!(accusative_name("Лютый волк"), "Лютый волк");
        assert_eq!(accusative_name("  Волк "), "Волка");
    }

    #[test]
    fn confident_accusative_handles_adjectives_and_genitive() {
        assert_eq!(confident_accusative("Лютый волк").as_deref(), Some("Лютого волка"));
        assert_eq!(confident_accusative("Гигантская крыса 2").as_deref(), Some("Гигантскую крысу 2"));
        assert_eq!(confident_accusative("Бурый медведь").as_deref(), Some("Бурого медведя"));
        assert_eq!(confident_accusative("Чёрная слизь").as_deref(), Some("Чёрную слизь"));
        assert_eq!(confident_accusative("Скелет минотавра").as_deref(), Some("Скелета минотавра"));
        assert_eq!(confident_accusative("Капитан разбойников").as_deref(), Some("Капитана разбойников"));
        assert_eq!(confident_accusative("Зомби").as_deref(), Some("Зомби"));
        assert_eq!(confident_accusative("Брам Тихий Молот"), None);
        assert_eq!(confident_accusative("Тень"), None);
        assert_eq!(confident_accusative("   "), None);
    }

    #[test]
    fn small_helpers_follow_js() {
        assert_eq!(hours_label_ru(1.0), "1 час");
        assert_eq!(hours_label_ru(2.0), "2 часа");
        assert_eq!(hours_label_ru(8.0), "8 часов");
        assert_eq!(hours_label_ru(12.0), "12 часов");
        assert_eq!(hours_label_ru(21.0), "21 час");
        assert_eq!(hours_label_ru(f64::NAN), "0 часов");
        assert_eq!(hours_label_ru(-3.0), "0 часов");
        assert_eq!(hours_label_ru(1.5), "2 часа");
        assert_eq!(lower_first("Боевой посох"), "боевой посох");
        assert_eq!(lower_first("КД"), "КД");
        assert_eq!(join_ru(&["а", " ", "б", "в"]), "а, б и в");
        assert_eq!(join_ru(&["а"]), "а");
        assert_eq!(join_ru_value(Some(&json!(["x", null, 2]))), "x и 2");
        assert_eq!(tactic_lead(Some("тактика стаи")), "Пользуясь поддержкой стаи, ");
        assert_eq!(tactic_lead(None), "");
        assert_eq!(spell_source_text(""), "от заклинания");
    }

    #[test]
    fn seed_uses_event_id_then_fields() {
        assert_eq!(phrase_seed(Some(&json!({ "event_id": "  e-1 " }))), "e-1");
        assert_eq!(phrase_seed(Some(&json!({ "event_type": "AttackResolved", "actor_id": "a", "target_ids": ["b", null, 3], "state_version_after": 7 }))), "AttackResolved|a|b,,3||7");
        assert_eq!(phrase_seed(None), "||||");
    }

    #[test]
    fn phrasebook_avoids_repeating_the_same_variant() {
        let event = json!({ "event_id": "same" });
        let mut book = Phrasebook::new();
        let first = book.pick("kind", &["a", "b", "c"], Some(&event));
        let second = book.pick("kind", &["a", "b", "c"], Some(&event));
        assert_ne!(first, second, "та же формулировка подряд не повторяется");
        assert_eq!(book.pick("kind", &["", ""], Some(&event)), "");
    }
}
