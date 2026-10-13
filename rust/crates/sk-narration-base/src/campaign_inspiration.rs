//! Перенос `server/campaign-inspiration.mjs`: зерно вдохновения для новой
//! кампании.
//!
//! При пустом мастере модель каждый раз получала один и тот же текст и выдавала
//! один и тот же средний мир; зерно подмешивает случайную комбинацию
//! ориентиров. Правило приоритета жёсткое: **заполненное игроком всегда важнее
//! зерна** — ориентир подставляется только туда, где мастер оставлен пустым.
//! Случайность — серверным броском через [`sk_dice::Dice`].

use serde::Serialize;
use serde_json::{Map, Value};
use sk_core::text;
use sk_dice::{Dice, DiceError, Visibility};

use crate::jsx;

pub const CAMPAIGN_INSPIRATION_POLICY_ID: &str = "skazanie:campaign-inspiration-v1";

/// Жанровый уклон — крен, который отличает две истории.
pub const INSPIRATION_GENRE_LEANS: &[&str] = &[
    "мрачное героическое фэнтези с ценой за каждую победу",
    "плутовская история про хитрость, долги и чужие тайны",
    "мистический детектив, где расследование важнее сражения",
    "приключение на фронтире: карта белая, законов нет",
    "политическая интрига между домами и гильдиями",
    "выживание в мире, который уже почти проиграл",
    "сказочное фэнтези с договорами, запретами и ценой слова",
    "морская авантюра: паруса, контракты и чужие берега",
    "мифологический поход к тому, чего лучше не будить",
    "ремесленный, приземлённый мир, где чудо стоит дорого",
    "осадная драма: город держится, и держаться всё труднее",
    "дорожная история про караван, который нельзя бросить",
];

/// Тип региона и стартового места с подсказкой для процедурной карты.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct InspirationRegion {
    pub label: &'static str,
    pub theme: &'static str,
    pub layout: &'static str,
    pub danger: &'static str,
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub water: f64,
}

const fn region(label: &'static str, theme: &'static str, layout: &'static str, danger: &'static str, water: f64) -> InspirationRegion {
    InspirationRegion { label, theme, layout, danger, water }
}

pub const INSPIRATION_REGIONS: &[InspirationRegion] = &[
    region("портовый город на солёных сваях", "портовый город", "streets", "средняя", 0.18),
    region("горная крепость над перевалом", "горная крепость", "rooms", "высокая", 0.01),
    region("караван-стоянка в пустыне", "пустынная стоянка каравана", "open", "высокая", 0.01),
    region("болотный скит на сваях", "болотный скит", "open", "средняя", 0.22),
    region("подземный город в выработанной шахте", "подземный город", "rooms", "высокая", 0.04),
    region("пограничная застава у старого тракта", "пограничная застава", "streets", "средняя", 0.03),
    region("речная переправа с мостом и мытней", "речная переправа", "streets", "низкая", 0.20),
    region("монастырь на отвесной скале", "горный монастырь", "rooms", "низкая", 0.02),
    region("рудничный посёлок под дымом плавилен", "рудничный посёлок", "streets", "средняя", 0.03),
    region("лесная деревня среди вековых стволов", "лесная деревня", "open", "средняя", 0.06),
    region("заброшенная станция на краю степи", "степная станция", "open", "высокая", 0.02),
    region("плавучий рынок на затопленных улицах", "затопленный город", "streets", "средняя", 0.30),
    region("ярмарочный городок в разгар сезона", "ярмарочный городок", "streets", "низкая", 0.05),
    region("сторожевой маяк на голом мысу", "прибрежный маяк", "rooms", "средняя", 0.25),
];

/// Природа завязки: что именно случилось.
pub const INSPIRATION_HOOKS: &[&str] = &[
    "исчезновение: пропал человек, и его искали не там",
    "наследство: имущество досталось тем, кто его не ждал",
    "эпидемия: болезнь идёт быстрее, чем слухи о ней",
    "ересь: старую веру толкуют по-новому, и это уже не спор",
    "контрабанда: через это место возят то, чего возить нельзя",
    "осада: помощь обещана, но её никто не видел",
    "долг: с отряда требуют по счёту, который они не подписывали",
    "подлог: документ, на котором держится порядок, оказался поддельным",
    "возвращение: тот, кого похоронили, объявился и требует своё",
    "находка: выкопали то, что закапывали намеренно",
    "предательство: союзник уже сделал выбор, но ещё не признался",
    "засуха: ресурса не хватит на всех, и делить его будут не поровну",
    "переселение: люди уходят, и кто-то очень не хочет их отпускать",
    "суд: приговор вынесут через несколько дней, и он неправый",
];

