//! Перенос `server/intent-parser.mjs` — разбор свободного ввода игрока в
//! намерение: вид заявки (действие, вопрос ведущему, разговор за столом),
//! намерение и подход, цели и собеседники сцены, названное заклинание,
//! порядок шагов и ожидание до часа суток.
//!
//! Детерминированный модуль без модели (AGENTS.md §4): ввод приходит из
//! недоверенного клиента, а режим заявки — только маршрутизация, он не даёт
//! права выполнить команду и не меняет механику.
//!
//! Регулярные выражения скопированы из JS без правок и переводятся
//! `sk_core::text::js_regex_source` (`\b`, `\w`, `\d` — ASCII, как в JS).
//! Длины и обрезка строк — в единицах UTF-16, как в JS.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::fancy_regex::{Regex, RegexBuilder};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, text};
use sk_attention::scenario_attention::{scenario_armory_action_from_text, scenario_informant_action_from_text, scenario_purse_action_from_text, scenario_treaty_action_from_text};
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_items::item_catalog::catalog_item;
use sk_scenario::campaign_scenario::{scenario_armory_rules, scenario_informant_rules};
use sk_scenario::party_exit_intent::announces_movement;
use sk_social::npc_social_check::{affirmative_action_text, classify_npc_social_check};
use sk_world_story::scenario_knight::scenario_knight_action_from_text;

use crate::support::{head_utf16, prototype_string, utf16_len};

/// Предел возвратов движка: у `fancy_regex` по умолчанию миллион, и на длинном
/// мусоре шаблон «вернул бы» «нет» там, где JS находит совпадение.
const BACKTRACK_LIMIT: usize = 200_000_000;

fn compile(pattern: &str, flags: &str) -> Regex {
    RegexBuilder::new(&text::js_regex_source(pattern, flags)).backtrack_limit(BACKTRACK_LIMIT).build().expect("регулярное выражение")
}

/// Регулярное выражение JS, собранное один раз (`sk_core::re!` с большим
/// пределом возвратов).
macro_rules! jre {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| compile($pattern, $flags));
        &*RE
    }};
}

/// Начало слова: `(?<![\p{L}\p{M}])`.
macro_rules! w {
    () => {
        r"(?<![\p{L}\p{M}])"
    };
}

macro_rules! corpse_verb {
    () => {
        r"(?<![\p{L}\p{M}])(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)"
    };
}
macro_rules! corpse_noun {
    () => {
        r"(?<![\p{L}\p{M}])(?:труп(?:а|у|ом|е|ы|ов|ам|ами|ах)?|тел(?:о|а|у|ом|е|ам|ами|ах)?|остан(?:ки|ков|кам|ками|ках)|карман(?:а|у|ом|е|ы|ов|ам|ами|ах)?)(?![\p{L}\p{M}])"
    };
}

const CORPSE_SEARCH: &str = concat!("(?:", corpse_verb!(), r")[^.!?]{0,80}(?:", corpse_noun!(), ")|(?:", corpse_noun!(), r")[^.!?]{0,80}(?:", corpse_verb!(), ")");
const PHYSICALLY_IMPOSSIBLE: &str = r"(взлет\w*|взлета\w*|парю\w*|телепорт\w*|останавлива\w*\s+время|дыш\w*\s+под\s+водой|становлюсь\s+невидим\w*|путешеств\w*\s+во\s+времени|fly\b|teleport\w*|stop\s+time|breathe\s+underwater)";
const BOUNDED_SCENE_ACTION: &str = r"(подпира\w*|баррикад\w*|поджига\w*|зажига\w*|зову\w*\s+страж|крич\w*\s+страж|связыва\w*|прячу\w*\s+след\w*|заслоня\w*)";

fn free_action_patterns() -> [(&'static str, &'static Regex); 3] {
    [
        ("physically_impossible", jre!(PHYSICALLY_IMPOSSIBLE, "iu")),
        ("bounded_scene_action", jre!(BOUNDED_SCENE_ACTION, "iu")),
        ("corpse_search", jre!(CORPSE_SEARCH, "iu")),
    ]
}

/// Виды заявки.
pub const REQUEST_KINDS: [&str; 3] = ["action", "question", "discussion"];

/// Ввод игрока приходит из недоверенного клиента. Режим заявки — это только
/// маршрутизация: он не даёт права выполнить команду и не меняет механику.
pub fn normalize_request_kind(value: Option<&Value>) -> &'static str {
    let kind = text::lower(text::trim(&js::s(value)));
    REQUEST_KINDS.iter().copied().find(|entry| *entry == kind).unwrap_or("action")
}

