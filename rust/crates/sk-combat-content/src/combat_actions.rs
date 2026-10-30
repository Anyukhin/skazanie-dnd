//! Перенос `server/combat-actions.mjs`: боевые действия героя 1–12 уровня —
//! общие действия боя, умения классов и подклассов (проверенные вручную и
//! разобранные из каталога dnd.su `data/dndsu-class-actions-1-12.json`),
//! манёвры мастера боевых искусств, оружие дыхания вида, запасы ресурсов и их
//! восстановление на отдыхе (в том числе политика редакции 2024).
//!
//! Карточка действия — `serde_json::Value` той же формы и с тем же порядком
//! ключей, что у JS: по ней строится панель действий и проекция игроку.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};
use sk_ruleset::character_progression::is_optional_feature_selected;
pub use sk_ruleset::ruleset_config::CLASS_RESOURCES_2024_POLICY_ID;
use sk_ruleset::ruleset_config::DND_2014_RULESET_ID;

use crate::jsv::{self, array, defined, is_str, nullish, num, prop};
use crate::wild_shape::wild_shape_forms_for;

static CATALOG: LazyLock<Value> = LazyLock::new(|| jsv::embedded_json(include_str!("../../../../data/dndsu-class-actions-1-12.json")));

/// Служебные хвосты описаний dnd.su латиницей («лимит: proficiency»,
/// «состояние: incapacitated») переводятся при загрузке; тот же словарь — в
/// `src/combat-actions.ts`.
fn readable_catalog_description(value: Option<&Value>) -> String {
    let replacements: [(&sk_core::fancy_regex::Regex, &str); 9] = [
        (re!(r"лимит: proficiency", "gu"), "лимит: бонус мастерства"),
        (re!(r"лимит: ability", "gu"), "лимит: модификатор характеристики"),
        (re!(r" · состояние: feature-movement", "gu"), ""),
        (re!(r"состояние: charmed", "gu"), "состояние: «Очарованный»"),
        (re!(r"состояние: frightened", "gu"), "состояние: «Испуганный»"),
        (re!(r"состояние: incapacitated", "gu"), "состояние: «Недееспособный»"),
        (re!(r"состояние: poisoned", "gu"), "состояние: «Отравленный»"),
        (re!(r"состояние: restrained", "gu"), "состояние: «Опутанный»"),
        (re!(r"состояние: unconscious", "gu"), "состояние: «Бессознательный»"),
    ];
    replacements.iter().fold(js::s(value), |current, (pattern, replacement)| text::replace_all(pattern, &current, replacement))
}

/// `GENERATED_CLASSES`: каталог класса с переведёнными описаниями действий.
static GENERATED_CLASSES: LazyLock<IndexMap<String, Value>> = LazyLock::new(|| {
    let mut classes = IndexMap::new();
    for entry in array(CATALOG.get("classes")) {
        let mut class = entry.as_object().cloned().unwrap_or_default();
        let actions: Vec<Value> = array(entry.get("actions"))
            .iter()
            .map(|action| {
                let mut action = action.as_object().cloned().unwrap_or_default();
                let description = readable_catalog_description(action.get("description"));
                action.insert("description".into(), Value::from(description));
                Value::Object(action)
            })
            .collect();
        class.insert("actions".into(), Value::Array(actions));
        classes.insert(jsv::string(entry.get("classKey")), Value::Object(class));
    }
    classes
});

fn generated_class(class_key: Option<&str>) -> Option<&'static Value> {
    GENERATED_CLASSES.get(class_key?)
}

/// `normalizedName(value)`: нижний регистр, «ё» → «е», всё кроме латиницы,
/// кириллицы и цифр — один пробел.
fn normalized_name(value: Option<&Value>) -> String {
    normalized_text(&js::s(value))
}

fn normalized_text(source: &str) -> String {
    let lowered = text::lower(source).replace('ё', "е");
    text::trim(&text::replace_all(re!(r"[^a-zа-я0-9]+", "giu"), &lowered, " ")).to_string()
}

fn class_url(class_key: Option<&str>) -> Option<&'static str> {
    Some(match class_key? {
        "barbarian" => "https://www.dnd.su/class/87-barbarian/",
        "bard" => "https://www.dnd.su/class/88-bard/",
        "cleric" => "https://www.dnd.su/class/89-cleric/",
        "druid" => "https://www.dnd.su/class/90-druid/",
        "fighter" => "https://www.dnd.su/class/91-fighter/",
        "monk" => "https://www.dnd.su/class/93-monk/",
        "paladin" => "https://www.dnd.su/class/94-paladin/",
        "ranger" => "https://www.dnd.su/class/97-ranger/",
        "rogue" => "https://www.dnd.su/class/99-rogue/",
        "sorcerer" => "https://www.dnd.su/class/101-sorcerer/",
        "warlock" => "https://www.dnd.su/class/104-warlock/",
        "wizard" => "https://www.dnd.su/class/105-wizard/",
        _ => return None,
    })
}

const VERIFIED_ACTION_EFFECTS: [&str; 13] =
    ["stand_up", "break_free", "steady_nerves", "extinguish_flames", "dash", "check", "contest", "heal", "weapon_attack", "cleanse", "restore_action", "stabilize", "first_aid"];
const DEFAULT_PARTIAL_ACTION_NOTE: &str = "Сервер исполняет только формализованную часть способности; остальные свойства пока представлены маркером.";

/// `action(id, name, options)`: карточка с умолчаниями и статусом механики.
fn action(id: &str, name: &str, options: Value) -> Value {
    let options = options.as_object().cloned().unwrap_or_default();
    let effect_kind = jsv::path(options.get("effect"), &["kind"]);
    let mechanics_support = match defined(options.get("mechanicsSupport")) {
        Some(value) => value.clone(),
        None => Value::from(if is_str(effect_kind, "special") {
            "ruling-only"
        } else if VERIFIED_ACTION_EFFECTS.iter().any(|kind| is_str(effect_kind, kind)) {
            "verified"
        } else {
            "partial"
        }),
    };
    let mut card = Map::new();
    card.insert("id".into(), Value::from(id));
    card.insert("name".into(), Value::from(name));
    card.insert("category".into(), Value::from("class"));
    card.insert("target".into(), Value::from("self"));
    card.insert("actionType".into(), Value::from("action"));
    card.insert("range".into(), Value::from(0));
    card.insert("minimumLevel".into(), Value::from(1));
    for (key, value) in &options {
        card.insert(key.clone(), value.clone());
    }
    let partial = mechanics_support.as_str() == Some("partial");
    card.insert("mechanicsSupport".into(), mechanics_support);
    if js::truthy(options.get("supportNote")) || partial {
        let note = defined(options.get("supportNote")).cloned().unwrap_or_else(|| Value::from(DEFAULT_PARTIAL_ACTION_NOTE));
        card.insert("supportNote".into(), note);
    }
    Value::Object(card)
}

