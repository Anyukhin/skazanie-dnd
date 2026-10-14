//! Перенос `server/party-exit-intent.mjs`: один словарь ухода на оба берега
//! решения группы.
//!
//! Словарей было два: один решал, предлагать ли карточку голосования, другой —
//! считать ли уже принятое решение уходом. Списки разошлись, и формулировка
//! «Отправиться в Пепельный Лес» проходила первый и не проходила второй. Здесь
//! на оба вопроса отвечает один набор правил.
//!
//! Отдельная забота — не перехватить тактическое действие. Свободный ввод один
//! и тот же и для «уходим отсюда», и для «уходим в тень», поэтому просьба уйти
//! опознаётся только по связке «глагол ухода + место», а не по глаголу.
//!
//! Позиции совпадений считаются в символах (в JS — в единицах UTF-16; для
//! кириллицы и латиницы это одно и то же).

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;
use sk_core::fancy_regex::{Captures, Regex};
use sk_core::{js, re, text};

use crate::util::{array, first_index, head, is_str, js_len, js_trim, split, squash, upper_first};

/// Маркер, которым клиент карты мира помечает предложение маршрута.
pub const WORLD_MAP_TRAVEL_MARKER: &str = "[ГЛОБАЛЬНАЯ КАРТА]";

// Слово места — целое слово с падежным окончанием, а не префикс: «иду к старой
// лестнице» и «иду к лесничему» не уходят в лес, «иду к трактирщице» — в трактир.
const NOUN_END: &str = r"(?:а|я|о|е|ё|у|ю|ы|и|ь|ой|ей|ою|ею|ом|ем|ём|ам|ям|ами|ями|ах|ях|ов|ев)?";
const PLACE_STEMS: &str = r"подземель|локаци|местност|мест|город|городк|град|деревн|деревушк|сел|пос[ёе]лк|поселени|лес|чащ|рощ|болот|топ|пустош|пустын|порт|гаван|пристан|замк|крепост|цитадел|форт|застав|лагер|стоянк|храм|святилищ|монастыр|пещер|руин|развалин|архив|склеп|катакомб|шахт|рудник|башн|таверн|трактир|корчм|гостиниц|усадьб|поместь|особняк|здани|район|улиц|площад|рынк|тракт|дорог|перевал|ущель|долин|остров|берег|станци|маяк|мельниц|кладбищ|погост|холм";
const PLACE_FULL: &str = r"замок|рынок|городок|пос[ёе]лок|постоял(?:ый|ого|ому|ом)\s+двор(?:а|у|е|ом)?|караван-?сара(?:й|я|ю|е|ем)|пол(?:е|я|ю|ям|ях)|гор(?:ы|ам|ах)";

/// Места, из которых и в которые уходят целиком. Комнаты, залы и коридоры сюда
/// намеренно не входят: перемещение внутри локации — дело тактической доски.
static PLACE: LazyLock<String> =
    LazyLock::new(|| format!(r"(?<![\p{{L}}\p{{M}}])(?:{PLACE_FULL}|(?:{PLACE_STEMS}){NOUN_END})(?![\p{{L}}\p{{M}}])"));

/// Глаголы, которыми объявляют уход всей группы.
const LEAVE: &str = r"покин(?:уть|ем|ём|ут|у|ь)|покида(?:ем|ю|ть|ете)|уход(?:им|ить|ят|ите)|уйти|уйд(?:ем|ём|ут|у)|свал(?:им|ить|иваем)|валим|убира(?:емся|ться)|выбра(?:ться|вшись)|выбираемся|выходим|выхожу|вый(?:ти|дем|дём|ду)|выдвигаемся|выдвигаюсь|отступ(?:аем|ить|им)|сматываемся";

/// Глаголы движения, у которых уход опознаётся только по названному месту.
/// Первое лицо единственного числа («иду», «отправляюсь») — то, как обычно
/// пишет одиночный игрок. Формы перечислены явно: префикс «двига…» поймал бы
/// «двигаю стол».
const HEAD_TO: &str = r"ид(?:ём|ем|ти|у)|пойти|пойд(?:у|ём|ем)|пошли|направ(?:ля(?:емся|ться|юсь)|имся|люсь|иться)|отправ(?:ляемся|иться|имся|ляюсь|люсь)|возвраща(?:емся|ться|юсь)|верн(?:ёмся|емся|усь|уться)|едем|еду|ехать|по(?:еду|едем|ехали|ехать)|двига(?:емся|юсь|ться)|двин(?:емся|улись|усь|уться)|добира(?:емся|юсь|ться)|добер(?:ёмся|емся|усь)|добраться|держ(?:им|у)\s+путь|плыв(?:ём|ем)|поплыв(?:ём|ем)|бежим|бегу|спеш(?:им|у)";

/// Цель поездки после названия: «в таверну «Морской Змей» расспрашивать…».
/// Существительные на «-ть» инфинитивом не считаются: «в старую крепость».
static PURPOSE_INFINITIVE: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?!(?:{place})|(?:часть|область|волость|пропасть|пасть|сеть|степь|смерть|опасность|радость|ярость|скорость)(?![\p{{L}}\p{{M}}]))[\p{{L}}-]{{2,}}(?:ть|ться|тись|чь)(?![\p{{L}}\p{{M}}])",
        place = *PLACE
    )
});

/// Кавычки, которыми игрок обрамляет название: «ёлочки», "прямые", “английские”, „немецкие“.
const QUOTED: &str = r#"«([^»]{1,120})»|"([^"]{1,120})"|“([^”]{1,120})”|„([^“”]{1,120})[“”]"#;

/// Описание дороги: «вдоль соляных складов», «через лес», «по маршруту от
/// Высокой пристани». Это то, как идут, а не куда. «По» считается дорогой лишь
/// перед словом пути — «к дому по соседству» название не теряет.
const ROUTE_NOUN: &str = r"(?:маршрут|дорог|тропинк|троп|тракт|след|берег|улиц|мост|набережн|пут|склон|кромк|рек|течени|направлени)";
static ROUTE: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:вдоль|через|мимо|минуя|сквозь|огибая|обходя|в\s+обход|на\s+(?:север|юг|запад|восток|северо-\p{{L}}+|юго-\p{{L}}+)|по\s+(?:[\p{{L}}-]+\s+){{0,2}}?{ROUTE_NOUN}{NOUN_END})(?![\p{{L}}\p{{M}}])"
    )
});

fn compile(source: &str, flags: &str) -> Regex {
    text::js_regex(source, flags).unwrap_or_else(|| panic!("регулярное выражение: {source}"))
}

/// «Покинуть подземелье», «уходим из деревни», «покинуть «Караван-сарай»».
/// До двух определений перед местом: «покидаем старую таверну».
static LEAVE_TARGET: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        &format!(
            r"(?<![\p{{L}}\p{{M}}])(?:{LEAVE})\s+(?:(?:из|с|от)\s+)?(?:эт(?:о|ого|у|ой|от|им)\s+)?(?:«[^»]{{1,120}}»|(?:[\p{{L}}-]+\s+){{0,2}}?(?:{place}))",
            place = *PLACE
        ),
        "iu",
    )
});