fn direct_question() -> &'static Regex {
    jre!(r"^(?:а\s+если|если\s+(?:я|мы)(?=[^?]*\?\s*$)|что\s+если|можно\s+ли|могу\s+ли|есть\s+ли|как\s+далеко|что\s+будет|почему|зачем|где\s+(?:наход|стоит|леж)\p{L}*|кто\s+так|сколько|как\s+(?:это|мне|нам))(?:\s|$)", "iu")
}
fn interrogative_question() -> &'static Regex {
    jre!(r"^(?:какой|какая|какое|какие|каков\p{L}*|который|которая|которое|когда|сколько|кто|что|где|куда|откуда|почему|зачем|чей|чья|чьё|чьи|как)(?![\p{L}\p{M}])[^?]{0,200}\?+\s*$", "iu")
}
fn gm_explain() -> &'static Regex {
    jre!(r"^(?:поясни|поясните|объясни|объясните|расскажи|расскажите|напомни|напомните|подскажи|подскажите)(?:\s+(?:мне|нам))?[,\s]+(?:что\s+(?:это\s+)?за\s+мир|что\s+это\s+за\s+(?:место|мир)|где\s+(?:мы|я)(?:\s|$|[?.!])|что\s+(?:здесь|тут|сейчас)\s+происходит|что\s+(?:нам|мне)\s+(?:делать|нужно\s+делать)|какая\s+(?:у\s+нас\s+)?цель|как\s+(?:тут\s+)?играть)", "iu")
}
fn known_lore_question() -> &'static Regex {
    jre!(r"(?:что\s+(?:я|мы)\s+(?:уже\s+|вообще\s+)?зна|кто\s+так|что\s+так|помню\s+ли|помним\s+ли)", "iu")
}
fn second_person() -> &'static Regex {
    jre!(r"(?<![\p{L}\p{M}])(?:ты|вы|тебя|вас|тебе|вам|твой|твоя|твоё|ваш|ваша|ваше)(?![\p{L}\p{M}])", "iu")
}
/// Реплика вне игры: «(ooc) …», «((…))», «// вне игры».
fn out_of_character() -> &'static Regex {
    jre!(r"^(?:\(\(|\(\s*(?:ooc|оос|офф|офтоп|вне\s+игры)\s*\)|\/\/|(?:ooc|оос|офф)[:\s]|вне\s+игры[:,\s])", "iu")
}
fn party_address() -> &'static Regex {
    jre!(r"^(?:ребята|народ|друзья|парни|братцы|команда|отряд)[,!]\s", "iu")
}
fn party_company_question() -> &'static Regex {
    jre!(r"^(?:[\p{L}-]+,\s*)?(?:ты|вы)\s+(?:(?:идёшь|идешь|идёте|идете|пойдёшь|пойдешь|пойдёте|пойдете)\s+)?(?:со\s+мной|с\s+нами)(?:\s+[^?]{0,80})?\?\s*$", "iu")
}
fn scene_observation() -> &'static Regex {
    jre!(r"^(?:где\s+(?:я|мы)(?:\s+сейчас)?(?:\s+наход(?:имся|юсь))?(?:\s+сейчас)?|что\s+(?:я\s+)?вижу(?:\s+(?:здесь|вокруг|перед\s+собой))?|что\s+(?:здесь|вокруг)\s+есть|что\s+находится\s+(?:здесь|вокруг|перед\s+собой)|что\s+вокруг\s+(?:меня|нас)|кто\s+(?:здесь|рядом)|опиши\s+(?:сцену|место|обстановку))\s*[?!]?$", "iu")
}
fn party_proposal() -> &'static Regex {
    jre!(r"^(?:давайте|предлагаю(?=[\s,]*$|[\s,]+(?:нам|всем|вам|ребят\p{L}*|отряду|\p{L}+(?:ть|ться|ти|чь)(?![\p{L}\p{M}])))|может,?\s+(?:нам|мы)|стоит\s+(?:ли\s+)?нам)(?:[\s,]|$)", "iu")
}
fn leading_particle() -> &'static Regex {
    jre!(r"^(?:а|и|ну|так|слушай|скажи|подскажи(?:те)?)(?:\s+и)?[\s,]+", "iu")
}
fn explicit_npc_speech() -> &'static Regex {
    jre!(r"^(?:спрашиваю|спрашиваем|говорю|говорим|обращаюсь|обращаемся|прошу|просим)(?:\s|$)", "iu")
}
fn spoken_opening() -> &'static Regex {
    jre!(r"^(?:я\s+)?(?:расспрашиваю|расспрашиваем|разговариваю|разговариваем|беседую|беседуем|заговариваю|заговариваем|болтаю|болтаем|узна(?:ю|ём|ем)\s+у|интересу(?:юсь|емся)\s+у|здорова(?:юсь|емся)|приветствую|приветствуем|благодарю|благодарим|рассказываю|рассказываем|торгу(?:юсь|емся)|покупа(?:ю|ем)|прода(?:ю|ём|ем)|куплю|хочу\s+купить)(?![\p{L}\p{M}])", "iu")
}
fn inanimate_strike() -> &'static Regex {
    jre!(r"(?<![\p{L}\p{M}])(?:бью|ударяю|стучу|колочу)\s+(?:\p{L}+\s+)?по\s+(?:стол\p{L}*|стен\p{L}*|двер\p{L}*|пол[уе]|стойк\p{L}*|бочк\p{L}*|сундук\p{L}*)|(?<![\p{L}\p{M}])(?:рублю|перерубаю|разрубаю)\s+(?:\p{L}+\s+)?(?:верёвк|веревк|канат|цеп|трос)\p{L}*", "iu")
}
fn deception_word() -> &'static Regex {
    jre!(r"(?<![\p{L}\p{M}])(?:обман\p{L}*|лгу|лж[её]\p{L}*|солг\p{L}*|вру|врать|навр\p{L}*|совр\p{L}*|блеф\p{L}*|выдаю\s+себя|deceiv\p{L}*|lie|bluff\p{L}*)(?![\p{L}\p{M}])", "iu")
}
fn persuasion_false_friend() -> &'static Regex {
    jre!(r"(?<![\p{L}\p{M}])склоня(?:юсь|емся)(?![\p{L}\p{M}])", "iu")
}
fn action_like_group() -> &'static Regex {
    jre!(r"(?:покида|покин|уходим|уйти|маршрут|голосован|переговор|перемир|сдавайт)", "iu")
}
fn explicit_check() -> &'static Regex {
    jre!(r"(?<![\p{L}\p{M}])(?:проверк[ауи]|спасброс\p{L}*|check|save)(?![\p{L}\p{M}])|проверяю\s+(?:сил|ловк|мудр|интел|харизм|телослож|скрыт|атлет|акробат)", "iu")
}

/// `String(value ?? '').normalize('NFKC').trim().slice(0, 2000)`.
fn normalized_text(value: Option<&Value>) -> String {
    head_utf16(text::trim(&text::nfkc(&js::s(value))), 2000)
}

fn normalized_str(value: &str) -> String {
    head_utf16(text::trim(&text::nfkc(value)), 2000)
}

/// Безопасный fallback для клиентов, которые ещё не передают `request_kind`.
pub fn infer_request_kind(value: Option<&Value>) -> &'static str {
    let raw = normalized_text(value);
    let stripped = text::replace_first(leading_particle(), &raw, "");
    let text = if text::test(leading_particle(), &raw) && utf16_len(&stripped) >= 3 { stripped } else { raw.clone() };
    if text.is_empty() || text::test(explicit_npc_speech(), &text) || text::test(spoken_opening(), &text) {
        return "action";
    }
    if text::test(out_of_character(), &text) || text::test(party_company_question(), &text) {
        return "discussion";
    }
    if text::test(direct_question(), &text)
        || text::test(direct_question(), &raw)
        || text::test(scene_observation(), &text)
        || text::test(gm_explain(), &text)
        || text::test(gm_explain(), &raw)
    {
        return "question";
    }
    if text::test(interrogative_question(), &text) && !text::test(second_person(), &text) && !text::test(known_lore_question(), &text) {
        return "question";
    }
    // Предложение отряду куда-то пойти — заявка: дальше её рассудит карточка ухода
    // по карте мира.
    if (text::test(party_proposal(), &text) || text::test(party_address(), &text)) && !text::test(action_like_group(), &text) && !announces_movement(&text) {
        return "discussion";
    }
    "action"
}

/// Явный вопрос о видимой части текущей сцены, без проверки или траты хода.
pub fn is_scene_observation_request(value: Option<&Value>) -> bool {
    text::test(scene_observation(), &normalized_text(value))
}

/// Цель ожидания: минута суток по часам мира и подпись в родительном падеже.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitTarget {
    pub id: &'static str,
    pub minute: i64,
    pub label: &'static str,
}

impl WaitTarget {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "minute": self.minute, "label": self.label })
    }
}