static COMMON_ACTIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    vec![
        action("offhand-attack", "Атака второй рукой", json!({"category":"common","target":"enemy","actionType":"bonus_action","range":5,"requiresOffHandWeapon":true,"description":"Бонусным действием после действия Атака ударить лёгким оружием второй руки. Модификатор характеристики к урону — только со стилем «Сражение двумя оружиями».","effect":{"kind":"weapon_attack","attacks":1,"offHand":true}})),
        action("stand-up", "Встать", json!({"category":"common","actionType":"free","description":"Потратить половину скорости текущего хода и прекратить состояние «сбит с ног».","effect":{"kind":"stand_up"}})),
        action("break-free", "Высвободиться", json!({"category":"common","description":"Действием совершить проверку Силы против Сл удерживающего эффекта и прекратить опутывание.","effect":{"kind":"break_free"}})),
        action("steady-nerves", "Совладать с собой", json!({"category":"common","description":"Действием совершить проверку Мудрости против Сл «Гневной кары» и прекратить испуг либо спасбросок против заклинания, которое позволяет вырваться действием («Неудержимая пляска Отто»).","effect":{"kind":"steady_nerves"}})),
        action("extinguish-self", "Потушить пламя", json!({"category":"common","description":"Действием сбить с себя пламя — «Пылающей кары» или алхимического огня.","effect":{"kind":"extinguish_flames"}})),
        action("extinguish-ally", "Потушить союзника", json!({"category":"common","target":"ally","range":5,"description":"Действием сбить пламя с существа в пределах 5 футов — «Пылающей кары» или алхимического огня.","effect":{"kind":"extinguish_flames"}})),
        action("expeditious-retreat-dash", "Стремительный рывок", json!({"category":"common","actionType":"bonus_action","description":"Пока активно «Поспешное отступление», совершить Рывок бонусным действием.","effect":{"kind":"dash"}})),
        action("dash", "Рывок", json!({"category":"common","description":"Дополнительное перемещение, равное скорости, до конца хода.","effect":{"kind":"dash"}})),
        action("disengage", "Отход", json!({"category":"common","description":"Перемещение не провоцирует атак по возможности до конца хода.","effect":{"kind":"condition","condition":"disengaged","duration":"until-next-turn"}})),
        action("dodge", "Уклонение", json!({"category":"common","description":"Атаки по вам совершаются с помехой до начала следующего хода.","effect":{"kind":"condition","condition":"dodging","duration":"until-next-turn"}})),
        action("hide", "Засада", json!({"category":"common","description":"Проверка Ловкости (Скрытность), чтобы получить преимущество из укрытия.","effect":{"kind":"check","ability":"dex","skill":"stealth"}})),
        action("help", "Помощь", json!({"category":"common","target":"ally","range":5,"description":"Союзник получает преимущество на следующую атаку.","effect":{"kind":"condition","condition":"helped","duration":"until-used"}})),
        action("stabilize", "Стабилизировать", json!({"category":"common","target":"ally","range":5,"description":"Проверка Мудрости (Медицина) СЛ 10, чтобы стабилизировать союзника с 0 ОЗ.","effect":{"kind":"stabilize","ability":"wis","skill":"medicine","difficulty":10}})),
        action("first-aid", "Первая помощь", json!({"category":"common","target":"creature","range":5,"description":"Проверка Мудрости (Медицина) СЛ 10, чтобы привести нокаутированное существо в сознание.","effect":{"kind":"first_aid","ability":"wis","skill":"medicine","difficulty":10}})),
        action("grapple", "Захват", json!({"category":"common","target":"enemy","range":5,"description":"Состязание Атлетики против Атлетики или Акробатики; при успехе цель схвачена.","effect":{"kind":"contest","condition":"grappled"}})),
        action("shove", "Толчок", json!({"category":"common","target":"enemy","range":5,"description":"Состязание Силы; при успехе цель сбита с ног.","effect":{"kind":"contest","condition":"prone"}})),
        action("ready", "Подготовка", json!({"category":"common","description":"Подготовить действие и сохранить реакцию для указанного условия.","mechanicsSupport":"partial","supportNote":"Сервер фиксирует подготовку до следующего хода; настройка условия и автоматический запуск реакции пока не реализованы.","effect":{"kind":"condition","condition":"readied","duration":"until-next-turn"}})),
        action("search", "Поиск", json!({"category":"common","description":"Проверка Мудрости (Восприятие) для обнаружения скрытых целей и деталей.","effect":{"kind":"check","ability":"wis","skill":"perception"}})),
        action("use-object", "Использовать предмет", json!({"category":"common","description":"Взаимодействовать с немагическим предметом в бою.","effect":{"kind":"special"}})),
        action("ready-action", "Готовность", json!({"category":"common","description":"Потратить действие, чтобы заготовить атаку оружием или заклинание и выпустить его реакцией, когда сработает выбранный триггер.","effect":{"kind":"ready_action","triggers":["enemy-approaches","enemy-casts-spell"]},"mechanicsSupport":"partial","supportNote":"Заготавливается атака оружием или заклинание с временем накладывания «действие»: ячейка тратится сразу, магия держится концентрацией. Триггеров два и оба распознаёт сервер — враг подошёл вплотную или начал творить заклинание; произвольное «воспринимаемое обстоятельство» из редакции не исполняется."})),
    ]
});