/// Что покидают, когда предлога нет или место не родовое: «покидаем Аквилон».
static LEAVE_OBJECT: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        &format!(
            r"(?<![\p{{L}}\p{{M}}])(?:{LEAVE})\s+(?:(?:из|с|от)\s+)?([^,.;!?—]{{1,80}}?)(?=\s+(?:и|а|но|чтобы|затем|потом)\s|\s+(?:в|на|к|ко|до)\s|[,.;!?—]|$)"
        ),
        "iu",
    )
});

static LEAVE_VERB: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"(?:{LEAVE})"), "iu"));

/// Куда собрались: глагол ухода или движения, предлог и название до ближайшей
/// границы. Сама по себе эта связка уходом ещё не является — «уходим в тень»
/// ей тоже удовлетворяет. Название берётся нежадно и обрывается на союзе;
/// описание дороги стоит по обе стороны названия и в него не входит (шестая
/// группа); «откуда» — ленивое.
static DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        &format!(
            r#"(?<![\p{{L}}\p{{M}}])(?:{LEAVE}|{HEAD_TO})\s+(?:отсюда\s+|из\s+[^,.;!?]{{1,80}}?\s+)?(?:(?:{route}|от(?![\p{{L}}\p{{M}}]))[^,.;!?—]{{0,80}}?\s+)?(?:{purpose}(?:\s+[^\s,.;!?—]+){{0,3}}?\s+)?(?:в|во|на|к|ко|до)\s+(?:(?:{QUOTED})|(?![«"“„])([^,.;!?—]{{1,120}}?)(?:\s+({route}[^,.;!?—]{{0,120}}?))?(?=\s+(?:и|а|но|чтобы|затем|потом|сохранив|бросив|отказавшись|оставив)\s|\s+{purpose}|[,.;!?—]|$))"#,
            route = *ROUTE,
            purpose = *PURPOSE_INFINITIVE
        ),
        "iu",
    )
});

/// Место, названное где угодно внутри пункта назначения.
static PLACE_WORD: LazyLock<Regex> = LazyLock::new(|| compile(&PLACE, "iu"));
static PLACE_WORD_EXACT: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^(?:{place})$", place = *PLACE), "iu"));

/// «Не иду туда», «не уходим из деревни» — отказ от движения, а не заявка.
static NEGATED_MOVEMENT_SOURCE: LazyLock<String> =
    LazyLock::new(|| format!(r"(?<![\p{{L}}\p{{M}}])не\s+(?:{LEAVE}|{HEAD_TO})(?![\p{{L}}\p{{M}}])"));
static NEGATED_MOVEMENT: LazyLock<Regex> = LazyLock::new(|| compile(&NEGATED_MOVEMENT_SOURCE, "iu"));

fn world_map_marker() -> &'static Regex {
    re!(r"^\s*\[ГЛОБАЛЬНАЯ КАРТА\]", "iu")
}

/// Machine-readable цель карты мира. Значение кодирует клиент через
/// `encodeURIComponent`, поэтому оно не может преждевременно закрыть скобку.
fn world_map_destination_id() -> &'static Regex {
    re!(r"^\s*\[ГЛОБАЛЬНАЯ КАРТА\]\s*\[destination_location_id=([^\]\s]{1,1500})\]", "iu")
}

/// Реплика из одного глагола ухода: «Уходим.», «Всё, валим!».
fn bare_leave() -> &'static Regex {
    re!(
        r"^(?:(?:всё|все|ну|ладно|итак|так|мы|пора|давайте|ребята|я)[,!.]?\s+){0,3}(?:уходим|уйд[её]м|уходить|уйти|валим|сваливаем|сматываемся|выдвигаемся|выходим|покидаем)[.!…]*$",
        "iu"
    )
}

/// «Уйти отсюда» — место не названо, но названа сама локация как целое.
fn exit_scope() -> &'static Regex {
    re!(r"(?:отсюда|прочь|из\s+эт(?:ого|ой)\s+(?:мест|локац|город|деревн|подземель))", "iu")
}

/// Место внутри текущей сцены: «иду в угол таверны» — шаг по доске, а не уход.
/// Формы перечислены явно: «стол…» поймал бы «столицу», «зал…» — «залив».
fn inside_scene() -> &'static Regex {
    re!(
        r"(?<![\p{L}\p{M}])(?:угол|угл(?:а|у|ом|е)|сторон(?:а|у|е|ы)|центр(?:а|у|е)?|середин(?:а|у|е|ы)|конец|конц(?:а|у|е)|дверь|двер(?:и|ью)|комнат(?:а|у|е|ы)|зал(?:а|у|е|ом|ы)?|подвал(?:а|у|е)?|погреб(?:а|у|е)?|кухн(?:я|и|ю|е)|стойк(?:а|и|у|е)|стол(?:а|у|е|ом|ы)?|окн(?:а|у|е)|окно|лестниц(?:а|у|е|ы)|коридор(?:а|у|е)?|тень|тен(?:и|ью)|укрыти(?:е|я|ю)|глубь|глубин(?:а|у|е|ы)|камин(?:а|у|е)?|очаг(?:а|у|е)?|этаж(?:а|у|е)?|сво(?:ё|е|ему|ем)\s+мест(?:о|у|е))(?![\p{L}\p{M}])",
        "iu"
    )
}

/// Человек, к которому идут: «иду к хозяйке таверны» — шаг к собеседнику.
fn person_word() -> &'static Regex {
    re!(
        r"(?<![\p{L}\p{M}])(?:хозя(?:ин|ина|ину|ином|йк(?:а|и|е|у|ой))|трактирщи(?:к|ка|ку|ком|ц(?:а|е|у|ей))|корчмар(?:я|ю|ем|ь)?|стражник(?:а|у|ом|ам)?|страж(?:е|у|ам)|торгов(?:ец|ца|цу|цем|к(?:а|е|у|ой))|кузнец(?:а|у|ом)?|жрец(?:а|у|ом)?|жриц(?:а|е|у|ей)|бармен(?:а|у|ом)?|служанк(?:а|е|у|ой)|лесничи(?:й|его|ему|м)|старост(?:а|е|у|ой)|капитан(?:а|у|ом)?|рыбак(?:а|у|ом|ам)?|завсегдата(?:й|ю|ям|ям))(?![\p{L}\p{M}])",
        "iu"
    )
}

/// Хвост, которым русское слово меняется по падежам: «-у/-а», «-ой/-ого», «-й/-я».
fn case_ending() -> &'static Regex {
    re!(r"^[аеёиоуыэюяйьмхвг]{0,3}$", "u")
}