fn wait_targets() -> [(WaitTarget, &'static Regex); 5] {
    [
        (WaitTarget { id: "midnight", minute: 0, label: "полуночи" }, jre!(r"полуноч", "iu")),
        (WaitTarget { id: "dawn", minute: 300, label: "рассвета" }, jre!(r"рассвет|утр[аео]|зар[иеюя]", "iu")),
        (WaitTarget { id: "noon", minute: 720, label: "полудня" }, jre!(r"полудн|полден", "iu")),
        (WaitTarget { id: "dusk", minute: 1_020, label: "вечера" }, jre!(r"закат|вечер|сумер", "iu")),
        (WaitTarget { id: "night", minute: 1_320, label: "ночи" }, jre!(r"ноч[иь]|темнот|стемне", "iu")),
    ]
}

const WAIT: &str = r"(?<![\p{L}\p{M}])(?:жд(?:ём|ем|у|ать|ёт|ут)|подожд\p{L}*|дожида\p{L}*|дождать\p{L}*|дождём\p{L}*|дождемся|выжида\p{L}*|пережида\p{L}*|переждать|караул\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,30}(?:полуноч|рассвет|утр[аео]|зар[иеюя]|полудн|полден|закат|вечер|сумер|ноч[иь]|темнот|стемне)";

fn wait_pattern() -> &'static Regex {
    jre!(WAIT, "iu")
}

/// Цель ожидания в тексте игрока или `None`: «ждём до полуночи» → полночь.
pub fn wait_target_from_text(value: Option<&Value>) -> Option<WaitTarget> {
    let text = normalized_text(value);
    if !text::test(wait_pattern(), &text) {
        return None;
    }
    wait_targets().into_iter().find(|(_, pattern)| text::test(pattern, &text)).map(|(target, _)| target)
}

fn intent_patterns() -> [(&'static str, &'static Regex); 17] {
    let [impossible, bounded, corpse] = free_action_patterns();
    [
        ("why", jre!(r"^\s*\/why\b", "i")),
        ("wait", wait_pattern()),
        ("attack", jre!(concat!(w!(), "(атак|удар|бью|стреля|выстрел|рублю|колю|attack|shoot|strike)"), "iu")),
        ("saving_throw", jre!(concat!(w!(), r"(спасброс|saving\s*throw|save)"), "iu")),
        ("improvised_action", impossible.1),
        ("improvised_action", bounded.1),
        ("improvised_action", corpse.1),
        // Внимательность и поиск названы прямо: «прислушиваюсь», «рассматриваю»,
        // «изучаю руны», «ищу следы». Только личные формы: инфинитив
        // «обыскать/изучить сундук» — команда пропса сцены.
        (
            "ability_check",
            jre!(
                concat!(w!(), r"(провер|пытаюсь|исслед|осматр|осмотр|рассматр|разгляд|высматр|прислуш|изуча|обыскива(?:ю|ем)|крадусь|взлом|убежд|выбираюсь|выплыв|плыву|тону|утоп|ищу\s+(?:\p{L}+\s+)?(?:след|улик|тайник|ловушк|подсказ|зацепк)|check|swim|drown)"),
                "iu"
            ),
        ),
        // Заклинание — раньше лечения: «накладываю заклинание Лечение ран».
        ("cast_spell", jre!(concat!(w!(), "(каст|заклин|сотвор|колду|spell)"), "iu")),
        ("healing", jre!(concat!(w!(), r"(леч|исцел|восстанов\p{L}*\s+хит|heal)"), "iu")),
        ("damage", jre!(r"(получает?\s+урон|нанести\s+урон|damage)", "iu")),
        ("start_combat", jre!(r"(начать\s+бой|инициатив|start\s+combat)", "iu")),
        ("end_combat", jre!(r"((законч|заверш|прекрат)\p{L}*\s+бой|бой\s+(окончен|заверш[её]н)|end\s+combat)", "iu")),
        ("end_turn", jre!(r"^\s*(заканчиваю\s+ход|конец\s+хода|end\s+turn)\s*[.!]?\s*$", "iu")),
        (
            "rest",
            jre!(concat!(w!(), r"(коротк\p{L}*\s+отдых|долг\p{L}*\s+отдых|привал|отдых|отдыха|отдохн(?:ём|ем|у)(?![\p{L}\p{M}])|передохн|передышк|rest)"), "iu"),
        ),
        (
            "social",
            jre!(
                concat!(w!(), r"(говор|убежд|обман|запуг|спраш|расспраш|переговор|разговарива|беседу|заговарива|здорова|приветству|благодар|рассказыва|узна\p{L}*\s+у|интересу\p{L}*\s+у|торгу(?:юсь|емся|ться)|флирт|кокетнича|очаровыва|подкуп|предлага\p{L}*\s+[^.!?]{0,60}(?:монет|деньг|серебр|золот|взятк)|купить\s+у|куплю\s+у|покупа\p{L}*\s+у|прода(?:ю|ём|ем|ть))"),
                "iu"
            ),
        ),
        ("explore", jre!(concat!(w!(), "(осматр|исслед|иду|двига|открыва|ищу|слуша)"), "iu")),
    ]
}

/// Вид свободного действия: составной манёвр, подход с атакой, невозможное,
/// действие в рамках сцены, обыск тела; `None` — обычное.
pub fn classify_free_action_kind(value: Option<&Value>) -> Option<&'static str> {
    classify_free_action_text(&normalized_text(value))
}

fn classify_free_action_text(text: &str) -> Option<&'static str> {
    // Удар после прыжка нельзя молча сократить до обычной атаки: заявка
    // содержит перемещение, которого одиночный эффект импровизации не исполняет.
    let leap = jre!(r"(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|спрыг|перескоч)", "iu");
    let strike = jre!(r"(?<![\p{L}\p{M}])(?:атак|удар|бью|бить|стреля|выстрел|рублю|колю|попасть\s+по|attack|shoot|strike)", "iu");
    if text::test(leap, text) && text::test(strike, text) {
        return Some("compound_maneuver");
    }
    if text::test(jre!(r"(?<![\p{L}\p{M}])(?:подхож|подой|подбег|подбеж|приближа|приближусь|добег|добеж|иду\s+к)", "iu"), text) && text::test(strike, text) {
        return Some(if text::test(jre!(r"(?<![\p{L}\p{M}])(?:стреля|выстрел|shoot)", "iu"), text) { "compound_ranged_attack" } else { "approach_attack" });
    }
    free_action_patterns().into_iter().find(|(_, pattern)| text::test(pattern, text)).map(|(kind, _)| kind)
}