fn class_actions(class_key: &str) -> &'static [Value] {
    static CLASS_ACTIONS: LazyLock<HashMap<&'static str, Vec<Value>>> = LazyLock::new(|| {
        HashMap::from([
            ("barbarian", vec![
                action("rage", "Ярость", json!({"actionType":"bonus_action","resource":"rage","description":"Сопротивление физическому урону и бонус к урону атак Силой.","effect":{"kind":"condition","condition":"raging","duration":"rounds:10"}})),
                action("reckless-attack", "Безрассудная атака", json!({"actionType":"free","minimumLevel":2,"description":"Преимущество на атаки Силой, но атаки по вам тоже с преимуществом.","effect":{"kind":"condition","condition":"reckless","duration":"until-next-turn"}})),
                action("extra-attack", "Дополнительная атака", json!({"target":"enemy","range":600,"minimumLevel":5,"requiresWeapon":true,"description":"Дважды атаковать оружием действием Атака.","effect":{"kind":"weapon_attack","attacks":2}})),
                action("instinctive-pounce", "Инстинктивный бросок", json!({"actionType":"free","minimumLevel":7,"description":"При входе в ярость переместиться на половину скорости.","effect":{"kind":"dash","multiplier":0.5}})),
            ]),
            ("bard", vec![
                action("bardic-inspiration", "Вдохновение барда", json!({"target":"ally","actionType":"bonus_action","range":60,"resource":"bardic_inspiration","description":"Союзник получает кость вдохновения (к6, с 5-го уровня к8, с 10-го к10): она сама прибавляется к его проваленной атаке, проверке или спасброску — как в BG3 — и тратится.","effect":{"kind":"condition","condition":"bardic-inspiration","duration":"rounds:100"}})),
                action("countercharm", "Контрочарование", json!({"minimumLevel":6,"description":"Вы и союзники получаете преимущество против испуга и очарования.","effect":{"kind":"condition","condition":"countercharm","duration":"until-next-turn"}})),
            ]),
            ("cleric", vec![
                action("turn-undead", "Изгнание нежити", json!({"target":"self","range":30,"minimumLevel":2,"resource":"channel_divinity","description":"Вся нежить в 30 футах спасается Мудростью или на минуту изгнана: бежит прочь, не атакует и не отвечает, пока не получит урон. С 5-го уровня слабая нежить уничтожается (ПО ½, с 8-го — 1).","effect":{"kind":"save","saveAbility":"wis","condition":"turned","duration":"rounds:10","areaUndead":true,"radius":30}})),
                action("divine-spark", "Божественная искра", json!({"target":"ally","range":30,"minimumLevel":2,"resource":"channel_divinity","description":"Направить божественную силу и восстановить хиты союзнику.","effect":{"kind":"heal","dice":"1d8","ability":"wis"}})),
                action("divine-intervention", "Божественное вмешательство", json!({"minimumLevel":10,"description":"Просить божество вмешаться; шанс успеха равен уровню жреца в процентах.","effect":{"kind":"percent_check"}})),
            ]),
            ("druid", vec![
                action("wild-shape", "Дикая форма", json!({"minimumLevel":2,"resource":"wild_shape","description":"Действием принять облик зверя (ПО ¼ со 2-го уровня, ½ с 4-го, 1 с 8-го): его хиты, КД, скорость и атака. Повторно — вернуться в свой облик бонусным действием. В облике нельзя колдовать.","effect":{"kind":"wild_shape"}})),
                action("wild-companion", "Дикий спутник", json!({"minimumLevel":2,"resource":"wild_shape","description":"Потратить Дикую форму, чтобы призвать временного духа-спутника.","effect":{"kind":"condition","condition":"wild-companion","duration":"rounds:600"}})),
            ]),
            ("fighter", vec![
                action("second-wind", "Второе дыхание", json!({"actionType":"bonus_action","resource":"second_wind","description":"Восстановить 1к10 + уровень хитов.","effect":{"kind":"heal","dice":"1d10","addLevel":true}})),
                action("action-surge", "Всплеск действий", json!({"actionType":"free","minimumLevel":2,"resource":"action_surge","description":"Немедленно получить ещё одно действие.","effect":{"kind":"restore_action"}})),
                action("extra-attack", "Дополнительная атака", json!({"target":"enemy","range":600,"minimumLevel":5,"requiresWeapon":true,"description":"Атаковать оружием дважды; с 11-го уровня — трижды.","effect":{"kind":"weapon_attack","attacksByLevel":{"5":2,"11":3}}})),
            ]),
            ("monk", vec![
                action("martial-arts-strike", "Боевые искусства", json!({"target":"enemy","actionType":"bonus_action","range":5,"description":"Совершить безоружную атаку бонусным действием.","effect":{"kind":"weapon_attack","attacks":1,"unarmed":true}})),
                action("flurry-of-blows", "Шквал ударов", json!({"target":"enemy","actionType":"bonus_action","range":5,"minimumLevel":2,"resource":"ki","description":"Потратить 1 ци и совершить две безоружные атаки.","effect":{"kind":"weapon_attack","attacks":2,"unarmed":true}})),
                action("extra-attack", "Дополнительная атака", json!({"target":"enemy","range":600,"minimumLevel":5,"requiresWeapon":true,"description":"Дважды атаковать оружием действием Атака.","effect":{"kind":"weapon_attack","attacks":2}})),
                action("patient-defense", "Терпеливая оборона", json!({"actionType":"bonus_action","minimumLevel":2,"resource":"ki","description":"Потратить 1 ци и использовать Уклонение.","effect":{"kind":"condition","condition":"dodging","duration":"until-next-turn"}})),
                action("step-of-the-wind", "Шаг ветра", json!({"actionType":"bonus_action","minimumLevel":2,"resource":"ki","description":"Потратить 1 ци: Рывок и Отход, дальность прыжка удваивается.","effect":{"kind":"dash","addCondition":"disengaged"}})),
                action("quickened-healing", "Быстрое исцеление", json!({"actionType":"action","minimumLevel":4,"resource":"ki","cost":2,"description":"Потратить 2 ци и восстановить кость боевых искусств + мастерство хитов.","effect":{"kind":"heal","dice":"1d6","addProficiency":true}})),
                action("stunning-strike", "Ошеломляющий удар", json!({"target":"enemy","range":5,"minimumLevel":5,"resource":"ki","requiresWeapon":true,"description":"Атака; при попадании — 1 ци, и цель спасается Телосложением против СЛ ци (8 + мастерство + Мудрость) или ошеломлена до конца вашего следующего хода. Промах ци не тратит.","effect":{"kind":"weapon_attack","attacks":1,"saveAbility":"con","saveDcAbility":"wis","condition":"stunned"}})),
                action("stillness-of-mind", "Спокойствие разума", json!({"minimumLevel":7,"description":"Завершить на себе один эффект испуга или очарования.","effect":{"kind":"cleanse","conditions":["frightened","charmed"]}})),
            ]),
            ("paladin", vec![
                action("divine-sense", "Божественное чувство", json!({"resource":"divine_sense","description":"Обнаружить небожителей, исчадий и нежить в пределах 60 футов.","effect":{"kind":"condition","condition":"divine-sense","duration":"until-next-turn"}})),
                action("lay-on-hands", "Наложение рук", json!({"target":"ally","range":5,"resource":"lay_on_hands","cost":5,"description":"Восстановить хиты из запаса целительной силы (5 × уровень паладина): сколько не хватает цели или сколько указано, но не больше остатка запаса.","effect":{"kind":"heal","amount":5,"fromPool":true}})),
                action("divine-smite", "Божественная кара", json!({"target":"enemy","range":5,"minimumLevel":2,"resource":"spell_slots_1","requiresWeapon":true,"description":"Атака оружием ближнего боя; при попадании тратится ячейка: 2к8 излучением за 1-й круг и 1к8 за каждый круг выше (не больше 5к8), ещё 1к8 по нежити и исчадиям. Промах ячейку не тратит.","effect":{"kind":"weapon_attack","attacks":1,"divineSmite":true}})),
                action("extra-attack", "Дополнительная атака", json!({"target":"enemy","range":600,"minimumLevel":5,"requiresWeapon":true,"description":"Дважды атаковать оружием действием Атака.","effect":{"kind":"weapon_attack","attacks":2}})),
            ]),
            ("ranger", vec![
                action("favored-foe", "Избранный враг", json!({"target":"enemy","actionType":"free","resource":"favored_foe","concentration":true,"description":"Пометить цель после попадания и наносить ей дополнительный урон.","effect":{"kind":"condition","condition":"favored-foe","duration":"concentration"}})),
                action("hunters-mark", "Метка охотника", json!({"target":"enemy","actionType":"bonus_action","range":90,"resource":"spell_slots_1","concentration":true,"minimumLevel":2,"description":"Пометить врага: атаки оружием наносят дополнительно 1к6 урона.","effect":{"kind":"condition","condition":"hunters-mark","duration":"concentration"}})),
                action("extra-attack", "Дополнительная атака", json!({"target":"enemy","range":600,"minimumLevel":5,"requiresWeapon":true,"description":"Дважды атаковать оружием действием Атака.","effect":{"kind":"weapon_attack","attacks":2}})),
                action("hide-in-plain-sight", "Маскировка", json!({"minimumLevel":10,"description":"Замаскироваться в природном окружении и получить усиленную скрытность.","effect":{"kind":"condition","condition":"camouflaged","duration":"rounds:100"}})),
            ]),
            ("rogue", vec![
                action("sneak-attack", "Коварная атака", json!({"actionType":"free","mechanicsSupport":"ruling-only","supportNote":"Это не отдельная атака. Включите «Коварную атаку» в параметрах обычной атаки подходящим оружием; сервер проверит преимущество или союзника рядом с целью.","description":"Памятка: один раз за ход добавить урон к уже попавшей атаке дальнобойным оружием или оружием со свойством finesse.","effect":{"kind":"special","rider":"sneak_attack","commandOption":"sneak_attack"}})),
                action("cunning-dash", "Хитрое действие: Рывок", json!({"actionType":"bonus_action","minimumLevel":2,"description":"Использовать Рывок бонусным действием.","effect":{"kind":"dash"}})),
                action("cunning-disengage", "Хитрое действие: Отход", json!({"actionType":"bonus_action","minimumLevel":2,"description":"Использовать Отход бонусным действием.","effect":{"kind":"condition","condition":"disengaged","duration":"until-next-turn"}})),
                action("cunning-hide", "Хитрое действие: Засада", json!({"actionType":"bonus_action","minimumLevel":2,"description":"Использовать Засаду бонусным действием.","effect":{"kind":"check","ability":"dex","skill":"stealth"}})),
                action("steady-aim", "Верный прицел", json!({"actionType":"bonus_action","minimumLevel":3,"description":"Не двигаться и получить преимущество на следующую атаку.","effect":{"kind":"condition","condition":"steady-aim","duration":"until-used"}})),
                action("uncanny-dodge", "Невероятное уклонение", json!({"actionType":"reaction","minimumLevel":5,"description":"Реакцией уменьшить урон видимой атаки вдвое.","effect":{"kind":"condition","condition":"uncanny-dodge","duration":"until-used"}})),
            ]),
            ("sorcerer", vec![
                action("font-of-magic", "Источник магии", json!({"actionType":"bonus_action","minimumLevel":2,"resource":"sorcery_points","cost":2,"description":"Бонусным действием создать ячейку из чародейских очков (1-й круг — 2 очка, 2-й — 3, 3-й — 5, 4-й — 6, 5-й — 7) или перевести ячейку в очки по её кругу.","effect":{"kind":"restore_resource","resource":"spell_slots_1","amount":1}})),
                action("careful-spell", "Аккуратное заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Союзники в области следующего заклинания автоматически преуспевают в спасброске.","effect":{"kind":"condition","condition":"metamagic-careful","duration":"until-used"}})),
                action("distant-spell", "Далёкое заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Удвоить дальность следующего заклинания.","effect":{"kind":"condition","condition":"metamagic-distant","duration":"until-used"}})),
                action("empowered-spell", "Непреодолимое заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Перебросить часть костей урона следующего заклинания.","effect":{"kind":"condition","condition":"metamagic-empowered","duration":"until-used"}})),
                action("extended-spell", "Продлённое заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Удвоить длительность следующего заклинания.","effect":{"kind":"condition","condition":"metamagic-extended","duration":"until-used"}})),
                action("quickened-spell", "Ускоренное заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","cost":2,"description":"Следующее заклинание с действием накладывается бонусным действием.","effect":{"kind":"condition","condition":"metamagic-quickened","duration":"until-used"}})),
                action("heightened-spell", "Усиленное заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","cost":3,"description":"Первая цель следующего заклинания спасается с помехой.","effect":{"kind":"condition","condition":"metamagic-heightened","duration":"until-used"}})),
                action("twinned-spell", "Удвоенное заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Следующее одноцелевое заклинание может выбрать вторую цель.","effect":{"kind":"condition","condition":"metamagic-twinned","duration":"until-used"}})),
                action("subtle-spell", "Неуловимое заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Следующее заклинание не требует вербального и соматического компонентов.","effect":{"kind":"condition","condition":"metamagic-subtle","duration":"until-used"}})),
                action("seeking-spell", "Ищущее заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","cost":2,"description":"Перебросить промах атакой заклинанием.","effect":{"kind":"condition","condition":"metamagic-seeking","duration":"until-used"}})),
                action("transmuted-spell", "Преобразованное заклинание", json!({"actionType":"free","minimumLevel":3,"resource":"sorcery_points","description":"Изменить стихийный тип урона следующего заклинания.","effect":{"kind":"condition","condition":"metamagic-transmuted","duration":"until-used"}})),
            ]),
            ("warlock", vec![
                action("pact-blade", "Оружие договора", json!({"minimumLevel":3,"description":"Создать или призвать оружие договора.","effect":{"kind":"condition","condition":"pact-weapon","duration":"rounds:600"}})),
                action("pact-chain", "Спутник договора", json!({"minimumLevel":3,"description":"Призвать особого фамильяра договора Цепи.","effect":{"kind":"condition","condition":"pact-familiar","duration":"rounds:600"}})),
                action("pact-tome", "Книга Теней", json!({"minimumLevel":3,"description":"Открыть заговоры и ритуалы дара Книги.","effect":{"kind":"condition","condition":"book-of-shadows","duration":null}})),
                action("pact-talisman", "Талисман договора", json!({"minimumLevel":3,"description":"Наделить владельца талисмана поддержкой покровителя.","effect":{"kind":"condition","condition":"pact-talisman","duration":null}})),
            ]),
            ("wizard", vec![
                action("arcane-recovery", "Магическое восстановление", json!({"resource":"arcane_recovery","description":"После короткого отдыха восстановить ячейки суммарным уровнем до половины уровня волшебника.","effect":{"kind":"restore_resource","resource":"spell_slots_1","amount":1}})),
            ]),
        ])
    });
    CLASS_ACTIONS.get(class_key).map(Vec::as_slice).unwrap_or(&[])
}