/// Необычная деталь мира: одна конкретность, за которую цепляется история.
pub const INSPIRATION_DETAILS: &[&str] = &[
    "здесь принято хоронить долги, а не покойников: могилы именные, но пустые",
    "все двери в городе открываются наружу — после прошлой беды так постановили",
    "местные считают эхо живым и не разговаривают в узких местах",
    "колокол звонит не по времени, а когда меняется ветер",
    "у каждого ремесла свой запрет, и нарушивший меняет ремесло",
    "на перекрёстках оставляют чужие вещи: забрать — значит принять чью-то судьбу",
    "единственная карта этих мест хранится в одном экземпляре и врёт намеренно",
    "ночью в квартале гасят весь огонь, и никто не объясняет зачем",
    "детей здесь называют дважды: одним именем для людей, другим для места",
    "воду продают по родству: чужому дороже, и это записано в правилах",
    "старые стены разбирают на новые дома, поэтому у каждого дома чужая история",
    "клятву дают, отдавая вещь, и вернуть её может только тот, кому клялись",
    "дважды в год город меняет названия улиц, чтобы сбить с толку тех, кто ищет",
    "у каждого дома на пороге лежит камень с чужого поля — знак принятого гостя",
];

/// Зерно для кампании (`drawCampaignInspiration`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CampaignInspiration {
    pub policy_id: &'static str,
    pub applied: bool,
    #[serde(rename = "genreLean")]
    pub genre_lean: Option<&'static str>,
    pub region: Option<&'static InspirationRegion>,
    pub hook: Option<&'static str>,
    pub detail: Option<&'static str>,
}

/// `String(value ?? '').trim()` поля мастера.
fn filled(world: &Value, key: &str) -> bool {
    !text::trim(&jsx::string(world.get(key))).is_empty()
}

/// Один элемент пула серверным броском `1dN` (без костей — первый элемент).
fn pick<T: Copy>(pool: &[T], dice: &mut Option<&mut dyn Dice>, purpose: &str) -> Result<T, DiceError> {
    let Some(dice) = dice else {
        return Ok(pool[0]);
    };
    let roll = dice.roll(&format!("1d{}", pool.len()), purpose, Some("campaign-bootstrap"), Visibility::GmOnly)?;
    // `Number(roll.total) || 1`: ноль — как единица.
    let total = if roll.total == 0 { 1 } else { roll.total };
    let index = total.clamp(1, pool.len() as i64) - 1;
    Ok(pool[index as usize])
}

/// `drawCampaignInspiration({ world, diceService })`. Если мастер заполнен
/// целиком, `applied` — `false` и в задание модели ничего не подмешивается.
/// Деталь подмешивается при любом пробеле. Порядок бросков — жанр, регион,
/// завязка, деталь. Не объект `world` считается пустым мастером (в JS `null`
/// бросил бы `TypeError`).
pub fn draw_campaign_inspiration(world: Option<&Value>, mut dice: Option<&mut dyn Dice>) -> Result<CampaignInspiration, DiceError> {
    let empty_world = Value::Object(Map::new());
    let world = world.filter(|value| !value.is_null()).unwrap_or(&empty_world);
    let genre = !filled(world, "genre") && !filled(world, "preset");
    let place = !filled(world, "startingLocation");
    let story = !filled(world, "premise") && !filled(world, "openingSituation") && !filled(world, "themes");
    if !(genre || place || story) {
        return Ok(CampaignInspiration { policy_id: CAMPAIGN_INSPIRATION_POLICY_ID, applied: false, genre_lean: None, region: None, hook: None, detail: None });
    }
    let genre_lean = if genre { Some(pick(INSPIRATION_GENRE_LEANS, &mut dice, "campaign_inspiration:genre")?) } else { None };
    let region = if place {
        let regions: Vec<&'static InspirationRegion> = INSPIRATION_REGIONS.iter().collect();
        Some(pick(&regions, &mut dice, "campaign_inspiration:region")?)
    } else {
        None
    };
    let hook = if story { Some(pick(INSPIRATION_HOOKS, &mut dice, "campaign_inspiration:hook")?) } else { None };
    let detail = Some(pick(INSPIRATION_DETAILS, &mut dice, "campaign_inspiration:detail")?);
    Ok(CampaignInspiration { policy_id: CAMPAIGN_INSPIRATION_POLICY_ID, applied: true, genre_lean, region, hook, detail })
}