/// `text.split(regex)` для шаблона без групп захвата и без пустых совпадений.
fn split(regex: &Regex, text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(text).filter_map(Result::ok) {
        if found.end() == found.start() {
            continue;
        }
        parts.push(text[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(text[last..].to_string());
    parts
}

/// Явный порядок шагов сохраняется до подтверждения; результат шага нельзя
/// угадать. Союз перед связкой («, а потом», «и затем») уходит вместе с ней.
pub fn action_sequence(value: Option<&Value>) -> Vec<String> {
    let text = normalized_text(value);
    let steps = jre!(r"\s*(?:[;.]\s*|,?\s+)(?:(?:а|и|но)\s+)?(?:затем|потом|после\s+этого)\s+", "iu");
    let first = jre!(r"^сначала\s+", "iu");
    let approach = jre!(r"^(?:подхожу|иду|приближаюсь)\s+к\s+", "iu");
    let approach_split = jre!(r"\s+и\s+(?=(?:спрашиваю|прошу|расспрашиваю|открываю|закрываю|передаю|сверяю)\s)", "iu");
    let watch_split = jre!(r"\s+и\s+(?=(?:смотр|наблюда|следи|следим|высматрива|глядим|гляжу|вглядыва|прислушива)\p{L}*\s)", "iu");
    let parts: Vec<String> = split(steps, &text)
        .into_iter()
        .map(|part| text::trim(&text::replace_first(first, &part, "")).to_string())
        .flat_map(|part| if text::test(approach, &part) { split(approach_split, &part) } else { vec![part] })
        // Ожидание с наблюдением — тоже два шага: время проходит, а что увидели
        // за эти часы, решает судья действий.
        .flat_map(|part| {
            let mut pieces = split(watch_split, &part);
            if pieces.len() == 2 && text::test(wait_pattern(), &pieces[0]) {
                let watch = pieces.pop().unwrap_or_default();
                let wait = pieces.pop().unwrap_or_default();
                vec![wait, watch]
            } else {
                vec![part]
            }
        })
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() > 1 && parts.len() <= 6 {
        parts
    } else {
        Vec::new()
    }
}

// ---------------------------------------------------------------------------
// Собеседники и упоминания

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

fn unique_actors_by_id<'a>(candidates: impl IntoIterator<Item = &'a Value>) -> Vec<&'a Value> {
    let mut actors: IndexMap<String, &Value> = IndexMap::new();
    for actor in candidates {
        let id = js::s(prop(Some(actor), "id"));
        if !id.is_empty() && !actors.contains_key(&id) {
            actors.insert(id, actor);
        }
    }
    actors.into_values().collect()
}

fn visible_actors(state: Option<&Value>) -> Vec<&Value> {
    let social = prop(state, "social");
    unique_actors_by_id(
        array(prop(state, "players"))
            .iter()
            .chain(array(prop(state, "actors")))
            .chain(array(prop(state, "enemies")))
            .chain(array(prop(social, "npcs")))
            .chain(array(prop(state, "merchants"))),
    )
}

/// `String(value ?? '').trim()` над списком, без пустых.
fn trimmed(values: Vec<Option<&Value>>) -> Vec<String> {
    values.into_iter().map(|value| text::trim(&js::s(value)).to_string()).filter(|value| !value.is_empty()).collect()
}

fn human_values(actor: &Value) -> Vec<Option<&Value>> {
    let mut values = vec![actor.get("name"), actor.get("character"), actor.get("label")];
    values.extend(array(actor.get("aliases")).iter().map(Some));
    values
}

fn names_for(actor: &Value) -> Vec<String> {
    let mut all = vec![actor.get("id")];
    all.extend(human_values(actor));
    let names = trimmed(all);
    // Для составного имени вроде «Король Арес» последняя часть — обычное имя.
    let trailing: Vec<String> = trimmed(human_values(actor))
        .iter()
        .filter_map(|value| {
            let tokens = word_tokens(value);
            let last = tokens.last()?;
            (tokens.len() > 1 && !last.is_empty() && !is_digits(last)).then(|| last.clone())
        })
        .collect();
    let mut unique: IndexSet<String> = IndexSet::new();
    unique.extend(names.into_iter().chain(trailing).filter(|value| !value.is_empty()));
    unique.into_iter().collect()
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn word_tokens(value: &str) -> Vec<String> {
    text::find_all(jre!(r"\p{L}[\p{L}\p{M}]*|\d+", "gu"), &text::lower(value))
}

/// Одно и то же слово имени в разных падежах: «Марте» — это «Марта», а не
/// «Мартен». Слова — в нижнем регистре.
pub fn same_name_token(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    if is_digits(left) || is_digits(right) {
        return false;
    }
    let cyrillic = |value: &str| value.chars().count() >= 3 && value.chars().all(|ch| ('а'..='я').contains(&ch) || ch == 'ё');
    if !cyrillic(left) || !cyrillic(right) {
        return false;
    }
    stem(left) == stem(right)
}

fn stem(value: &str) -> &str {
    let length = value.chars().count();
    if value.ends_with('ь') && length > 3 {
        return &value[..value.len() - 'ь'.len_utf8()];
    }
    for suffix in ["иями", "ями", "ами", "ого", "ему", "ому", "ыми", "ими", "ах", "ях", "ой", "ей", "ом", "ем", "а", "я", "у", "ю", "е", "ы", "и"] {
        if value.ends_with(suffix) && length - suffix.chars().count() >= 3 {
            return &value[..value.len() - suffix.len()];
        }
    }
    value
}

fn mentions_name(message: &str, name: &str) -> bool {
    let normalized = text::lower(name);
    // Имя — целым словом: подстрокой короткое «Ив» сидит в «спрашиваю».
    if utf16_len(&normalized) >= 2 {
        let source = format!(r"(?<![\p{{L}}\p{{M}}]){}(?![\p{{L}}\p{{M}}])", text::escape_regex(&normalized));
        if RegexBuilder::new(&source).backtrack_limit(BACKTRACK_LIMIT).build().is_ok_and(|regex| text::test(&regex, message)) {
            return true;
        }
    }
    let message_words = word_tokens(message);
    let name_words = word_tokens(&normalized);
    !name_words.is_empty() && name_words.iter().all(|word| message_words.iter().any(|candidate| same_name_token(word, candidate)))
}

fn mentioned_actors<'a>(message: &str, state: Option<&'a Value>) -> Vec<&'a Value> {
    let lower = text::lower(message);
    visible_actors(state).into_iter().filter(|actor| names_for(actor).iter().any(|name| mentions_name(&lower, name))).collect()
}

const ROLE_ALIASES: [(&str, &[&str]); 5] = [
    ("merchant", &["торговец", "торговц", "лавочник", "продавец", "продавц"]),
    ("innkeeper", &["трактирщик", "хозяин трактира", "хозяйка трактира"]),
    ("guard", &["стражник", "страж", "охранник"]),
    ("healer", &["лекарь", "целитель"]),
    ("blacksmith", &["кузнец"]),
];

/// `ROLE_ALIASES[key] ?? []` с ключами прототипа: метод `Object` не массив,
/// и `flatMap` кладёт его элементом — дальше он становится строкой.
fn role_aliases(key: &str) -> Vec<String> {
    if let Some((_, aliases)) = ROLE_ALIASES.iter().find(|(role, _)| *role == key) {
        return aliases.iter().map(|alias| (*alias).to_string()).collect();
    }
    prototype_string(key).into_iter().collect()
}