/// Манёвры мастера боевых искусств: `[id, имя, тип действия, цель, дополнение эффекта]`.
static MANEUVERS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let table: [(&str, &str, &str, &str, Value); 19] = [
        ("trip-attack", "Подсекающая атака", "action", "enemy", json!({ "saveAbility": "str", "condition": "prone" })),
        ("menacing-attack", "Устрашающая атака", "action", "enemy", json!({ "saveAbility": "wis", "condition": "frightened" })),
        ("disarming-attack", "Обезоруживающая атака", "action", "enemy", json!({ "saveAbility": "str", "condition": "disarmed" })),
        ("distracting-strike", "Отвлекающий удар", "action", "enemy", json!({ "condition": "distracted" })),
        ("goading-attack", "Провоцирующая атака", "action", "enemy", json!({ "saveAbility": "wis", "condition": "goaded" })),
        ("lunging-attack", "Выпад", "action", "enemy", json!({})),
        ("maneuvering-attack", "Маневрирующая атака", "action", "enemy", json!({ "condition": "maneuvered" })),
        ("pushing-attack", "Толкающая атака", "action", "enemy", json!({ "saveAbility": "str", "condition": "pushed" })),
        ("sweeping-attack", "Размашистая атака", "action", "enemy", json!({})),
        ("precision-attack", "Точная атака", "free", "self", json!({ "condition": "precision-attack" })),
        ("feinting-attack", "Финт", "bonus_action", "enemy", json!({ "condition": "feinted" })),
        ("rally", "Воодушевление", "bonus_action", "ally", json!({ "heal": true })),
        ("parry", "Парирование", "reaction", "self", json!({ "condition": "parrying" })),
        ("riposte", "Ответный удар", "reaction", "enemy", json!({})),
        ("brace", "Удержание позиции", "reaction", "enemy", json!({})),
        ("quick-toss", "Быстрый бросок", "bonus_action", "enemy", json!({})),
        ("grappling-strike", "Захватывающий удар", "bonus_action", "enemy", json!({ "condition": "grappled" })),
        ("bait-and-switch", "Обман и смена", "free", "ally", json!({ "condition": "guarded" })),
        ("evasive-footwork", "Уклонение ногами", "free", "self", json!({ "condition": "evasive-footwork" })),
    ];
    table
        .into_iter()
        .map(|(id, name, action_type, target, extra)| {
            let attack = target == "enemy" && action_type == "action";
            let effect = if js::truthy(extra.get("heal")) {
                json!({ "kind": "heal", "dice": "1d8", "ability": "cha" })
            } else if target == "enemy" {
                let mut effect = json!({ "kind": "weapon_attack", "attacks": 1, "extraDamage": "1d8" });
                jsv::spread_into(effect.as_object_mut().expect("объект"), Some(&extra));
                effect
            } else {
                let mut effect = Map::new();
                effect.insert("kind".into(), Value::from("condition"));
                if let Some(condition) = extra.get("condition") {
                    effect.insert("condition".into(), condition.clone());
                }
                effect.insert("duration".into(), Value::from("until-next-turn"));
                Value::Object(effect)
            };
            let range = match target {
                "self" => 0,
                "ally" => 5,
                _ => 600,
            };
            let description = if attack {
                "Манёвр мастера боевых искусств: одна из атак действия «Атака»; кость превосходства тратится только при попадании."
            } else {
                "Манёвр мастера боевых искусств; расходует кость превосходства."
            };
            action(
                id,
                name,
                json!({
                    "actionType": action_type,
                    "target": target,
                    "range": range,
                    "minimumLevel": 3,
                    "resource": "superiority_dice",
                    "requiresWeapon": attack,
                    "description": description,
                    "effect": effect,
                }),
            )
        })
        .collect()
});