/// Отказ от задания. Держится рядом с уходом: голосуют за это одной карточкой.
fn abandon() -> &'static Regex {
    re!(
        r"(?:брос(?:аем|ить|им)\s+(?:это\s+)?(?:задани|квест|поручени|дело)|отказ(?:ываемся|аться|ываюсь)\s+от\s+(?:задани|квест|поручени)|заби(?:ваем|вать|ть|л[иа]?)\s+на\s+(?:задани|квест|поручени)|без\s+задани)",
        "iu"
    )
}

/// Решение остаться.
fn stay() -> &'static Regex {
    re!(
        r"(?:оста(?:ться|ёмся|емся|немся|нусь|нься)|не\s+уход|продолж(?:ить|аем|им)\s+(?:исслед|поиск|осмотр)|исследовать\s+дальше|никуда\s+не\s+ид)",
        "iu"
    )
}

/// Отказ от ухода перевешивает названное в той же фразе место.
fn stay_overrides_exit() -> &'static Regex {
    re!(r"(?:не\s+уход|не\s+покида|никуда\s+не\s+ид)", "iu")
}

fn speech_travel_call() -> &'static Regex {
    re!(
        r"(?<![\p{L}\p{M}])(?:пойд[её]м|ид[её]м|пошли|отправ(?:имся|ляемся)|двинемся|двинули|выдвигаемся|поехали|поедем)(?![\p{L}\p{M}])",
        "iu"
    )
}

/// «Иду к нему», «к ним» — местоимение, а не название.
fn pronoun_destination() -> &'static Regex {
    re!(r"^(?:нему|ней|ним|нам|вам|тебе|мне|себе|этому|этой|тому|той|туда|сюда)$", "iu")
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn compact(value: &str, maximum: usize) -> String {
    head(&squash(&text::nfkc(value)), maximum)
}

fn lower(value: &str) -> String {
    text::lower(value)
}

fn group<'t>(captures: &Captures<'t, str>, index: usize) -> Option<&'t str> {
    captures.get(index).map(|found| found.as_str())
}

fn captures<'t>(regex: &Regex, haystack: &'t str) -> Option<Captures<'t, str>> {
    regex.captures(haystack).ok().flatten()
}

fn all_captures<'t>(regex: &Regex, haystack: &'t str) -> Vec<Captures<'t, str>> {
    regex.captures_iter(haystack).filter_map(Result::ok).collect()
}

/// Одно слово в разных падежах: общая основа и короткие падежные хвосты.
/// «Норвин» и «Норвель» начинаются одинаково, но хвосты «ин»/«ель» не падежные.
fn same_word_inflected(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    if common < 3 || (common as i64) < left.len().max(right.len()) as i64 - 3 {
        return false;
    }
    let tail = |word: &[char]| word[common..].iter().collect::<String>();
    text::test(case_ending(), &tail(&left)) && text::test(case_ending(), &tail(&right))
}

/// Слова названия длиной от трёх букв, без кавычек; `generic` — родовые слова
/// («таверна», «лес»), которые сами по себе места не называют.
struct NameWords {
    distinctive: Vec<String>,
    generic: Vec<String>,
}

fn name_words(value: &str) -> NameWords {
    let cleaned = text::replace_all(re!(r#"["'«»„“”`]"#, "gu"), &lower(&compact(value, 160)), " ");
    let words: Vec<String> =
        text::find_all(re!(r"[\p{L}\p{N}-]+", "gu"), &cleaned).into_iter().filter(|word| js_len(word) >= 3).collect();
    let (generic, distinctive): (Vec<String>, Vec<String>) = words.into_iter().partition(|word| text::test(&PLACE_WORD_EXACT, word));
    NameWords { distinctive, generic }
}

/// Называет ли фраза одну из известных отряду точек карты.
fn names_known_place(phrase: &str, known_places: &[String]) -> bool {
    !known_place_name(phrase, known_places).is_empty()
}

/// Название известной точки карты, которое называет фраза в любом падеже:
/// «к Кленовке» — «Кленовка». Пустая строка, если такой точки нет. Из
/// подходящих — самое точное: «Маяк Серого Причала» содержит и «Серый Причал».
fn known_place_name(phrase: &str, known_places: &[String]) -> String {
    if phrase.is_empty() || known_places.is_empty() {
        return String::new();
    }
    let spoken = name_words(phrase);
    if spoken.distinctive.is_empty() {
        return String::new();
    }
    let said: Vec<&String> = spoken.distinctive.iter().chain(&spoken.generic).collect();
    let mut best: Option<(i64, &String)> = None;
    for name in known_places {
        let place = name_words(name);
        if place.distinctive.is_empty() || spoken.distinctive.len() > place.distinctive.len() + 2 {
            continue;
        }
        if !place.distinctive.iter().all(|stem| spoken.distinctive.iter().any(|word| same_word_inflected(word, stem))) {
            continue;
        }
        let kinds_agree = spoken.generic.is_empty()
            || place.generic.is_empty()
            || place.generic.iter().any(|kind| spoken.generic.iter().any(|word| same_word_inflected(word, kind)));
        if !kinds_agree {
            continue;
        }
        // Точность: слово места, названное во фразе, — плюс, не названное — минус вдвое.
        let words: Vec<&String> = place.distinctive.iter().chain(&place.generic).collect();
        let named = words.iter().filter(|stem| said.iter().any(|word| same_word_inflected(word, stem))).count() as i64;
        let score = named - 2 * (words.len() as i64 - named);
        if best.is_none_or(|(top, _)| score > top) {
            best = Some((score, name));
        }
    }
    best.map(|(_, name)| name.clone()).unwrap_or_default()
}

/// Упоминает ли фраза присутствующего собеседника; позиция слова или `None`.
/// Сравнивается последнее слово имени — собственное: у «Старого Финна» слово
/// «старый» совпало бы со «старой крепостью».
fn names_present_person(phrase: &str, present_names: &[String]) -> Option<usize> {
    let word = re!(r"[\p{L}-]{3,}", "gu");
    let proper: Vec<String> =
        present_names.iter().filter_map(|name| text::find_all(word, &lower(&compact(name, 80))).pop()).collect();
    if proper.is_empty() {
        return None;
    }
    let lowered = lower(&compact(phrase, 160));
    for found in word.find_iter(&lowered).filter_map(Result::ok) {
        if proper.iter().any(|name| same_word_inflected(found.as_str(), name)) {
            return Some(lowered[..found.start()].chars().count());
        }
    }
    None
}

/// Кавычки «ёлочки» из предложения карты мира: первая пара — откуда, вторая —
/// куда. Разбирать прозу маркера не нужно, у него есть структура.
fn quoted_places(text_value: &str) -> Vec<String> {
    all_captures(re!(r"«([^»]{1,120})»", "gu"), text_value)
        .iter()
        .map(|found| compact(group(found, 1).unwrap_or(""), 120))
        .filter(|place| !place.is_empty())
        .collect()
}

/// `decodeURIComponent`: `%XX` — байты UTF-8; неверная последовательность —
/// ошибка (`URIError`).
fn decode_uri_component(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let hex = |at: usize| -> Option<u8> {
        let pair = bytes.get(at + 1..at + 3)?;
        u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
    };
    let mut result = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let ch = encoded[index..].chars().next()?;
            result.push(ch);
            index += ch.len_utf8();
            continue;
        }
        let first = hex(index)?;
        index += 3;
        let length = match first {
            0x00..=0x7F => 1,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut sequence = vec![first];
        for _ in 1..length {
            if bytes.get(index) != Some(&b'%') {
                return None;
            }
            let next = hex(index)?;
            if next & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(next);
            index += 3;
        }
        result.push_str(std::str::from_utf8(&sequence).ok()?);
    }
    Some(result)
}

fn world_map_destination_location_id(text_value: &str) -> String {
    let Some(encoded) = captures(world_map_destination_id(), text_value).and_then(|found| group(&found, 1).map(str::to_string)) else {
        return String::new();
    };
    // Неверное percent-encoding не отменяет разбор видимого названия.
    let Some(decoded) = decode_uri_component(&encoded) else {
        return String::new();
    };
    let decoded = squash(&text::nfkc(&decoded));
    if decoded.is_empty() || js_len(&decoded) > 120 || text::test(re!(r"[\u0000-\u001f\u007f]", "u"), &decoded) {
        return String::new();
    }
    decoded
}

/// Пункт назначения и признак того, что назван именно он, а не цель внутри сцены.
#[derive(Debug, Clone, Default)]
struct Heading {
    destination: String,
    is_place: bool,
    in_scene: bool,
}

/// Названия известных точек карты и имена присутствующих — уже очищенные.
struct ExitContext {
    known_places: Vec<String>,
    present_names: Vec<String>,
}

/// Пункт назначения во фразе. Место узнаётся тремя способами: кавычки сразу
/// после предлога, родовое слово места или известная отряду точка карты по
/// имени. Шаг к углу или к человеку перевешивает место, если назван раньше
/// него. Описание дороги после названия в пункт назначения не попадает, но
/// признаком ухода остаётся.
fn destination_in(text_value: &str, context: &ExitContext) -> Heading {
    let Some(found) = captures(&DESTINATION, text_value) else {
        return Heading::default();
    };
    let quoted = compact((1..=4).find_map(|index| group(&found, index)).unwrap_or(""), 120);
    // Название в кавычках после «в» — всегда место: кавычки ставит либо клиент
    // карты мира, либо сам сервер, собирая вариант голосования.
    if !quoted.is_empty() {
        return Heading { destination: quoted, is_place: true, in_scene: false };
    }
    let name = compact(group(&found, 5).unwrap_or(""), 120);
    let phrase = compact(&format!("{name} {}", group(&found, 6).unwrap_or("")), 240);
    let scene = [
        first_index(inside_scene(), &phrase),
        first_index(person_word(), &phrase),
        names_present_person(&phrase, &context.present_names),
    ];
    let place_at = first_index(&PLACE_WORD, &phrase);
    let known = names_known_place(&name, &context.known_places) || names_known_place(&phrase, &context.known_places);
    if place_at.is_none() && !known {
        let in_scene = scene.iter().any(Option::is_some);
        return Heading { destination: name, is_place: false, in_scene };
    }
    let anchor = place_at.unwrap_or_else(|| phrase.chars().count());
    let in_scene = scene.iter().any(|index| index.is_some_and(|index| index < anchor));
    Heading { destination: name, is_place: !in_scene, in_scene }
}

/// Названия точек карты мира, которые знает отряд, и имена тех, кто стоит рядом
/// (`{ knownPlaces, presentNames }` в JS).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitOptions {
    pub known_places: Vec<String>,
    pub present_names: Vec<String>,
}