fn social_aliases_for(actor: &Value) -> Vec<String> {
    let role = text::trim(&js::s(actor.get("role"))).to_string();
    let tags: Vec<String> = array(actor.get("tags")).iter().map(|value| text::trim(&js::s(Some(value))).to_string()).filter(|value| !value.is_empty() && !value.contains(':')).collect();
    let mut translated: IndexSet<String> = IndexSet::new();
    for value in std::iter::once(&role).chain(&tags) {
        translated.extend(role_aliases(&text::lower(value)));
    }
    let mut unique: IndexSet<String> = IndexSet::new();
    for value in names_for(actor).into_iter().chain(std::iter::once(role)).chain(tags).chain(translated) {
        let value = text::trim(&value).to_string();
        if !value.is_empty() {
            unique.insert(value);
        }
    }
    unique.into_iter().collect()
}

fn present_social_actors(state: Option<&Value>) -> Vec<&Value> {
    let location = text::lower(text::trim(&js::s(prop(prop(state, "scene"), "location"))));
    let social = prop(state, "social");
    unique_actors_by_id(array(prop(social, "npcs")).iter().chain(array(prop(state, "merchants"))))
        .into_iter()
        .filter(|actor| !js::is_false(actor.get("available")))
        .filter(|actor| {
            let actor_location = text::lower(text::trim(&js::s(actor.get("location"))));
            location.is_empty() || actor_location.is_empty() || actor_location == location
        })
        .collect()
}

/// Сопоставление собеседника ограничено видимой текущей сценой. Точное имя или
/// явный alias имеют приоритет над ролью; одинаковая роль у двух NPC остаётся
/// неоднозначной и не превращается в молчаливый выбор первого.
pub fn resolve_present_social_actors(message: Option<&Value>, state: Option<&Value>) -> Vec<Value> {
    resolve_present(&normalized_text(message), state).into_iter().cloned().collect()
}

fn resolve_present<'a>(message: &str, state: Option<&'a Value>) -> Vec<&'a Value> {
    let lower = text::lower(&normalized_str(message));
    let scored: Vec<(&Value, f64)> = present_social_actors(state)
        .into_iter()
        .map(|actor| {
            let proper_names = names_for(actor);
            let role_aliases: Vec<String> = social_aliases_for(actor).into_iter().filter(|alias| !proper_names.contains(alias)).collect();
            let full_names: Vec<String> = [actor.get("name"), actor.get("character"), actor.get("label")]
                .into_iter()
                .filter(|value| js::truthy(*value))
                .map(js::s)
                .collect();
            let first_names: Vec<String> = full_names.iter().map(|name| word_tokens(name)).filter(|words| words.len() > 1).map(|words| words[0].clone()).collect();
            let score = if full_names.iter().any(|name| mentions_name(&lower, name)) {
                3.0
            } else if proper_names.iter().any(|name| mentions_name(&lower, name)) {
                2.0
            } else if first_names.iter().any(|name| mentions_name(&lower, name)) {
                1.5
            } else if role_aliases.iter().any(|alias| mentions_name(&lower, alias)) {
                1.0
            } else {
                js::max_of(std::iter::once(0.0).chain(role_aliases.iter().map(|alias| role_head_score(&lower, alias))))
            };
            (actor, score)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect();
    let best = js::max_of(std::iter::once(0.0).chain(scored.iter().map(|(_, score)| *score)));
    scored.into_iter().filter(|(_, score)| *score == best).map(|(actor, _)| actor).collect()
}

/// Одно слово роли в другой форме: «смотрителю» и «смотрительница».
fn same_role_word(left: &str, right: &str) -> bool {
    if same_name_token(left, right) {
        return true;
    }
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if left.len() < 5 || right.len() < 5 {
        return false;
    }
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    common >= 6 && common + 3 >= left.len().min(right.len())
}

fn role_head_score(lower_message: &str, alias: &str) -> f64 {
    let adjective = jre!(r"(?:ая|яя|ый|ий|ой|ое|ее|ые|ие)$", "u");
    let role_words: Vec<String> = word_tokens(alias).into_iter().filter(|word| word.chars().all(|ch| ('а'..='я').contains(&ch) || ch == 'ё')).collect();
    let Some(head_index) = role_words.iter().position(|word| utf16_len(word) >= 4 && !text::test(adjective, word)) else {
        return 0.0;
    };
    let message_words = word_tokens(lower_message);
    if !message_words.iter().any(|word| same_role_word(&role_words[head_index], word)) {
        return 0.0;
    }
    let mut qualifiers = role_words[head_index + 1..].iter().filter(|word| utf16_len(word) >= 4);
    if qualifiers.any(|word| message_words.iter().any(|candidate| same_role_word(word, candidate))) {
        0.8
    } else {
        0.6
    }
}

fn honorific_addresses() -> [(&'static Regex, &'static Regex); 3] {
    [
        (jre!(r"^ваш[ае]\s+(?:королевское\s+)?величеств", "iu"), jre!(r"(?<![\p{L}\p{M}])(?:корол|королев|цар|импер|monarch|king|queen)", "iu")),
        (jre!(r"^ваш[ае]\s+высочеств", "iu"), jre!(r"(?<![\p{L}\p{M}])(?:принц|принцесс|княж|наследни|prince|princess)", "iu")),
        (jre!(r"^ваш[ае]\s+(?:светлость|сиятельство)", "iu"), jre!(r"(?<![\p{L}\p{M}])(?:герцог|граф|князь|княгин|лорд|леди|duke|count|lord|lady)", "iu")),
    ]
}

fn honorific_addressed_actors<'a>(address: &str, state: Option<&'a Value>) -> Vec<&'a Value> {
    let trimmed = text::trim(address);
    let Some((_, role)) = honorific_addresses().into_iter().find(|(pattern, _)| text::test(pattern, trimmed)) else {
        return Vec::new();
    };
    present_social_actors(state)
        .into_iter()
        .filter(|actor| {
            let mut values = vec![actor.get("name"), actor.get("character"), actor.get("role")];
            values.extend(array(actor.get("tags")).iter().map(Some));
            values.into_iter().any(|value| text::test(role, &js::s(value)))
        })
        .collect()
}