/// Исполнимые умения подклассов под id каталога dnd.su — тем же, под которым
/// у них рисунок; каталожная запись с тем же id из списка уходит. Профиль
/// задан по PHB 2014, в духе BG3. Ключ — `normalizedName(подкласс)`.
static SUBCLASS_ACTIONS: LazyLock<Vec<(String, Vec<Value>)>> = LazyLock::new(|| {
    vec![
        (normalized_text("Путь берсерка"), vec![
            action("barbarian-put-berserka-beshenstvo", "Бешенство", json!({"target":"enemy","actionType":"bonus_action","range":5,"minimumLevel":3,"requiresWeapon":true,"requiresCondition":"raging","description":"В ярости — бонусным действием ещё одна атака оружием ближнего боя (как в BG3; истощения после ярости нет).","effect":{"kind":"weapon_attack","attacks":1}})),
        ]),
        (normalized_text("Клятва преданности"), vec![
            action("paladin-klyatva-predannosti-bozhestvennyy-kanal", "Священное оружие", json!({"target":"self","minimumLevel":3,"resource":"channel_divinity","description":"Божественный канал: на минуту оружие светится, считается магическим и прибавляет модификатор Харизмы (не меньше +1) к броскам атаки.","effect":{"kind":"condition","condition":"sacred-weapon","duration":"rounds:10"}})),
        ]),
        (normalized_text("Круг луны"), vec![
            action("wild-shape", "Дикая форма", json!({"actionType":"bonus_action","minimumLevel":2,"resource":"wild_shape","description":"Боевой дикий облик: бонусным действием принять облик зверя (ПО 1 со 2-го уровня, с 6-го — уровень / 3): его хиты, КД, скорость и атака. Повторно — вернуться в свой облик. В облике нельзя колдовать.","effect":{"kind":"wild_shape"}})),
            action("druid-krug-luny-boevoy-dikiy-oblik", "Целебный облик", json!({"actionType":"bonus_action","minimumLevel":2,"description":"В диком облике бонусным действием потратить ячейку заклинаний и восстановить 1к8 хитов за каждый её круг.","effect":{"kind":"wild_shape_heal"}})),
        ]),
        (normalized_text("Коллегия знаний"), vec![
            action("bard-kollegiya-znaniy-ostroe-slovtso", "Острое словцо", json!({"actionType":"reaction","target":"self","minimumLevel":3,"resource":"bardic_inspiration","description":"Реакцией, когда враг в 60 футах попадает броском атаки по герою, вычесть из броска кость Вдохновения барда — удар может сорваться. Тратит одно Вдохновение.","effect":{"kind":"ally_attack_reaction","reaction":"cutting-words"}})),
        ]),
        (normalized_text("Путь открытой ладони"), vec![
            action("monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni", "Шквал открытой ладони", json!({"target":"enemy","actionType":"bonus_action","range":5,"minimumLevel":3,"resource":"ki","description":"Шквал ударов: 1 ци, две безоружные атаки; каждое попадание — спасбросок Ловкости против СЛ ци, иначе цель сбита с ног.","effect":{"kind":"weapon_attack","attacks":2,"unarmed":true,"saveAbility":"dex","saveDcAbility":"wis","condition":"prone","conditionDuration":"none"}})),
        ]),
    ]
});

fn subclass_actions(subclass: Option<&str>) -> &'static [Value] {
    let key = normalized_text(subclass.unwrap_or(""));
    SUBCLASS_ACTIONS.iter().find(|(name, _)| *name == key).map(|(_, actions)| actions.as_slice()).unwrap_or(&[])
}

/// Боевой стиль «Оборона» (PHB 2014): реакцией, со щитом, помеха на атаку
/// врага по союзнику в 5 футах; каталожная «Защита» dnd.su — то же id.
static PROTECTION_STYLE_ACTIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    ["fighter", "paladin"]
        .into_iter()
        .map(|class_key| {
            action(
                &format!("{class_key}-zaschita"),
                "Оборона",
                json!({
                    "actionType": "reaction",
                    "target": "self",
                    "minimumLevel": if class_key == "fighter" { 1 } else { 2 },
                    "description": "Реакцией, когда враг атакует союзника в 5 футах от вас, наложить помеху на бросок. Нужен щит в руке.",
                    "effect": { "kind": "ally_attack_reaction", "reaction": "protection" },
                }),
            )
        })
        .collect()
});

/// Каталожная «шапка» умения, чей запас уже ведёт curated-пул под другим
/// именем: «Божественный канал» dnd.su — счётчик «Изгнания нежити» и
/// «Божественной искры», которые тратят `channel_divinity`.
const GENERATED_POOLS_OWNED_BY_CURATED: [(&str, &str); 1] = [("cleric-bozhestvennyy-kanal", "channel_divinity")];

/// Каталожные умения, которые Rules Engine играет пассивно: плитки у них нет
/// («Добыча охотника» — «Убийца колоссов», лишняя к8 по раненой цели раз в ход).
const PASSIVE_GENERATED_ACTION_IDS: [&str; 1] = ["ranger-ohotnik-dobycha-ohotnika"];

/// Каталожные умения, сыгранные пассивно (без плитки действия).
pub fn passive_class_feature_ids() -> Vec<String> {
    PASSIVE_GENERATED_ACTION_IDS.iter().map(|id| id.to_string()).collect()
}

/// `roleText(actor)`: роль, класс и `characterClass` одной строкой в нижнем регистре.
fn role_text(actor: Option<&Value>) -> String {
    let part = |key: &str| js::s(prop(actor, key));
    text::lower(&format!("{} {} {}", part("role"), part("class"), part("characterClass")))
}

/// Класс героя по роли, полю класса и `characterClass` (`actorClass`).
fn actor_class(actor: Option<&Value>) -> Option<&'static str> {
    let role = role_text(actor);
    let patterns: [(&str, &sk_core::fancy_regex::Regex); 12] = [
        ("barbarian", re!(r"варвар|barbarian", "u")),
        ("bard", re!(r"бард|bard", "u")),
        ("cleric", re!(r"жрец|cleric", "u")),
        ("druid", re!(r"друид|druid", "u")),
        ("fighter", re!(r"воин|fighter", "u")),
        ("monk", re!(r"монах|monk", "u")),
        ("paladin", re!(r"паладин|paladin", "u")),
        ("ranger", re!(r"следопыт|ranger", "u")),
        ("rogue", re!(r"плут|разбойник|rogue", "u")),
        ("sorcerer", re!(r"чарод|sorcer", "u")),
        ("warlock", re!(r"колдун|warlock", "u")),
        ("wizard", re!(r"волшеб|wizard|маг\b", "u")),
    ];
    patterns.into_iter().find(|(_, pattern)| text::test(pattern, &role)).map(|(key, _)| key)
}

/// Подкласс героя по выбору или по словам роли (`actorSubclass`).
fn actor_subclass(actor: Option<&Value>, class_key: Option<&str>) -> Option<String> {
    let selected = normalized_name(nullish(nullish(prop(actor, "subclass"), prop(actor, "subClass")), prop(actor, "archetype")));
    let catalog = generated_class(class_key)?;
    let subclasses = array(catalog.get("subclasses"));
    let name_of = |entry: &Value| defined(entry.get("name")).map(|name| jsv::string(Some(name)));
    if !selected.is_empty() {
        return subclasses
            .iter()
            .find(|entry| normalized_name(entry.get("id")) == selected || normalized_name(entry.get("name")) == selected)
            .and_then(name_of);
    }
    let role = normalized_text(&role_text(actor));
    subclasses.iter().find(|entry| role.contains(&normalized_name(entry.get("name")))).and_then(name_of)
}