impl ExitOptions {
    /// Параметры из JSON-объекта `{ knownPlaces, presentNames }`: не-массив —
    /// пусто, элементы приводятся `String(x ?? '')`.
    pub fn from_value(options: &Value) -> Self {
        let names = |key: &str| array(options.get(key)).iter().map(|entry| js::s(Some(entry))).collect();
        Self { known_places: names("knownPlaces"), present_names: names("presentNames") }
    }

    fn context(&self) -> ExitContext {
        let names = |list: &[String]| list.iter().map(|entry| compact(entry, 120)).filter(|entry| !entry.is_empty()).take(200).collect();
        ExitContext { known_places: names(&self.known_places), present_names: names(&self.present_names) }
    }
}

/// Названия точек карты мира, которые отряд знает, и имена тех, кто стоит рядом.
/// Вызывающий передаёт их в [`detect_party_exit_request`], чтобы «Иду в Каменный
/// Град» узнавалось без родового слова, а «иду к Марте» не уводило из сцены.
/// Скрытые и неизвестные точки не попадают: иначе фраза игрока работала бы
/// оракулом по карте.
pub fn exit_context_from_state(state: &Value) -> ExitOptions {
    let locations = array(state.get("worldMap").and_then(|map| map.get("locations")));
    let known_places = locations
        .iter()
        .filter(|entry| {
            js::truthy(entry.get("name"))
                && !js::is_false(entry.get("known"))
                && !js::is_true(entry.get("hidden"))
                && !is_str(entry.get("visibility"), "gm_only")
        })
        .map(|entry| compact(&js::s(entry.get("name")), 120))
        .collect();
    let location = lower(&compact(&js::s(state.get("scene").and_then(|scene| scene.get("location"))), 160));
    let lists = [
        array(state.get("scene_npcs")),
        array(state.get("social").and_then(|social| social.get("npcs"))),
        array(state.get("merchants")),
    ];
    let mut present_names: Vec<String> = Vec::new();
    for actor in lists.iter().flat_map(|list| list.iter()) {
        let here = location.is_empty()
            || !js::truthy(actor.get("location"))
            || lower(&compact(&js::s(actor.get("location")), 160)) == location;
        if js::is_false(actor.get("alive")) || js::is_false(actor.get("available")) || !here {
            continue;
        }
        let name = compact(&js::s(actor.get("name")), 80);
        if !name.is_empty() && !present_names.contains(&name) {
            present_names.push(name);
        }
    }
    ExitOptions { known_places, present_names }
}

/// Просьба увести отряд из сцены: куда и откуда пришла заявка.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyExitRequest {
    pub destination: String,
    /// `world-map`, `text`, `speech` или `route`.
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_location_id: Option<String>,
}