fn directly_addressed_actors<'a>(message: &str, state: Option<&'a Value>) -> Vec<&'a Value> {
    // Прозвище в кавычках — часть обращения: «Силас «Кривой», вы сказали…».
    let Some(address) = text::capture(jre!(r#"^([\p{L}\p{M} «»"“”-]{2,80})[:,]\s*\S"#, "iu"), message, 1) else {
        return Vec::new();
    };
    let address = text::trim(&text::replace_all(jre!(r"\s+", "gu"), &text::replace_all(jre!(r#"[«»"“”]"#, "gu"), &address, " "), " ")).to_string();
    if address.is_empty() {
        return Vec::new();
    }
    let honorific = honorific_addressed_actors(&address, state);
    if !honorific.is_empty() {
        return honorific;
    }
    let words = word_tokens(&address);
    present_social_actors(state)
        .into_iter()
        .filter(|actor| {
            let mut names = social_aliases_for(actor);
            if let Some(first) = word_tokens(&js::s(actor.get("name"))).into_iter().next() {
                names.push(first);
            }
            names.iter().filter(|name| !name.is_empty()).any(|name| {
                let tokens = word_tokens(name);
                tokens.len() == words.len() && tokens.iter().zip(&words).all(|(token, word)| same_name_token(token, word))
            })
        })
        .collect()
}

fn approach_patterns() -> [(&'static str, &'static Regex); 8] {
    [
        // Разобрать бумагу, карту, печать или механизм — Расследование.
        (
            "investigation",
            jre!(r"(?<![\p{L}\p{M}])(?:осматр|осмотр|разгляд|рассматр|изуча|исслед|ищу|сверя|читаю|вчитыва)\p{L}*[^.!?]{0,40}(?<![\p{L}\p{M}])(?:карт|запис|журнал|документ|письм|надпис|печат|бумаг|свит|книг|накладн|механизм|замок|замк|шифр)", "iu"),
        ),
        // Чей-то след на местности читает Выживание.
        (
            "survival",
            jre!(r"(?<![\p{L}\p{M}])(?:иду\s+по\s+след\p{L}*|след\p{L}*\s+(?:\p{L}+\s+){0,2}(?:пропавш|человек|люд|зверя|звер|лошад|коня|отряд|беглец|повозк|телег|колёс|колес|сапог|ног)|след\p{L}*\s+(?:у|возле|около|под|вокруг|на\s+(?:земл|дорог|снег|грязи|траве|тропе|берегу))(?![\p{L}\p{M}]))", "iu"),
        ),
        ("perception", jre!(r"(?<![\p{L}\p{M}])(осматр|осмотр|разгляд|рассматр|высматр|замеч|заметить|ищу|искать|поиск|обыск|прислуш|слуша|следы?|улик)", "iu")),
        ("arcana", jre!(r"(?<![\p{L}\p{M}])(маги|магич|рун|заклинан|чароде|arcan)", "iu")),
        ("stealth", jre!(r"(?<![\p{L}\p{M}])(крад|тихо|тихонь|скрыт|прячу|прятать|незамет|stealth|sneak)", "iu")),
        ("persuasion", jre!(r"(?<![\p{L}\p{M}])(убежд|уговар|угово|диплом|persuad)", "iu")),
        ("intimidation", jre!(r"(?<![\p{L}\p{M}])(запуг|угрож|припуг|intimidat)", "iu")),
        ("strength", jre!(r"(?<![\p{L}\p{M}])(плыв|плава|тону|утоп|выламыв|ломаю|сломать|взлома|толка|толкаю|поднима|подним|тащ|оттаск|силой|swim|drown|shove|lift)", "iu")),
    ]
}

/// Социальный навык из `classifyNpcSocialCheck`, перепроверенный по целым
/// словам там, где подстрока ложно срабатывает.
fn bounded_social_skill(skill: Option<&'static str>, text: &str) -> Option<&'static str> {
    if skill == Some("deception") && !text::test(deception_word(), text) {
        return None;
    }
    if skill == Some("persuasion") && text::test(persuasion_false_friend(), text) && !text::test(jre!(r"(?:убежд|уговар|диплом|persuad|convinc|negotiate)", "iu"), text) {
        return None;
    }
    skill
}

fn watched_social_actors<'a>(text: &str, state: Option<&'a Value>) -> Vec<&'a Value> {
    let pattern = jre!(r"(?<![\p{L}\p{M}])(?:наблюда\p{L}*|присматрива\p{L}*|приглядыва\p{L}*|всматрива\p{L}*|вглядыва\p{L}*|слежу|следим|следить)(?:\s+(?:внимательно|пристально|молча|украдкой|исподтишка))?\s+(?:за|к|в)\s+([^,.!?;:]{2,60})", "iu");
    match text::capture(pattern, text, 1) {
        Some(watched) if !watched.is_empty() => resolve_present(&watched, state),
        _ => Vec::new(),
    }
}

fn infer_approach(message: &str) -> &'static str {
    approach_patterns().into_iter().find(|(_, pattern)| text::test(pattern, message)).map_or("unspecified", |(name, _)| name)
}

fn knock_out(text: &str, operative: &str) -> bool {
    text::test(jre!(r"нелеталь|не\s+убив|не\s+убива|без\s+убийств", "iu"), text) || text::test(jre!(r"оглуш|нокаут", "iu"), operative)
}

fn ids_of(actors: &[&Value]) -> Vec<Value> {
    actors.iter().map(|actor| Value::String(js::string(actor.get("id")))).collect()
}

/// Разбор реплики игрока в намерение.
#[derive(Clone, Copy, Debug, Default)]
pub struct IntentParser;

impl IntentParser {
    pub fn new() -> Self {
        Self
    }

    /// `parse({ message, playerId, visibleState })`.
    pub fn parse(&self, message: Option<&Value>, player_id: Option<&Value>, visible_state: Option<&Value>) -> Value {
        parse_intent(message, player_id, visible_state)
    }
}

const SCENARIO_INTENTS: [&str; 5] = ["scenario_knight", "scenario_treaty", "scenario_purse", "scenario_armory", "scenario_informant"];

/// Тело `IntentParser.parse`.
pub fn parse_intent(message: Option<&Value>, player_id: Option<&Value>, visible_state: Option<&Value>) -> Value {
    let text = normalized_text(message);
    let actor_id = js::s(player_id);
    let state = visible_state.filter(|state| !state.is_null());
    let null_state = Value::Null;
    let state_ref = state.unwrap_or(&null_state);
    if text.is_empty() {
        return json!({
            "actor_id": actor_id, "intent": "unknown", "approach": "unspecified", "targets": [],
            "mentioned_entities": [], "missing_information": ["message"], "requires_clarification": true, "confidence": 0,
            "free_action_kind": null,
        });
    }
    let text_value = Value::String(text.clone());
    let operative = affirmative_action_text(&text_value);
    let operative_value = Value::String(operative.clone());
    let watched = watched_social_actors(&operative, state);
    let social_skill = bounded_social_skill(classify_npc_social_check(&text_value), &text).or(if watched.is_empty() { None } else { Some("insight") });
    let free_action_kind = classify_free_action_text(&normalized_str(&operative));
    let addressed = directly_addressed_actors(&text, state);
    let spoken = !addressed.is_empty() || text::test(explicit_npc_speech(), &text) || text::test(spoken_opening(), &text);
    // Цель в придаточном («…, чтобы осмотреть двор сверху») — не само действие.
    let main_clause = split(jre!(r",?\s+(?:чтобы|дабы)\s+", "u"), &operative).into_iter().next().unwrap_or_default();
    let patterns = intent_patterns();
    let raw_pattern_intent = patterns.iter().find(|(_, pattern)| text::test(pattern, &operative)).map_or("improvised_action", |(name, _)| name);
    let check_pattern = patterns.iter().find(|(name, _)| *name == "ability_check").map(|(_, pattern)| *pattern);
    let pattern_intent = if raw_pattern_intent == "ability_check" && main_clause != operative && check_pattern.is_some_and(|pattern| !text::test(pattern, &main_clause)) {
        "improvised_action"
    } else {
        raw_pattern_intent
    };
    // Действие с проклятым рыцарем сценария — своя серверная команда, а не реплика.
    let knight_action = scenario_knight_action_from_text(Some(&operative_value));
    // Договор с драконом финала — тоже своя команда сценария, а не реплика.
    let treaty_action = if knight_action.is_some() { None } else { scenario_treaty_action_from_text(&operative, state) };
    let purse_action = if knight_action.is_some() || treaty_action.is_some() { None } else { scenario_purse_action_from_text(&operative) };
    // Вещь из королевской оружейной: названия берутся из каталога.
    let armory_choices: Vec<Value> = scenario_armory_rules(state_ref)
        .map(|rules| array(rules.get("catalog_ids")).to_vec())
        .unwrap_or_default()
        .iter()
        .map(|catalog_id| {
            let id = js::s(Some(catalog_id));
            json!({ "catalog_id": catalog_id, "name": js::s(catalog_item(&id).and_then(|item| item.get("name"))) })
        })
        .filter(|choice| choice.get("name").and_then(Value::as_str).is_some_and(|name| !name.is_empty()))
        .collect();
    let armory_action = if knight_action.is_some() || treaty_action.is_some() || purse_action.is_some() || armory_choices.is_empty() {
        None
    } else {
        scenario_armory_action_from_text(&operative, &armory_choices)
    };
    // Решение по осведомителю пепельной сети — только по уже раскрытому.
    let informants: Vec<Value> = scenario_informant_rules(state_ref).into_iter().filter(|informant| js::truthy(informant.get("revealed"))).collect();
    let informant_action = if knight_action.is_some() || treaty_action.is_some() || purse_action.is_some() || armory_action.is_some() || informants.is_empty() {
        None
    } else {
        scenario_informant_action_from_text(&operative, &informants)
    };
    let detected_intent = if knight_action.is_some() {
        "scenario_knight"
    } else if treaty_action.is_some() {
        "scenario_treaty"
    } else if purse_action.is_some() {
        "scenario_purse"
    } else if armory_action.is_some() {
        "scenario_armory"
    } else if informant_action.is_some() {
        "scenario_informant"
    } else if spoken {
        "social"
    } else if free_action_kind == Some("compound_maneuver") {
        "compound_maneuver"
    } else if free_action_kind == Some("compound_ranged_attack") {
        "improvised_action"
    } else if free_action_kind == Some("approach_attack") {
        "approach_attack"
    } else if social_skill.is_some() {
        "social"
    } else if pattern_intent == "attack" && text::test(inanimate_strike(), &operative) {
        "improvised_action"
    } else {
        pattern_intent
    };
    // «Проверяю, не следят ли за нами»: для уже опознанной проверки подход
    // ищется и в полном тексте.
    let operative_approach = infer_approach(&main_clause);
    let approach = social_skill.unwrap_or(if operative_approach == "unspecified" && detected_intent == "ability_check" { infer_approach(&text) } else { operative_approach });
    // Свободная задумка не превращается в проверку только из-за «пытаюсь».
    let intent = if detected_intent == "ability_check" && approach == "unspecified" && !text::test(explicit_check(), &text) { "improvised_action" } else { detected_intent };
    // Заклинание, названное словами в бою: сотворение известного героем
    // заклинания, а не импровизация.
    let combat_active = js::truthy(prop(prop(prop(state, "mechanics"), "combat"), "active"));
    let named_spell = if combat_active { named_known_spell_in(&operative, state, player_id) } else { None };
    if let Some(spell) = named_spell.filter(|_| !SCENARIO_INTENTS.contains(&intent)) {
        let enemies = array(prop(state, "enemies"));
        let targets: Vec<Value> = mentioned_actors(&text, state)
            .into_iter()
            .filter(|actor| enemies.iter().any(|enemy| js::string(enemy.get("id")) == js::string(actor.get("id"))))
            .map(|actor| Value::String(js::s(actor.get("id"))))
            .collect();
        let mut result = json!({
            "actor_id": actor_id,
            "intent": "cast_spell",
            "approach": "spell",
            "targets": targets,
            "mentioned_entities": targets,
            "numeric_value": null,
            "raw_message": text,
            "missing_information": [],
            "requires_clarification": false,
            "confidence": 0.86,
            "free_action_kind": null,
            "spell_id": spell.id,
        });
        if knock_out(&text, &operative) {
            result["knock_out"] = Value::Bool(true);
        }
        return result;
    }
    let social_targets: Vec<&Value> = if intent == "social" {
        if !addressed.is_empty() {
            addressed
        } else if !watched.is_empty() {
            watched
        } else {
            resolve_present(&text, state)
        }
    } else {
        Vec::new()
    };
    let mentioned: Vec<&Value> = if intent == "social" && !social_targets.is_empty() { social_targets.clone() } else { mentioned_actors(&text, state) };
    let player = js::s(player_id);
    let targets: Vec<Value> = ids_of(&mentioned).into_iter().filter(|id| id.as_str() != Some(player.as_str())).collect();
    let requires_target = matches!(intent, "attack" | "damage" | "approach_attack" | "compound_maneuver");
    let ambiguous = intent == "social" && social_targets.len() > 1;
    let mut missing = Vec::new();
    if requires_target && targets.is_empty() {
        missing.push("target_id");
    }
    if ambiguous {
        missing.push("ambiguous_npc");
    }
    if matches!(intent, "approach_attack" | "compound_maneuver") && targets.len() > 1 {
        missing.push("target_id");
    }
    let number = text::capture(jre!(r"(?:^|\s)(\d{1,3})(?:\s|$)", ""), &text, 1);
    let mut result = Map::new();
    result.insert("actor_id".into(), Value::String(actor_id));
    result.insert("intent".into(), json!(intent));
    result.insert("approach".into(), json!(approach));
    result.insert("targets".into(), Value::Array(targets));
    result.insert("mentioned_entities".into(), Value::Array(ids_of(&mentioned)));
    result.insert("numeric_value".into(), number.and_then(|number| number.parse::<i64>().ok()).map_or(Value::Null, Value::from));
    result.insert("raw_message".into(), Value::String(text.clone()));
    result.insert("missing_information".into(), json!(missing));
    result.insert("requires_clarification".into(), Value::Bool(!missing.is_empty()));
    result.insert("confidence".into(), json!(if intent == "improvised_action" { 0.45 } else if !missing.is_empty() { 0.55 } else { 0.86 }));
    result.insert("free_action_kind".into(), free_action_kind.map_or(Value::Null, |kind| json!(kind)));
    if let Some(action) = knight_action {
        result.insert("scenario_knight".into(), action.to_json());
    }
    if let Some(action) = armory_action {
        result.insert("scenario_armory".into(), action);
    }
    if let Some(action) = informant_action {
        result.insert("scenario_informant".into(), action);
    }
    if knock_out(&text, &operative) {
        result.insert("knock_out".into(), Value::Bool(true));
    }
    if ambiguous {
        let candidates: Vec<Value> = social_targets
            .iter()
            .map(|actor| {
                let name = actor.get("name").filter(|name| !name.is_null()).or(actor.get("id"));
                json!({ "id": js::string(actor.get("id")), "name": js::string(name), "role": js::s(actor.get("role")) })
            })
            .collect();
        result.insert("target_candidates".into(), Value::Array(candidates));
    }
    Value::Object(result)
}

/// Названное заклинание: id и имя карточки.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedSpell {
    pub id: String,
    pub name: String,
}

impl NamedSpell {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name })
    }
}