fn generated_actions_for(class_key: Option<&str>, subclass: Option<&str>) -> Vec<Value> {
    let Some(catalog) = generated_class(class_key) else {
        return Vec::new();
    };
    let selected = normalized_text(subclass.unwrap_or(""));
    array(catalog.get("actions"))
        .iter()
        .filter(|entry| !js::truthy(entry.get("subclass")) || normalized_name(entry.get("subclass")) == selected)
        .map(|entry| {
            let mut card = entry.as_object().cloned().unwrap_or_default();
            let special = is_str(jsv::path(entry.get("effect"), &["kind"]), "special");
            card.insert("mechanicsSupport".into(), Value::from(if special { "ruling-only" } else { "heuristic" }));
            if js::truthy(entry.get("uses")) {
                card.insert("resource".into(), Value::from(format!("feature_{}", jsv::string(entry.get("id")))));
                card.insert("cost".into(), Value::from(1));
            } else {
                card.shift_remove("resource");
                card.shift_remove("cost");
            }
            Value::Object(card)
        })
        .collect()
}

/// Подклассы класса героя из каталога.
pub fn combat_subclass_options_for(actor: Option<&Value>) -> Vec<Value> {
    generated_class(actor_class(actor)).map(|catalog| array(catalog.get("subclasses")).to_vec()).unwrap_or_default()
}

/// Подкласс героя, если уровень уже его открыл; иначе `None`.
pub fn normalized_combat_subclass_for(actor: Option<&Value>) -> Option<String> {
    let class_key = actor_class(actor);
    let catalog = generated_class(class_key)?;
    let level = bounded_level(actor);
    let subclass_level = js::number(Some(defined(catalog.get("subclassLevel")).unwrap_or(&Value::from(1))));
    if level < subclass_level {
        return None;
    }
    actor_subclass(actor, class_key)
}

fn feature_selected(actor: Option<&Value>, id: Option<&Value>) -> bool {
    is_optional_feature_selected(actor, id)
}

fn curated_actions_for(actor: Option<&Value>, class_key: Option<&str>, subclass: Option<&str>) -> Vec<&'static Value> {
    // Умение подкласса с тем же id заменяет умение класса (Боевой дикий облик
    // Круга луны — та же «Дикая форма», только бонусным действием).
    let subclass_list = subclass_actions(subclass);
    let subclass_ids: Vec<&Value> = subclass_list.iter().filter_map(|entry| entry.get("id")).collect();
    let Some(class_key) = class_key else {
        return Vec::new();
    };
    let mut curated: Vec<&'static Value> = class_actions(class_key).iter().filter(|entry| !subclass_ids.iter().any(|id| Some(*id) == entry.get("id"))).collect();
    if class_key == "fighter" && normalized_text(subclass.unwrap_or("")) == normalized_text("Мастер боевых искусств") {
        curated.extend(MANEUVERS.iter());
    }
    curated.extend(subclass_list.iter());
    curated.into_iter().filter(|entry| feature_selected(actor, entry.get("id"))).collect()
}

fn curated_action_names_for(curated: &[&Value]) -> IndexSet<String> {
    curated.iter().map(|entry| normalized_name(entry.get("name"))).collect()
}

fn generated_pool_superseded(entry: &Value, curated_names: &IndexSet<String>) -> bool {
    curated_names.contains(&normalized_name(entry.get("name"))) || GENERATED_POOLS_OWNED_BY_CURATED.iter().any(|(id, _)| is_str(entry.get("id"), id))
}

/// Каталожные пулы, заменённые реализованными действиями, — по той же
/// политике, что и список [`combat_actions_for`].
pub fn superseded_feature_resource_ids_for(actor: Option<&Value>) -> Vec<String> {
    let class_key = actor_class(actor);
    let subclass = actor_subclass(actor, class_key);
    let curated_names = curated_action_names_for(&curated_actions_for(actor, class_key, subclass.as_deref()));
    generated_actions_for(class_key, subclass.as_deref())
        .iter()
        .filter(|entry| js::truthy(entry.get("uses")) && generated_pool_superseded(entry, &curated_names))
        .map(|entry| format!("feature_{}", jsv::string(entry.get("id"))))
        .collect()
}

/// Сводка каталога действий классов.
pub fn combat_class_catalog_info() -> Value {
    let classes: Vec<Value> = array(CATALOG.get("classes"))
        .iter()
        .map(|entry| {
            let mut class = Map::new();
            for key in ["classKey", "label", "sourceUrl", "subclassLevel"] {
                if let Some(value) = entry.get(key) {
                    class.insert(key.into(), value.clone());
                }
            }
            let subclasses = array(entry.get("subclasses"));
            class.insert("subclassOptions".into(), Value::Array(subclasses.to_vec()));
            class.insert("subclasses".into(), Value::from(subclasses.len()));
            class.insert("actions".into(), Value::from(array(entry.get("actions")).len()));
            if let Some(coverage) = entry.get("coverage") {
                class.insert("coverage".into(), coverage.clone());
            }
            Value::Object(class)
        })
        .collect();
    let mut info = Map::new();
    for key in ["rulesProfile", "maximumCharacterLevel"] {
        if let Some(value) = CATALOG.get(key) {
            info.insert(key.into(), value.clone());
        }
    }
    info.insert("classes".into(), Value::Array(classes));
    Value::Object(info)
}

/// Уровень 1–12; дробный уровень JS сохраняет.
fn bounded_level(actor: Option<&Value>) -> f64 {
    jsv::max2(1.0, jsv::min2(12.0, jsv::number_or(prop(actor, "level"), 1.0)))
}

/// `level >= entry.minimumLevel` по правилам JS (`NaN` — нет).
fn meets_level(level: f64, entry: &Value) -> bool {
    level >= js::number(entry.get("minimumLevel"))
}

fn breath_weapon_action(actor: Option<&Value>) -> Option<Value> {
    let mechanics = jsv::path(actor, &["speciesBenefits", "mechanics"]);
    let ancestry = prop(mechanics, "dragon_ancestry").filter(|ancestry| js::truthy(Some(ancestry)));
    if !js::is_true(prop(mechanics, "breath_weapon")) {
        return None;
    }
    let ancestry = ancestry?;
    let field = |key: &str| prop(Some(ancestry), key);
    let shape = if is_str(field("shape"), "line") { "линия" } else { "конус" };
    let mut effect = Map::new();
    effect.insert("kind".into(), Value::from("species_breath"));
    for (target, key) in [("shape", "shape"), ("distanceFeet", "distance_feet"), ("damageType", "damage_type")] {
        if let Some(value) = field(key) {
            effect.insert(target.into(), value.clone());
        }
    }
    effect.insert("saveAbility".into(), defined(field("save_ability")).cloned().unwrap_or_else(|| Value::from("dex")));
    // `sourceUrl` вида может отсутствовать: место ключа в карточке JS держит
    // и `undefined`, а выдача ниже его заполняет.
    let source_url = jsv::path(actor, &["speciesBenefits", "source_url"]).cloned().unwrap_or(Value::Null);
    Some(action(
        "breath-weapon",
        "Оружие дыхания",
        json!({
            "category": "class",
            "target": "enemy",
            "range": num(jsv::max2(5.0, jsv::number_or(field("distance_feet"), 15.0))),
            "resource": "species_breath_weapon",
            "mechanicsSupport": "verified",
            "sourceUrl": source_url,
            "description": format!("{}: {shape} {} футов, спасбросок Ловкости, половина урона при успехе.", jsv::string(field("label")), jsv::string(field("distance_feet"))),
            "effect": Value::Object(effect),
        }),
    ))
}