/// Просьба увести отряд из текущей локации. `None`, когда фраза говорит о
/// чём угодно другом.
pub fn detect_party_exit_request(action: &str, options: &ExitOptions) -> Option<PartyExitRequest> {
    let text_value = compact(action, 2_000);
    if text_value.is_empty() {
        return None;
    }
    let context = options.context();
    let heading = destination_in(&text_value, &context);
    if text::test(world_map_marker(), &text_value) {
        let places = quoted_places(&text_value);
        let destination_location_id = world_map_destination_location_id(&text_value);
        // Первая кавычка — откуда, вторая — куда. Если названо одно место, это и
        // есть пункт назначения: маршрут строил клиент.
        let destination = match places.as_slice() {
            [_, second, ..] => second.clone(),
            [only] => only.clone(),
            [] => heading.destination,
        };
        return Some(PartyExitRequest {
            destination,
            source: "world-map",
            destination_location_id: (!destination_location_id.is_empty()).then_some(destination_location_id),
        });
    }
    // Прямая речь героя и отрицание — не заявка на уход: «Я не уйду отсюда,
    // пока не узнаю правду» не открывает голосования.
    let acted = text::replace_all(&NEGATED_MOVEMENT, &without_direct_speech(&text_value), " ");
    let acted_heading = if acted == text_value { heading } else { destination_in(&acted, &context) };
    let left_place = captures(&LEAVE_OBJECT, &acted).and_then(|found| group(&found, 1).map(str::to_string)).unwrap_or_default();
    let leaves = text::test(&LEAVE_TARGET, &acted)
        || acted_heading.is_place
        || (text::test(&LEAVE_VERB, &acted) && text::test(exit_scope(), &acted))
        || text::test(bare_leave(), &acted)
        || names_known_place(&left_place, &context.known_places);
    if !leaves {
        return speech_travel_proposal(&text_value, &context);
    }
    Some(PartyExitRequest { destination: without_stray_quote(&acted_heading.destination), source: "text", destination_location_id: None })
}

/// Закрывающая кавычка без открывающей — хвост речи, а не часть названия.
fn without_stray_quote(value: &str) -> String {
    let opened = value.matches('«').count();
    let closed = value.matches('»').count();
    if closed > opened {
        js_trim(&text::replace_first(re!(r"»+\s*$", "u"), value, "")).to_string()
    } else {
        value.to_string()
    }
}

fn speech_request(destination: &str) -> Option<PartyExitRequest> {
    Some(PartyExitRequest { destination: without_stray_quote(destination), source: "speech", destination_location_id: None })
}