/// Первые пять единиц UTF-16 слов из трёх и более букв (`ё` → `е`).
fn spell_stems(text_value: &str) -> Vec<String> {
    let folded = text::lower(text_value).replace('ё', "е");
    text::find_all(jre!(r"\p{L}{3,}", "gu"), &folded).into_iter().map(|word| head_utf16(&word, 5)).collect()
}

/// `[...(list ?? [])]`: массив — элементы, строка — её символы.
fn spread_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect(),
        Some(Value::String(text)) => text.chars().map(String::from).collect(),
        _ => Vec::new(),
    }
}

/// Известное герою заклинание, названное в тексте по-русски: «Огненный
/// снаряд», «огненным снарядом». Совпадение — все слова имени по первым пяти
/// буквам; при нескольких — самое длинное имя.
pub fn named_known_spell(text_value: Option<&Value>, state: Option<&Value>, player_id: Option<&Value>) -> Option<NamedSpell> {
    named_known_spell_in(&js::s(text_value), state, player_id)
}

fn named_known_spell_in(text_value: &str, state: Option<&Value>, player_id: Option<&Value>) -> Option<NamedSpell> {
    let player = js::string(player_id);
    let hero = array(prop(state, "players")).iter().find(|entry| js::string(entry.get("id")) == player)?;
    let stems: IndexSet<String> = spell_stems(text_value).into_iter().collect();
    let mut ids: IndexSet<String> = IndexSet::new();
    ids.extend(spread_list(hero.get("knownSpellIds").filter(|value| !value.is_null())));
    ids.extend(spread_list(hero.get("preparedSpellIds").filter(|value| !value.is_null())));
    let mut options = Map::new();
    if let Some(ruleset) = prop(state, "ruleset_id") {
        options.insert("rulesetId".into(), ruleset.clone());
    }
    let options = Value::Object(options);
    let mut matches: Vec<(String, String, usize)> = ids
        .into_iter()
        .filter_map(|id| {
            let card = canonical_combat_spell_for(Some(&Value::String(id.clone())), Some(&options));
            let name = js::s(card.as_ref().and_then(|card| card.get("name")));
            let words = spell_stems(&name);
            (!words.is_empty() && words.iter().all(|stem| stems.contains(stem))).then(|| (id, name, words.len()))
        })
        .collect();
    matches.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| text::locale_compare(&left.0, &right.0)));
    matches.into_iter().next().map(|(id, name, _)| NamedSpell { id, name })
}