/// Боевые действия героя: общие, класса и подкласса, вида.
pub fn combat_actions_for(actor: Option<&Value>) -> Vec<Value> {
    let level = bounded_level(actor);
    let class_key = actor_class(actor);
    let subclass = actor_subclass(actor, class_key);
    let protection_id = format!("{}-zaschita", class_key.unwrap_or("null"));
    let mut curated = curated_actions_for(actor, class_key, subclass.as_deref());
    if feature_selected(actor, Some(&Value::from("fighting-style-protection"))) {
        curated.extend(PROTECTION_STYLE_ACTIONS.iter().filter(|entry| is_str(entry.get("id"), &protection_id) && meets_level(level, entry)));
    }
    let curated_names = curated_action_names_for(&curated);
    let curated_ids: Vec<&Value> = curated.iter().filter_map(|entry| entry.get("id")).collect();
    let generated: Vec<Value> = if class_key.is_some() {
        generated_actions_for(class_key, subclass.as_deref())
            .into_iter()
            .filter(|entry| {
                let id = entry.get("id");
                !is_str(entry.get("actionType"), "free")
                    && !PASSIVE_GENERATED_ACTION_IDS.iter().any(|passive| is_str(id, passive))
                    && !PROTECTION_STYLE_ACTIONS.iter().any(|style| jsv::strict_eq(style.get("id"), id))
                    && feature_selected(actor, id)
                    && !curated_names.contains(&normalized_name(entry.get("name")))
                    && !curated_ids.iter().any(|curated_id| jsv::strict_eq(Some(*curated_id), id))
            })
            .collect()
    } else {
        Vec::new()
    };
    let species: Vec<Value> = breath_weapon_action(actor).into_iter().collect();
    let holds_off_hand_weapon = array(prop(actor, "inventory")).iter().any(|item| js::is_true(item.get("equipped")) && is_str(item.get("equipped_slot"), "off_hand"));
    let entries = COMMON_ACTIONS.iter().chain(curated.iter().copied()).chain(generated.iter()).chain(species.iter());
    entries
        .filter(|entry| meets_level(level, entry))
        .filter(|entry| !js::truthy(entry.get("requiresOffHandWeapon")) || holds_off_hand_weapon)
        .map(|entry| {
            let mut card = entry.as_object().cloned().unwrap_or_default();
            let source_url = match defined(entry.get("sourceUrl")) {
                Some(url) => url.clone(),
                None => Value::from(class_url(class_key).unwrap_or("https://www.dnd.su/articles/actions-in-combat/")),
            };
            card.insert("sourceUrl".into(), source_url);
            card.insert("exploration".into(), Value::from(exploration_use_for(Some(entry))));
            // Звери Дикого облика, доступные друиду по кругу и уровню: панель
            // даёт выбрать, Rules Engine сверяет `form_id` тем же списком.
            if is_str(jsv::path(entry.get("effect"), &["kind"]), "wild_shape") {
                let forms: Vec<Value> = wild_shape_forms_for(actor)
                    .into_iter()
                    .map(|form| json!({ "id": form.id, "name": form.name, "challenge_rating": num(form.challenge_rating), "hp": num(form.hp), "armor": num(form.armor) }))
                    .collect();
                card.insert("forms".into(), Value::Array(forms));
            }
            Value::Object(card)
        })
        .collect()
}

/// Эффекты, у которых нет смысла без хода: лишняя скорость, второе действие и
/// заготовка живут ровно до конца хода, а хода вне боя нет.
const TURN_BOUND_EFFECT_KINDS: [&str; 4] = ["dash", "restore_action", "ready_action", "special"];

/// Чем действие становится вне боя, в режиме исследования:
///
/// - `opens-combat` — действие против противника: нападение начинается с
///   инициативы, удар исполняется, только если нападающий ходит первым;
/// - `allowed` — мирное действие с лечением, проверкой или эффектом, который
///   переживает ход;
/// - `combat-only` — реакция или эффект, привязанный к ходу.
pub fn exploration_use_for(entry: Option<&Value>) -> &'static str {
    let Some(entry) = entry.filter(|entry| js::truthy(Some(entry))) else {
        return "combat-only";
    };
    if is_str(entry.get("actionType"), "reaction") {
        return "combat-only";
    }
    if is_str(entry.get("target"), "enemy") {
        return "opens-combat";
    }
    let effect = defined(entry.get("effect"));
    let kind = js::s(prop(effect, "kind"));
    if TURN_BOUND_EFFECT_KINDS.contains(&kind.as_str()) {
        return "combat-only";
    }
    let duration = jsv::string(Some(defined(prop(effect, "duration")).unwrap_or(&Value::from("until-next-turn"))));
    if is_str(prop(effect, "kind"), "condition") && duration == "until-next-turn" {
        return "combat-only";
    }
    "allowed"
}

/// Действие героя по id или `None`.
pub fn combat_action_for(actor: Option<&Value>, action_id: Option<&Value>) -> Option<Value> {
    let id = js::s(action_id);
    combat_actions_for(actor).into_iter().find(|entry| is_str(entry.get("id"), &id))
}