/// Уход, предложенный в прямой речи спутнику: «Пора искать ответы у Старого
/// Маяка; пойдём туда вместе». Зов «пойдём / идём / отправляемся» с названным
/// местом — это и есть заявка отряда. «Туда» указывает на известное место,
/// названное в той же реплике; место и зов бывают в разных репликах.
fn speech_travel_proposal(text_value: &str, context: &ExitContext) -> Option<PartyExitRequest> {
    let quoted: Vec<String> = all_captures(re!(r#"[«"“]([^«»"“”]{4,400})[»"”]"#, "gu"), text_value)
        .iter()
        .map(|found| group(found, 1).unwrap_or("").to_string())
        .collect();
    let mut speeches = quoted.clone();
    if quoted.len() > 1 {
        speeches.push(quoted.join(". "));
    }
    for raw in &speeches {
        let speech = compact(raw, 800);
        if !text::test(speech_travel_call(), &speech) || text::test(&NEGATED_MOVEMENT, &speech) {
            continue;
        }
        let heading = destination_in(&speech, context);
        if heading.is_place && !heading.destination.is_empty() {
            return speech_request(&heading.destination);
        }
        if text::test(re!(r"(?<![\p{L}\p{M}])туда(?![\p{L}\p{M}])", "iu"), &speech) {
            // Место ищется по именам с заглавной после предлога: «у Старого Маяка».
            let capitalized = re!(r"(?<![\p{L}\p{M}])(?:у|к|ко|в|во|на|до|около|возле|от)\s+((?:[А-ЯЁ][\p{L}-]*\s*){1,3})", "gu");
            for candidate in all_captures(capitalized, &speech) {
                let named = known_place_name(&compact(group(&candidate, 1).unwrap_or(""), 120), &context.known_places);
                if !named.is_empty() {
                    return Some(PartyExitRequest { destination: named, source: "speech", destination_location_id: None });
                }
            }
            // И словом места без заглавной: «пора к маяку на скале — … пойдём
            // туда вместе». После «у», «около», «возле» место в родительном —
            // проверяется его именительный.
            let any_case = re!(r"(?<![\p{L}\p{M}])(к|ко|в|во|на|до|у|около|возле)\s+([^,.;:!?—–«»]{3,80})", "giu");
            for candidate in all_captures(any_case, &speech) {
                let preposition = lower(group(&candidate, 1).unwrap_or(""));
                let phrase = js_trim(group(&candidate, 2).unwrap_or(""));
                let probe = if ["у", "около", "возле"].contains(&preposition.as_str()) {
                    destination_in(&format!("идём к {}", nominative_place_phrase(phrase)), context)
                } else {
                    destination_in(&format!("идём {preposition} {phrase}"), context)
                };
                if probe.is_place && !probe.destination.is_empty() {
                    return speech_request(&probe.destination);
                }
            }
        } else {
            // Без «туда» зов тоже ведёт к названному месту, если оно стоит с
            // предлогом направления. «В таверне поговорим» — где, а не куда.
            let toward = re!(r"(?<![\p{L}\p{M}])(к|ко|до)\s+([^,.;:!?—–«»]{3,80})", "giu");
            for candidate in all_captures(toward, &speech) {
                let probe = destination_in(
                    &format!("идём {} {}", lower(group(&candidate, 1).unwrap_or("")), js_trim(group(&candidate, 2).unwrap_or(""))),
                    context,
                );
                if probe.is_place && !probe.destination.is_empty() {
                    return speech_request(&probe.destination);
                }
            }
        }
    }
    None
}

/// Текст заявки без прямой речи: реплика после двоеточия или тире в кавычках.
/// Короткие кавычки остаются: так в заявке пишут названия мест.
fn without_direct_speech(text_value: &str) -> String {
    text::replace_all(re!(r"[:—–]\s*«[^«»]*[.!?,][^«»]*»", "gu"), text_value, " ")
}

/// Годится ли пункт назначения, названный судьёй свободных действий
/// (`route: travel`), в карточку ухода. Пустое назначение — «уйти отсюда» без
/// названия — допустимо.
pub fn travel_destination_is_place(destination: &str, options: &ExitOptions) -> bool {
    let cleaned = text::replace_all(re!(r"[«»]", "gu"), &compact(destination, 120), "");
    if cleaned.is_empty() {
        return true;
    }
    destination_in(&format!("Отправляемся в {cleaned}"), &options.context()).is_place
}

/// Пункт назначения, который игрок назвал, а словарь ухода местом не узнал:
/// «иду по свежим следам к провалу у старой арки». Пустая строка — если фраза
/// не о движении к названному месту, если место узнано (тогда это уход), если
/// названо то, что стоит в сцене, или если движение отрицается.
pub fn unrecognized_destination(action: &str, options: &ExitOptions) -> String {
    let text_value = compact(action, 2_000);
    if text_value.is_empty() || text::test(world_map_marker(), &text_value) || text::test(&NEGATED_MOVEMENT, &text_value) {
        return String::new();
    }
    let heading = destination_in(&text_value, &options.context());
    let destination = heading.destination;
    if destination.is_empty() || heading.is_place || heading.in_scene {
        return String::new();
    }
    if text::test(pronoun_destination(), &destination) || destination_is_not_place(&destination) {
        return String::new();
    }
    if detect_party_exit_request(&text_value, options).is_some() {
        return String::new();
    }
    destination
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Gender {
    Masculine,
    Feminine,
}

/// Окончания прилагательного в косвенном падеже → именительный; род — для существительного.
fn oblique_adjective(word: &str) -> Option<(String, Gender)> {
    const RULES: [(&str, &str, Gender); 10] = [
        ("ому", "ый", Gender::Masculine),
        ("ему", "ий", Gender::Masculine),
        ("ого", "ый", Gender::Masculine),
        ("его", "ий", Gender::Masculine),
        ("ом", "ый", Gender::Masculine),
        ("ем", "ий", Gender::Masculine),
        ("ой", "ая", Gender::Feminine),
        ("ей", "яя", Gender::Feminine),
        ("ую", "ая", Gender::Feminine),
        ("юю", "яя", Gender::Feminine),
    ];
    RULES.iter().find_map(|(ending, nominative, gender)| {
        word.strip_suffix(ending).map(|stem| (format!("{stem}{nominative}"), *gender))
    })
}

/// Именительный падеж для названия вида «прилагательное + существительное»:
/// «старому фамильному склепу за мельницей» — «старый фамильный склеп за
/// мельницей». Хвост после существительного не трогается. Если существительное
/// меняется не по правилу — беглая гласная, мягкий знак, — фраза остаётся как
/// была: лучше косвенный падеж, чем выдуманное слово.
pub fn nominative_place_phrase(phrase: &str) -> String {
    let words: Vec<String> = compact(phrase, 120).split(' ').filter(|word| !word.is_empty()).map(str::to_string).collect();
    // Голое существительное без определения: «к маяку на скале». Род по одному
    // слову не угадать, поэтому — только знакомые слова мест.
    if let Some(first) = words.first() {
        let bare = bare_nominative_place_noun(first);
        if !bare.is_empty() {
            let mut result = vec![keep_case(first, bare)];
            result.extend(words[1..].iter().cloned());
            return result.join(" ");
        }
    }
    let mut gender: Option<Gender> = None;
    let mut index = 0;
    let mut result = words.clone();
    while index < words.len() {
        let lowered = lower(&words[index]);
        let rule = if lowered.chars().count() > 4 { oblique_adjective(&lowered) } else { None };
        let Some((nominative, rule_gender)) = rule else {
            break;
        };
        if gender.is_some_and(|known| known != rule_gender) {
            return compact(phrase, 120);
        }
        gender = Some(rule_gender);
        result[index] = keep_case(&words[index], &nominative);
        index += 1;
    }
    let Some(gender) = gender else {
        return compact(phrase, 120);
    };
    if index >= words.len() {
        return compact(phrase, 120);
    }
    let noun = lower(&words[index]);
    let nominative = match gender {
        // Однозначно только после шипящих, «ц» и заднеязычных: мельнице, лавке,
        // реке → -а. Винительный: пещеру → -а, деревню → -я.
        Gender::Feminine => {
            if text::test(re!(r"[цкгхжшщч]е$", "u"), &noun) {
                text::replace_first(re!(r"е$", "u"), &noun, "а")
            } else if text::test(re!(r"у$", "u"), &noun) {
                text::replace_first(re!(r"у$", "u"), &noun, "а")
            } else if text::test(re!(r"ю$", "u"), &noun) {
                text::replace_first(re!(r"ю$", "u"), &noun, "я")
            } else {
                String::new()
            }
        }
        // Склепу, склепа, склепе → склеп; беглая гласная (замку, углу) не угадывается.
        Gender::Masculine => {
            let stem = text::replace_first(re!(r"[уае]$", "u"), &noun, "");
            let fleeting = text::test(re!(r"[бвгджзклмнпрстфхцчшщ][кгцлн]$", "u"), &stem)
                && text::test(re!(r"[кгцлн]$", "u"), &stem)
                && !text::test(re!(r"[аеёиоуыэюя][кгцлн]$", "u"), &stem);
            if stem != noun && text::test(re!(r"[бвгджзклмнпрстфхцчшщ]$", "u"), &stem) && !fleeting {
                stem
            } else {
                String::new()
            }
        }
    };
    if nominative.is_empty() {
        return compact(phrase, 120);
    }
    result[index] = keep_case(&words[index], &nominative);
    result.join(" ")
}

/// Слова мест, которые часто называют без определения: «к маяку», «в таверну».
const BARE_PLACE_NOUNS: [&str; 52] = [
    "маяк", "склеп", "храм", "лес", "порт", "причал", "мост", "холм", "утёс", "остров", "форт", "двор", "погреб", "сарай", "амбар",
    "курган", "овраг", "грот", "трактир", "город", "перевал", "тракт", "берег", "пирс", "склад", "особняк", "дворец", "бастион",
    "лагерь", "монастырь", "башня", "таверна", "пещера", "часовня", "мельница", "гавань", "крепость", "деревня", "роща", "кузница",
    "лавка", "площадь", "скала", "хижина", "усадьба", "пристань", "застава", "сторожка", "святилище", "кладбище", "болото", "озеро",
];

/// Именительный падеж знакомого слова места в косвенном: «маяку» — «маяк»,
/// «таверне» — «таверна». Уже именительный и незнакомое слово — пустая строка.
fn bare_nominative_place_noun(word: &str) -> &'static str {
    let lowered = lower(word).replace('ё', "е");
    for base in BARE_PLACE_NOUNS {
        let plain = base.replace('ё', "е");
        if lowered == plain {
            return "";
        }
        let stem = if text::test(re!(r"[аяьео]$", "u"), &plain) { text::slice(&plain, 0, Some(-1)) } else { plain.clone() };
        if let Some(rest) = lowered.strip_prefix(stem.as_str()) {
            if text::test(re!(r"^(?:|а|я|у|ю|е|и|ы|ом|ем|ой|ей|ою|ею)$", "u"), rest) {
                return base;
            }
        }
    }
    ""
}

/// Регистр первой буквы исходного слова переносится на новое.
fn keep_case(original: &str, replaced: &str) -> String {
    let first: String = original.chars().take(1).collect();
    if first != lower(&first) {
        upper_first(replaced)
    } else {
        replaced.to_string()
    }
}

/// Подпись пункта назначения для варианта «уходим … и идём …».
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DestinationLabel {
    pub phrase: String,
    pub place: String,
}

/// Пункт назначения для подписи варианта «уходим … и идём …»: известная точка
/// карты мира — её имя в кавычках; место, названное игроком своими словами, —
/// с его же предлогом и в его падеже; иначе — имя в именительном в кавычках.
/// `place` — то же место в именительном падеже, для «бросаем задание».
pub fn party_destination_label(text_value: &str, destination: &str, options: &ExitOptions) -> DestinationLabel {
    let place = js_trim(&text::replace_all(re!(r#"[«»"]"#, "gu"), &compact(destination, 120), "")).to_string();
    if place.is_empty() {
        return DestinationLabel { phrase: String::new(), place: String::new() };
    }
    let known = known_place_name(&place, &options.context().known_places);
    if !known.is_empty() {
        return DestinationLabel { phrase: format!("в «{known}»"), place: known };
    }
    let display = upper_first(&nominative_place_phrase(&place));
    let source = compact(text_value, 2_000);
    let source_chars: Vec<char> = source.chars().collect();
    let lowered = lower(&source);
    let at = lowered.find(&lower(&place)).map(|byte| lowered[..byte].chars().count());
    // Предлог игрока прямо перед названием, без кавычек: фраза уже согласована.
    if let Some(at) = at.filter(|at| *at > 0 && *at <= source_chars.len()) {
        let before: String = source_chars[at.saturating_sub(6)..at].iter().collect();
        let preposition = text::capture(re!(r"(?:^|\s)(в|во|на|к|ко|до)\s+$", "iu"), &before, 1);
        if let Some(preposition) = preposition.filter(|_| source_chars[at - 1] != '«') {
            let length = place.chars().count();
            let spoken: String = source_chars[at..(at + length).min(source_chars.len())].iter().collect();
            return DestinationLabel { phrase: format!("{} {spoken}", lower(&preposition)), place: display };
        }
    }
    DestinationLabel { phrase: format!("в «{display}»"), place: display }
}

/// Объявляет ли фраза движение отряда куда-либо — без решения, уход ли это.
/// Карты на этом шаге ещё нет, поэтому спрашивается только форма: глагол ухода
/// или движения с предлогом.
pub fn announces_movement(action: &str) -> bool {
    let text_value = compact(action, 2_000);
    if text_value.is_empty() {
        return false;
    }
    text::test(&DESTINATION, &text_value)
        || text::test(&LEAVE_TARGET, &text_value)
        || text::test(bare_leave(), &text_value)
        || (text::test(&LEAVE_VERB, &text_value) && text::test(exit_scope(), &text_value))
}

/// Разбор уже выбранного варианта голосования.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyDecision {
    /// `move`, `stay` или `other`.
    pub kind: &'static str,
    pub destination_hint: String,
    pub abandons_quest: bool,
}

/// Разбор уже выбранного варианта голосования. `abandons_quest` независим от
/// вида решения: бросить задание можно и уходя, и оставаясь.
pub fn classify_party_decision(decision: &str) -> PartyDecision {
    let text_value = compact(decision, 500);
    let abandons_quest = text::test(abandon(), &text_value);
    if let Some(exit) = detect_party_exit_request(&text_value, &ExitOptions::default()) {
        if !text::test(stay_overrides_exit(), &text_value) {
            return PartyDecision { kind: "move", destination_hint: exit.destination, abandons_quest };
        }
    }
    let kind = if text::test(stay(), &text_value) { "stay" } else { "other" };
    PartyDecision { kind, destination_hint: String::new(), abandons_quest }
}

fn letter_words(value: &str) -> Vec<String> {
    text::find_all(re!(r"\p{L}+", "gu"), &lower(value).replace('ё', "е"))
}

fn adjective_ending() -> &'static Regex {
    re!(r"(?:ой|ый|ий|ая|яя|ое|ее|ые|ие|ую|юю|ого|его|ому|ему|ым|им|ых|их|ей|ыми|ими)$", "u")
}

/// Главное ли слово назначения — не место: «другой путь к разгадке», «выход»,
/// «новую зацепку». Главное слово — первое существительное после определений;
/// если по окончаниям похожи на определение все слова, — последнее.
pub fn destination_is_not_place(destination: &str) -> bool {
    let not_place_adjective = re!(
        r"^(?:друг|ин|нов|следующ|прежн|верн|правильн|нужн|обходн|безопасн|кратчайш|коротк)(?:ой|ый|ий|ая|яя|ое|ее|ые|ие|ую|юю|ого|его|ому|ему|ым|им|ых|их|ей|ыми|ими)$",
        "u"
    );
    let not_place_noun = re!(
        r"^(?:пут(?:ь|и|ем|ём)|(?:выход|вход|способ|ответ|разгадк|зацепк|след|тайн|правд|истин|решени|причин|смысл|помощ|подсказк|улик|доказательств)\p{L}{0,3}|цел(?:ь|и|ью|ей|ям|ями|ях))$",
        "u"
    );
    let words: Vec<String> = letter_words(destination).into_iter().filter(|word| js_len(word) >= 3).collect();
    let meaningful: Vec<&String> = words.iter().filter(|word| !text::test(not_place_adjective, word)).collect();
    if meaningful.is_empty() {
        return !words.is_empty();
    }
    let head_word = meaningful
        .iter()
        .find(|word| !text::test(adjective_ending(), word))
        .or_else(|| meaningful.last())
        .map(|word| word.as_str())
        .unwrap_or("");
    text::test(not_place_noun, head_word)
}

/// Называет ли цель сцены это место: «Добраться до смотровой дамбы» и
/// «смотровая дамба». Слова сравниваются по общему началу — падеж у цели и у
/// назначения разный.
pub fn objective_names_destination(destination: &str, objective: &str) -> bool {
    let wanted: Vec<String> = letter_words(destination).into_iter().filter(|word| js_len(word) >= 4).collect();
    let goal = letter_words(objective);
    if wanted.is_empty() || goal.is_empty() {
        return false;
    }
    if destination_is_not_place(destination) {
        return false;
    }
    let same_word = |left: &str, right: &str| {
        let left: Vec<char> = left.chars().collect();
        let right: Vec<char> = right.chars().collect();
        let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
        common >= 4 && common as i64 >= left.len().min(right.len()) as i64 - 2
    };
    wanted.iter().all(|word| goal.iter().any(|candidate| same_word(word, candidate)))
}

fn subordinate_start() -> &'static Regex {
    re!(
        r"^(?:кто|что|чтобы|котор\p{L}*|где|куда|откуда|когда|как|кому|кого|чей|чья|чьё|чьи|пока|если|ведь)(?![\p{L}\p{M}])",
        "iu"
    )
}

fn movement_start() -> &'static Regex {
    re!(
        r"^(?:до(?:браться|йти|ехать|плыть|бежать|лететь|скакать)|при(?:йти|быть|ехать|плыть)|попасть|вернуться|отправиться|пройти|проникнуть|спуститься|подняться|выйти|пробраться|добрести)(?![\p{L}\p{M}])",
        "iu"
    )
}

/// Части цели по запятым и союзу «и». Придаточное («…, кто звонит») — часть
/// прежней задачи, а не новая: оно приклеивается к предыдущей.
fn objective_parts(text_value: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for raw in split(re!(r"\s*[,;]\s*|\s+и\s+", "u"), text_value) {
        let part = js_trim(&raw).to_string();
        if part.is_empty() {
            continue;
        }
        match parts.last_mut() {
            Some(last) if text::test(subordinate_start(), &part) => *last = format!("{last}, {part}"),
            _ => parts.push(part),
        }
    }
    parts
}

fn objective_text(objective: &str) -> String {
    text::replace_first(re!(r"[.!?…]+$", "u"), &compact(objective, 300), "")
}

/// Зовёт ли цель сцены отряд в это место словами о приходе: «Добраться до
/// смотровой дамбы, понять источник звона…» зовёт на дамбу. «Расспросить
/// смотрительницу дамбы» место называет, но никуда не зовёт.
pub fn objective_calls_to(destination: &str, objective: &str) -> bool {
    let text_value = objective_text(objective);
    if text_value.is_empty() || !objective_names_destination(destination, &text_value) {
        return false;
    }
    objective_parts(&text_value)
        .iter()
        .any(|part| text::test(movement_start(), part) && objective_names_destination(destination, part))
}

/// Что остаётся от цели, когда отряд пришёл в названное ею место. Части цели
/// делятся по запятым и союзу «и»; уходит та, что сама о приходе. Пустая
/// строка — цель исчерпана самим приходом; `None` — цель это место не называет.
pub fn objective_remainder(objective: &str, destination: &str) -> Option<String> {
    let text_value = objective_text(objective);
    if text_value.is_empty() || !objective_names_destination(destination, &text_value) {
        return None;
    }
    let parts = objective_parts(&text_value);
    // Приход исполняет только ту часть, что сама о приходе: «добраться до дамбы».
    let rest: Vec<&String> = parts
        .iter()
        .filter(|part| !(text::test(movement_start(), part) && objective_names_destination(destination, part)))
        .collect();
    if rest.len() == parts.len() {
        return Some(upper_first(&text_value));
    }
    let Some((last, others)) = rest.split_last() else {
        return Some(String::new());
    };
    let joined = if others.is_empty() {
        (*last).clone()
    } else {
        format!("{} и {last}", others.iter().map(|part| part.as_str()).collect::<Vec<_>>().join(", "))
    };
    Some(upper_first(&joined))
}

/// Цель промежуточной точки составного маршрута: «Продолжить путь из Айрская
/// башня к «Дормар»». Следующий пункт маршрута хранится только в этой цели,
/// поэтому формула одна на всех, кто её пишет и читает.
pub fn onward_route_objective(from: &str, destination: &str) -> String {
    format!("Продолжить путь из {} к «{}»", compact(from, 120), compact(destination, 120))
}

/// Конечная точка маршрута из цели промежуточной точки; пустая строка — цель не
/// такая. Узнаётся только формула самого сервера ([`onward_route_objective`]).
pub fn onward_route_target(objective: &str) -> String {
    let objective = compact(objective, 300);
    let target = text::capture(re!(r"^Продолжить путь из .+ к «([^«»]{1,120})»$", "u"), &objective, 1).unwrap_or_default();
    compact(&target, 120)
}

/// Следующий пункт маршрута, если сцена — промежуточная точка. Пустая строка,
/// если цель не такая или зовёт туда, где отряд уже стоит.
pub fn pending_onward_target(scene: Option<&Value>) -> String {
    let target = onward_route_target(&js::s(scene.and_then(|scene| scene.get("objective"))));
    if target.is_empty() {
        return target;
    }
    let location = compact(&js::s(scene.and_then(|scene| scene.get("location"))), 120);
    if lower(&target) == lower(&location) {
        String::new()
    } else {
        target
    }
}

/// «Продолжим», «продолжаем путь», «идём дальше». Места фраза не называет и
/// уходом сама по себе не является: смысл у неё появляется только на
/// промежуточной точке маршрута. «Продолжим приключение» сюда не входит.
pub fn is_route_continuation(action: &str) -> bool {
    let lowered = lower(&compact(action, 200));
    let stripped = text::replace_first(re!(r"[.!…]+$", "u"), &lowered, "");
    let text_value = js_trim(&stripped);
    !text_value.is_empty()
        && text::test(
            re!(
                r"^(?:(?:ну|итак|ладно|что\s+ж|давайте|давай|ребята|всё|все)[,!.]?\s+){0,2}(?:продолж(?:им|аем|ить)(?:\s+(?:путь|маршрут|дорогу|путешествие|поход))?|(?:ид[её]м|пойд[её]м|пошли|двигаемся|двинемся|едем|поехали|отправляемся)\s+дальше|(?:дальше\s+)?в\s+путь)$",
                "iu"
            ),
            text_value,
        )
}

/// Уход к следующему пункту маршрута по фразе «продолжим». Пункт должен быть
/// известной точкой карты мира; идентификатор берётся, только если имя на
/// карте однозначно.
pub fn onward_route_exit_request(action: &str, state: &Value) -> Option<PartyExitRequest> {
    if !is_route_continuation(action) {
        return None;
    }
    let target = pending_onward_target(state.get("scene"));
    if target.is_empty() {
        return None;
    }
    let known: Vec<&Value> = array(state.get("worldMap").and_then(|map| map.get("locations")))
        .iter()
        .filter(|entry| {
            js::truthy(entry.get("id"))
                && !js::is_false(entry.get("known"))
                && !js::is_true(entry.get("hidden"))
                && !is_str(entry.get("visibility"), "gm_only")
                && compact(&js::s(entry.get("name")), 120) == target
        })
        .collect();
    if known.is_empty() {
        return None;
    }
    let destination_location_id = (known.len() == 1).then(|| js::s(known[0].get("id")));
    Some(PartyExitRequest { destination: target, source: "route", destination_location_id })
}

/// Задание, от которого отряд может отказаться.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AbandonableQuest {
    pub id: String,
    pub title: String,
}

/// Задание, от которого отряд отказывается: основная нить, а не служебный квест
/// главы (`quest:chapter:`). Скрытые от отряда (`gm_only`) отсеиваются здесь:
/// результат попадает в подпись варианта голосования на глаза всему столу.
pub fn abandonable_quest(state: &Value) -> Option<AbandonableQuest> {
    let quests = array(state.get("worldMemory").and_then(|memory| memory.get("quests")));
    let active: Vec<&Value> =
        quests.iter().filter(|quest| is_str(quest.get("status"), "active") && !is_str(quest.get("visibility"), "gm_only")).collect();
    let quest = active
        .iter()
        .find(|item| !js::s(item.get("id")).starts_with("quest:chapter:"))
        .or_else(|| active.first())
        .copied()?;
    if !js::truthy(quest.get("id")) {
        return None;
    }
    let id = js::s(quest.get("id"));
    let title = compact(&js::s(quest.get("title")), 160);
    Some(AbandonableQuest { title: if title.is_empty() { id.clone() } else { title }, id })
}