/// Запросы к своду правил по намерению.
pub fn build_rule_queries(intent: Option<&Value>, state: Option<&Value>) -> Vec<String> {
    let kind = prop(intent, "intent");
    let mut queries: Vec<Option<Value>> = vec![prop(intent, "raw_message").cloned(), kind.cloned(), prop(intent, "approach").cloned()];
    let mut push = |text: &str| queries.push(Some(Value::String(text.into())));
    let kind = kind.and_then(Value::as_str);
    if kind == Some("attack") {
        push("attack roll armor class damage advantage disadvantage");
    }
    if kind == Some("saving_throw") {
        push("saving throw");
    }
    if kind == Some("healing") {
        push("healing hit points zero hit points");
    }
    if kind == Some("cast_spell") {
        push("spellcasting concentration resource");
    }
    if kind == Some("end_combat") {
        push("combat initiative turn order end combat");
    }
    if text::test(jre!(r"плыв|вод|тон\w*|удуш|swim|drown|suffocat", "iu"), &js::s(prop(intent, "raw_message"))) {
        push("swimming rough water suffocation hazard exhaustion");
    }
    if js::truthy(prop(prop(prop(state, "mechanics"), "combat"), "active")) {
        push("combat turn action bonus action reaction");
    }
    let mut unique: IndexSet<String> = IndexSet::new();
    for query in queries {
        let normalized = normalized_text(query.as_ref());
        if !normalized.is_empty() {
            unique.insert(normalized);
        }
    }
    unique.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> Value {
        Value::String(text.into())
    }

    #[test]
    fn request_kind_routes_questions_and_table_talk() {
        assert_eq!(infer_request_kind(Some(&s("Где находится таверна?"))), "question");
        assert_eq!(infer_request_kind(Some(&s("Ребята, давайте отдохнём"))), "discussion");
        assert_eq!(infer_request_kind(Some(&s("Спрашиваю Марту о дороге"))), "action");
        // Обращение на «ты» — реплика собеседнику, а не вопрос ведущему.
        assert_eq!(infer_request_kind(Some(&s("Кто ты такой?"))), "action");
        assert_eq!(normalize_request_kind(Some(&s(" Question "))), "question");
        assert_eq!(normalize_request_kind(Some(&s("delete"))), "action");
    }

    #[test]
    fn names_follow_case_forms() {
        assert!(same_name_token("марте", "марта"));
        assert!(!same_name_token("марта", "мартен"));
        assert!(!same_name_token("12", "12а"));
    }

    #[test]
    fn sequence_and_wait() {
        assert_eq!(action_sequence(Some(&s("Сначала осматриваю дверь, а потом открываю её"))), vec!["осматриваю дверь", "открываю её"]);
        assert_eq!(wait_target_from_text(Some(&s("ждём до полуночи"))).map(|target| target.id), Some("midnight"));
        assert_eq!(wait_target_from_text(Some(&s("идём к мельнице"))), None);
    }

    #[test]
    fn prototype_role_becomes_alias_like_js() {
        // Замечено в JS: `ROLE_ALIASES['constructor']` — функция `Object`, она
        // становится строкой-алиасом, и собеседник с ролью `constructor`
        // находится по словам «function object native code».
        let state = json!({ "scene": { "location": "X" }, "social": { "npcs": [{ "id": "n1", "name": "Пётр", "role": "constructor", "location": "X" }] } });
        let found = resolve_present_social_actors(Some(&s("function object native code")), Some(&state));
        assert_eq!(found.len(), 1);
    }
}