/// Сколько атак оружием стоит одно действие «Атака»: «Дополнительная атака» —
/// свойство действия, число берётся из той же карточки.
pub fn weapon_attacks_per_action_for(actor: Option<&Value>) -> f64 {
    let level = bounded_level(actor);
    let Some(extra) = combat_action_for(actor, Some(&Value::from("extra-attack"))) else {
        return 1.0;
    };
    if level < js::number(Some(defined(extra.get("minimumLevel")).unwrap_or(&Value::from(1)))) {
        return 1.0;
    }
    let effect = extra.get("effect");
    let mut tiers: Vec<(&String, &Value)> = match defined(prop(effect, "attacksByLevel")) {
        Some(Value::Object(map)) => js::entries(map),
        _ => Vec::new(),
    };
    tiers.sort_by(|(left, _), (right, _)| {
        let difference = js::parse_number(right) - js::parse_number(left);
        difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let tier = tiers.into_iter().find(|(minimum, _)| level >= js::parse_number(minimum));
    let attacks = match tier {
        Some((_, attacks)) => js::number(Some(attacks)),
        None => js::number(Some(defined(prop(effect, "attacks")).unwrap_or(&Value::from(1)))),
    };
    jsv::max2(1.0, jsv::min2(4.0, attacks))
}

/// Флаг таблицы запасов для состояния кампании (`classResourceOptionsFor`):
/// маркер политики 2024 в `enabled_house_rules` и редакция не 2014.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClassResourceOptions {
    pub class_resources_2024: bool,
}

impl ClassResourceOptions {
    /// Форма JS.
    pub fn to_value(self) -> Value {
        json!({ "classResources2024": self.class_resources_2024 })
    }
}

/// Флаг таблицы запасов для состояния кампании.
pub fn class_resource_options_for(state: Option<&Value>) -> ClassResourceOptions {
    let policies: Vec<String> = array(prop(state, "enabled_house_rules")).iter().map(|policy| jsv::string(Some(policy))).collect();
    ClassResourceOptions {
        class_resources_2024: js::s(prop(state, "ruleset_id")) != DND_2014_RULESET_ID && policies.iter().any(|policy| policy == CLASS_RESOURCES_2024_POLICY_ID),
    }
}

/// Восстановление «один заряд за короткий отдых, все — за продолжительный».
/// Отличается от `short_or_long`, который за короткий отдых возвращает всё.
pub const ONE_ON_SHORT_REST: &str = "one_short_all_long";

/// Врождённые заклинания вида и черт: `[...innate_spells, ...creationSpellGrants]`.
fn innate_spell_entries(actor: Option<&Value>) -> Vec<Value> {
    let mut entries = jsv::spread_items(jsv::path(actor, &["speciesBenefits", "innate_spells"]).filter(|value| value.is_array()));
    entries.extend(jsv::spread_items(prop(actor, "creationSpellGrants")));
    entries
}

/// Максимумы запасов класса, умений каталога, врождённых заклинаний и оружия
/// дыхания: `{ ресурс: максимум }`.
pub fn combat_resource_maximums_for(actor: Option<&Value>, options: ClassResourceOptions) -> Value {
    let modern = options.class_resources_2024;
    let level = bounded_level(actor);
    let class_key = actor_class(actor);
    let subclass = actor_subclass(actor, class_key);
    let curated_names = curated_action_names_for(&curated_actions_for(actor, class_key, subclass.as_deref()));
    let proficiency = 2.0 + ((level - 1.0) / 4.0).floor();
    let mut resources = Map::new();
    let mut set = |key: &str, value: f64| {
        resources.insert(key.into(), num(value));
    };
    let cha = jsv::path(actor, &["abilities", "cha"]);
    let cha_modifier = || ((js::number(cha) - 10.0) / 2.0).floor();
    match class_key {
        Some("barbarian") => set("rage", if level >= 12.0 { 5.0 } else if level >= 6.0 { 4.0 } else if level >= 3.0 { 3.0 } else { 2.0 }),
        Some("bard") => set("bardic_inspiration", jsv::max2(1.0, if js::truthy(cha) { cha_modifier() } else { 1.0 })),
        _ => {}
    }
    if class_key == Some("cleric") && level >= 2.0 {
        set(
            "channel_divinity",
            if modern {
                if level >= 18.0 {
                    4.0
                } else if level >= 6.0 {
                    3.0
                } else {
                    2.0
                }
            } else if level >= 6.0 {
                2.0
            } else {
                1.0
            },
        );
    }
    if class_key == Some("druid") && level >= 2.0 {
        set("wild_shape", if modern { if level >= 17.0 { 4.0 } else if level >= 6.0 { 3.0 } else { 2.0 } } else { 2.0 });
    }
    if class_key == Some("fighter") {
        set("second_wind", if modern { if level >= 10.0 { 4.0 } else if level >= 4.0 { 3.0 } else { 2.0 } } else { 1.0 });
        if level >= 2.0 {
            set("action_surge", 1.0);
        }
        if level >= 9.0 {
            set("indomitable", 1.0);
        }
        if level >= 3.0
            && normalized_text(subclass.as_deref().unwrap_or("")) == normalized_text("Мастер боевых искусств")
            && MANEUVERS.iter().any(|entry| feature_selected(actor, entry.get("id")))
        {
            set("superiority_dice", if level >= 7.0 { 5.0 } else { 4.0 });
        }
    }
    if class_key == Some("monk") && level >= 2.0 {
        set("ki", level);
    }
    if class_key == Some("paladin") {
        set("divine_sense", jsv::max2(1.0, if js::truthy(cha) { cha_modifier() + 1.0 } else { 1.0 }));
        set("lay_on_hands", level * 5.0);
        // Божественный канал клятвы — с 3-го уровня, один на короткий отдых.
        if level >= 3.0 {
            set("channel_divinity", 1.0);
        }
    }
    if class_key == Some("ranger") {
        set("favored_foe", proficiency);
    }
    if class_key == Some("sorcerer") && level >= 2.0 {
        set("sorcery_points", level);
    }
    if class_key == Some("wizard") {
        set("arcane_recovery", 1.0);
    }
    for entry in generated_actions_for(class_key, subclass.as_deref()) {
        if !js::truthy(entry.get("uses")) || level < js::number(entry.get("minimumLevel")) || generated_pool_superseded(&entry, &curated_names) {
            continue;
        }
        let maximum_raw = jsv::path(entry.get("uses"), &["maximum"]);
        let maximum_text = jsv::string(maximum_raw);
        let maximum = if is_str(maximum_raw, "proficiency") {
            proficiency
        } else if let Some(ability) = maximum_text.strip_prefix("ability:") {
            jsv::max2(1.0, ((js::number(prop(prop(actor, "abilities"), ability)) - 10.0) / 2.0).floor())
        } else {
            jsv::max2(1.0, jsv::number_or(maximum_raw, 1.0))
        };
        set(&format!("feature_{}", jsv::string(entry.get("id"))), maximum);
    }
    for spell in innate_spell_entries(actor) {
        let spell = Some(&spell);
        if level < jsv::max2(1.0, jsv::number_or(prop(spell, "minimum_level"), 1.0)) {
            continue;
        }
        let uses = js::number(prop(spell, "uses"));
        if uses.is_finite() && uses > 0.0 {
            set(&format!("species_spell_{}", jsv::string(prop(spell, "id"))), jsv::max2(1.0, uses.trunc()));
        }
    }
    if js::is_true(jsv::path(actor, &["speciesBenefits", "mechanics", "breath_weapon"])) {
        set("species_breath_weapon", 1.0);
    }
    Value::Object(resources)
}

/// Серверное расписание восстановления запасов: максимумы и сроки живут
/// вместе, чтобы отдых не вернул пул только потому, что клиент его назвал.
pub fn combat_resource_recovery_for(actor: Option<&Value>, options: ClassResourceOptions) -> Value {
    let modern = options.class_resources_2024;
    let level = bounded_level(actor);
    let class_key = actor_class(actor);
    let subclass = actor_subclass(actor, class_key);
    let curated_names = curated_action_names_for(&curated_actions_for(actor, class_key, subclass.as_deref()));
    let mut recovery = Map::new();
    let mut set = |key: &str, value: &str| {
        recovery.insert(key.into(), Value::from(value));
    };
    let one_or = |fallback: &'static str| if modern { ONE_ON_SHORT_REST } else { fallback };
    if class_key == Some("barbarian") {
        set("rage", one_or("long"));
    }
    if class_key == Some("bard") {
        set("bardic_inspiration", if level >= 5.0 { "short_or_long" } else { "long" });
    }
    if class_key == Some("cleric") && level >= 2.0 {
        set("channel_divinity", one_or("short_or_long"));
    }
    if class_key == Some("paladin") && level >= 3.0 {
        set("channel_divinity", "short_or_long");
    }
    if class_key == Some("druid") && level >= 2.0 {
        set("wild_shape", one_or("short_or_long"));
    }
    if class_key == Some("fighter") {
        set("second_wind", one_or("short_or_long"));
        if level >= 2.0 {
            set("action_surge", "short_or_long");
        }
        if level >= 9.0 {
            set("indomitable", "long");
        }
        if level >= 3.0 && normalized_text(subclass.as_deref().unwrap_or("")) == normalized_text("Мастер боевых искусств") {
            set("superiority_dice", "short_or_long");
        }
    }
    if class_key == Some("monk") && level >= 2.0 {
        set("ki", "short_or_long");
    }
    if class_key == Some("paladin") {
        set("divine_sense", "long");
        set("lay_on_hands", "long");
    }
    if class_key == Some("ranger") {
        set("favored_foe", "long");
    }
    if class_key == Some("sorcerer") && level >= 2.0 {
        set("sorcery_points", "long");
    }
    if class_key == Some("wizard") {
        set("arcane_recovery", "long");
    }
    for entry in generated_actions_for(class_key, subclass.as_deref()) {
        if !js::truthy(entry.get("uses")) || level < js::number(entry.get("minimumLevel")) || generated_pool_superseded(&entry, &curated_names) {
            continue;
        }
        let short = is_str(jsv::path(entry.get("uses"), &["recovery"]), "short_or_long");
        set(&format!("feature_{}", jsv::string(entry.get("id"))), if short { "short_or_long" } else { "long" });
    }
    for spell in innate_spell_entries(actor) {
        let spell = Some(&spell);
        if level < jsv::max2(1.0, jsv::number_or(prop(spell, "minimum_level"), 1.0)) {
            continue;
        }
        let uses = js::number(prop(spell, "uses"));
        if uses.is_finite() && uses > 0.0 {
            set(&format!("species_spell_{}", jsv::string(prop(spell, "id"))), "long");
        }
    }
    if js::is_true(jsv::path(actor, &["speciesBenefits", "mechanics", "breath_weapon"])) {
        set("species_breath_weapon", "short_or_long");
    }
    Value::Object(recovery)
}