/// `inspirationPromptSeed(inspiration)`: зерно для задания модели или `None`,
/// когда подмешивать нечего.
pub fn inspiration_prompt_seed(inspiration: Option<&CampaignInspiration>) -> Option<Value> {
    let inspiration = inspiration.filter(|inspiration| inspiration.applied)?;
    let mut seed = Map::new();
    seed.insert(
        "note".into(),
        Value::String("Ориентиры только для полей, которые владелец оставил пустыми. Всё, что владелец указал явно, важнее этих ориентиров и не переписывается.".into()),
    );
    if let Some(genre) = inspiration.genre_lean.filter(|genre| !genre.is_empty()) {
        seed.insert("genre_lean".into(), Value::String(genre.into()));
    }
    if let Some(region) = inspiration.region {
        seed.insert("region".into(), Value::String(region.label.into()));
    }
    if let Some(hook) = inspiration.hook.filter(|hook| !hook.is_empty()) {
        seed.insert("hook_nature".into(), Value::String(hook.into()));
    }
    if let Some(detail) = inspiration.detail.filter(|detail| !detail.is_empty()) {
        seed.insert("world_detail".into(), Value::String(detail.into()));
    }
    Some(Value::Object(seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sk_dice::{DiceService, SequenceRng};

    fn dice(values: &[i64]) -> DiceService<SequenceRng> {
        DiceService::deterministic(SequenceRng::new(values.to_vec()), "inspiration-roll")
    }

    fn draw(world: Value, values: &[i64]) -> CampaignInspiration {
        let mut service = dice(values);
        draw_campaign_inspiration(Some(&world), Some(&mut service)).expect("зерно")
    }

    #[test]
    fn pools_are_large_and_meaningful() {
        let pools: [(&str, Vec<&str>); 4] = [
            ("жанровые уклоны", INSPIRATION_GENRE_LEANS.to_vec()),
            ("регионы", INSPIRATION_REGIONS.iter().map(|region| region.label).collect()),
            ("завязки", INSPIRATION_HOOKS.to_vec()),
            ("детали мира", INSPIRATION_DETAILS.to_vec()),
        ];
        for (name, keys) in pools {
            assert!(keys.len() >= 10, "{name}: нужно не меньше десяти позиций");
            let unique: std::collections::HashSet<&&str> = keys.iter().collect();
            assert_eq!(unique.len(), keys.len(), "{name}: позиции повторяются");
            for key in keys {
                assert!(crate::jsx::utf16_len(key) > 12, "{name}: слишком короткая позиция «{key}»");
            }
        }
        for region in INSPIRATION_REGIONS {
            assert!(["streets", "rooms", "open"].contains(&region.layout), "{}", region.label);
            assert!((0.0..=1.0).contains(&region.water), "{}", region.label);
            assert!(crate::jsx::utf16_len(region.theme) > 3, "{}", region.label);
        }
    }

    #[test]
    fn seed_fills_only_empty_fields() {
        let empty = draw(json!({}), &[3, 5, 7, 9]);
        assert!(empty.applied);
        assert!(empty.genre_lean.is_some() && empty.region.is_some() && empty.hook.is_some() && empty.detail.is_some());
        let with_place = draw(json!({ "startingLocation": "Портовый город Тир" }), &[3, 7, 9]);
        assert_eq!(with_place.region, None, "указанное владельцем место не переписывается");
        assert!(with_place.genre_lean.is_some() && with_place.hook.is_some());
        assert_eq!(draw(json!({ "genre": "нуар" }), &[3, 7, 9]).genre_lean, None);
        assert_eq!(draw(json!({ "preset": "киберпанк" }), &[3, 7, 9]).genre_lean, None);
        assert_eq!(draw(json!({ "premise": "Король умер" }), &[3, 7, 9]).hook, None);
        assert_eq!(draw(json!({ "openingSituation": "Отряд на суде" }), &[3, 7, 9]).hook, None);
        let full = draw(json!({ "genre": "нуар", "startingLocation": "Тир", "premise": "Король умер" }), &[1]);
        assert!(!full.applied);
        assert_eq!(inspiration_prompt_seed(Some(&full)), None);
    }

    #[test]
    fn different_rolls_give_different_seeds() {
        let first = draw(json!({}), &[1, 1, 1, 1]);
        let second = draw(json!({}), &[2, 2, 2, 2]);
        let repeat = draw(json!({}), &[1, 1, 1, 1]);
        assert_ne!(first, second, "другой бросок обязан дать другое зерно");
        assert_eq!(first, repeat, "тот же бросок обязан дать то же зерно");
        let layouts: std::collections::HashSet<&str> =
            [[1, 1, 1, 1], [1, 2, 1, 1], [1, 3, 1, 1]].iter().map(|values| draw(json!({}), values).region.expect("регион").layout).collect();
        assert!(layouts.len() > 1, "планировка обязана следовать за регионом");
    }

    #[test]
    fn prompt_seed_carries_owner_priority_note() {
        let seed = inspiration_prompt_seed(Some(&draw(json!({}), &[4, 6, 8, 10]))).expect("зерно");
        assert!(sk_core::text::test(sk_core::re!(r"важнее|не переписыва", "u"), seed["note"].as_str().expect("строка")));
        let mut keys: Vec<&String> = seed.as_object().expect("объект").keys().collect();
        keys.sort();
        assert_eq!(keys, ["genre_lean", "hook_nature", "note", "region", "world_detail"]);
        let partial = inspiration_prompt_seed(Some(&draw(json!({ "startingLocation": "Тир" }), &[4, 8, 10]))).expect("зерно");
        assert!(partial.get("region").is_none());
    }

    #[test]
    fn without_dice_the_first_entry_is_taken() {
        let drawn = draw_campaign_inspiration(None, None).expect("зерно");
        assert_eq!(drawn.genre_lean, Some(INSPIRATION_GENRE_LEANS[0]));
        assert_eq!(drawn.region, Some(&INSPIRATION_REGIONS[0]));
        assert_eq!(drawn.detail, Some(INSPIRATION_DETAILS[0]));
        let value = serde_json::to_value(drawn).expect("json");
        assert_eq!(value["region"]["water"], json!(0.18));
        assert_eq!(value["genreLean"], json!(INSPIRATION_GENRE_LEANS[0]));
    }
}
