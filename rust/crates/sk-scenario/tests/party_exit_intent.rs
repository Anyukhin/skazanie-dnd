//! Сверка `party_exit_intent` с эталоном JS (`fixtures/party-exit-intent.json`,
//! генератор — `fixtures/gen-party-exit-intent.mjs`) и перенесённые проверки
//! `test/party-exit-intent.test.mjs`, `test/free-text-travel.test.mjs`,
//! `test/intent-routing.test.mjs`, `test/objective-continues.test.mjs`.

use serde::Serialize;
use serde_json::{json, Value};
use sk_scenario::party_exit_intent::*;

const FIXTURE: &str = include_str!("../fixtures/party-exit-intent.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("эталон — JSON")
}

fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("сериализация")
}

/// Сравнение с эталоном: значение, порядок ключей и текст ошибки.
struct Diff {
    checked: usize,
    failures: Vec<String>,
}

impl Diff {
    fn new() -> Self {
        Self { checked: 0, failures: Vec::new() }
    }

    fn check(&mut self, what: &str, input: &str, actual: Value, expected: Option<&Value>, default: Value) {
        let expected = expected.cloned().unwrap_or(default);
        if expected.get("throws").is_some() {
            return;
        }
        self.checked += 1;
        let same = actual == expected && serde_json::to_string(&actual).ok() == serde_json::to_string(&expected).ok();
        if !same {
            self.failures.push(format!("{what}({input:?}):\n    rust: {actual}\n    js:   {expected}"));
        }
    }

    fn finish(self, label: &str) {
        let total = self.failures.len();
        let shown: Vec<&String> = self.failures.iter().take(40).collect();
        assert!(total == 0, "{label}: расхождений с JS {total} из {}:\n{}", self.checked, shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
        eprintln!("{label}: сверено {} значений", self.checked);
    }
}

fn str_of(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

#[test]
fn phrases_match_js() {
    let data = fixture();
    assert_eq!(data["world_map_travel_marker"], WORLD_MAP_TRAVEL_MARKER);
    let contexts: Vec<ExitOptions> = data["contexts"].as_array().expect("контексты").iter().map(ExitOptions::from_value).collect();
    let mut diff = Diff::new();
    for case in data["cases"].as_array().expect("фразы") {
        let text = str_of(&case["text"]);
        for run in case["runs"].as_array().expect("прогоны") {
            let options = &contexts[run["ctx"].as_u64().expect("контекст") as usize];
            let input = format!("{text} / ctx {}", run["ctx"]);
            let detected = detect_party_exit_request(text, options);
            diff.check("detect", &input, detected.as_ref().map_or(Value::Null, to_value), run.get("detect"), Value::Null);
            diff.check("unrecognized", &input, json!(unrecognized_destination(text, options)), run.get("unrecognized"), json!(""));
            diff.check("travel_is_place", &input, json!(travel_destination_is_place(text, options)), run.get("travel_is_place"), json!(false));
            if let Some(label) = run.get("label") {
                let destination = str_of(&run["detect"]["destination"]);
                diff.check("label", &input, to_value(party_destination_label(text, destination, options)), Some(label), Value::Null);
            }
            if let Some(label) = run.get("label_unrecognized") {
                let destination = str_of(&run["unrecognized"]);
                diff.check("label_unrecognized", &input, to_value(party_destination_label(text, destination, options)), Some(label), Value::Null);
            }
        }
        diff.check("announces", text, json!(announces_movement(text)), case.get("announces"), json!(false));
        diff.check(
            "classify",
            text,
            to_value(classify_party_decision(text)),
            case.get("classify"),
            json!({ "kind": "other", "destinationHint": "", "abandonsQuest": false }),
        );
        diff.check("route_continuation", text, json!(is_route_continuation(text)), case.get("route_continuation"), json!(false));
        diff.check("nominative", text, json!(nominative_place_phrase(text)), case.get("nominative"), json!(text));
        diff.check("not_place", text, json!(destination_is_not_place(text)), case.get("not_place"), json!(false));
        diff.check("onward_target", text, json!(onward_route_target(text)), case.get("onward_target"), json!(""));
    }
    diff.finish("фразы");
}

#[test]
fn names_objectives_routes_match_js() {
    let data = fixture();
    let mut diff = Diff::new();
    for case in data["names"].as_array().expect("имена") {
        let text = str_of(&case["text"]);
        diff.check("nominative", text, json!(nominative_place_phrase(text)), case.get("nominative"), Value::Null);
        diff.check("not_place", text, json!(destination_is_not_place(text)), case.get("not_place"), Value::Null);
        diff.check("travel_is_place", text, json!(travel_destination_is_place(text, &ExitOptions::default())), case.get("travel_is_place"), Value::Null);
    }
    for case in data["objectives"].as_array().expect("цели") {
        let (objective, destination) = (str_of(&case["objective"]), str_of(&case["destination"]));
        let input = format!("{objective} / {destination}");
        diff.check("names", &input, json!(objective_names_destination(destination, objective)), case.get("names"), Value::Null);
        diff.check("calls", &input, json!(objective_calls_to(destination, objective)), case.get("calls"), Value::Null);
        diff.check("remainder", &input, json!(objective_remainder(objective, destination)), case.get("remainder"), Value::Null);
    }
    let route_states = data["route_states"].as_array().expect("состояния маршрута");
    for case in data["routes"].as_array().expect("маршруты") {
        let state = &route_states[case["state"].as_u64().expect("индекс") as usize];
        let action = str_of(&case["action"]);
        let request = onward_route_exit_request(action, state);
        diff.check("onward_request", &format!("{action} / {state}"), request.map_or(Value::Null, to_value), case.get("request"), Value::Null);
    }
    for case in data["scenes"].as_array().expect("сцены") {
        let scene = Some(&case["scene"]).filter(|scene| !scene.is_null());
        diff.check("pending_onward", &case["scene"].to_string(), json!(pending_onward_target(scene)), case.get("target"), Value::Null);
    }
    for case in data["formulas"].as_array().expect("формулы") {
        let (from, to) = (str_of(&case["from"]), str_of(&case["to"]));
        diff.check("onward_objective", &format!("{from} → {to}"), json!(onward_route_objective(from, to)), case.get("objective"), Value::Null);
    }
    for case in data["quests"].as_array().expect("задания") {
        let quest = abandonable_quest(&case["state"]);
        diff.check("abandonable_quest", &case["state"].to_string(), quest.map_or(Value::Null, to_value), case.get("quest"), Value::Null);
    }
    for case in data["context_states"].as_array().expect("контексты состояний") {
        diff.check("exit_context", &case["state"].to_string(), to_value(exit_context_from_state(&case["state"])), case.get("context"), Value::Null);
    }
    diff.finish("имена, цели и маршруты");
}

fn options(known: &[&str], present: &[&str]) -> ExitOptions {
    ExitOptions {
        known_places: known.iter().map(|name| name.to_string()).collect(),
        present_names: present.iter().map(|name| name.to_string()).collect(),
    }
}

fn detect(text: &str) -> Option<PartyExitRequest> {
    detect_party_exit_request(text, &ExitOptions::default())
}

fn destination(text: &str) -> Option<String> {
    detect(text).map(|request| request.destination)
}

#[test]
fn exit_forms_and_tactical_steps() {
    for phrase in [
        "Уходим отсюда",
        "Валим отсюда",
        "Я хочу уйти из таверны",
        "Предлагаю покинуть это подземелье",
        "Идём в город",
        "Возвращаемся в город",
        "Отправляемся на тракт",
        "Сваливаем из этого склепа",
    ] {
        assert!(detect(phrase).is_some(), "{phrase}");
    }
    for phrase in [
        "Идём к двери",
        "Уходим в тень",
        "Отступаем в угол",
        "Открываю сундук",
        "Поднимаюсь по лестнице",
        "Осматриваю комнату",
        "Возвращаюсь к разговору с торговцем",
        "Что я знаю про печать архивариуса?",
        "Иду в угол таверны",
        "Иду в зал таверны",
        "Иду к стойке",
        "Иду в тень",
        "Иду на причал осмотреться",
    ] {
        assert_eq!(detect(phrase), None, "{phrase}");
    }
}

#[test]
fn world_map_marker_reads_quotes_and_destination_id() {
    let request = detect("[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Заброшенный Караван-сарай» в «Каменный Град». Выбранный путь: Заброшенный Караван-сарай → Каменный Град.")
        .expect("заявка");
    assert_eq!(request.source, "world-map");
    assert_eq!(request.destination, "Каменный Град");
    let encoded = "%D1%84%D0%BE%D1%80%D1%82%3A%D0%A1%D0%B5%D0%B2%D0%B5%D1%80%D0%BD%D1%8B%D0%B5%20%D0%B2%D1%80%D0%B0%D1%82%D0%B0";
    assert_eq!(
        to_value(detect(&format!("[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id={encoded}] Отряд предлагает отправиться из «Брод» в «Северный форт».")).expect("заявка")),
        json!({ "destination": "Северный форт", "source": "world-map", "destinationLocationId": "форт:Северные врата" }),
    );
    assert_eq!(
        to_value(detect("[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=%E0%A4%A] Отряд предлагает отправиться из «Брод» в «Северный форт».").expect("заявка")),
        json!({ "destination": "Северный форт", "source": "world-map" }),
        "сломанный machine token не ломает маршрут по имени",
    );
    let too_long = "%D1%8F".repeat(121);
    let request = detect(&format!("[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id={too_long}] Идём из «Брод» в «Форт».")).expect("заявка");
    assert_eq!(request.destination_location_id, None);
}

#[test]
fn party_decisions_and_abandoned_quests() {
    assert_eq!(
        to_value(classify_party_decision("Уходим в «Каменный Град» и бросаем задание «Найти печать архивариуса»")),
        json!({ "kind": "move", "destinationHint": "Каменный Град", "abandonsQuest": true }),
    );
    assert!(!classify_party_decision("Уходим из деревни").abandons_quest);
    assert!(classify_party_decision("Забить на квест и свалить отсюда").abandons_quest);
    assert_eq!(classify_party_decision("Остаться и исследовать дальше").kind, "stay");
    assert_eq!(classify_party_decision("Остаться и не уходить из деревни").kind, "stay");
    let legacy = "Уходим из «Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов» и идём в «Другой п";
    assert_eq!(to_value(classify_party_decision(legacy)), json!({ "kind": "move", "destinationHint": "", "abandonsQuest": false }));

    let caravanserai = json!({ "worldMemory": { "quests": [
        { "id": "quest:chapter:1", "title": "Осмотреть караван-сарай", "status": "active" },
        { "id": "quest:main", "title": "Найти печать архивариуса", "status": "active" },
    ] } });
    assert_eq!(
        abandonable_quest(&caravanserai),
        Some(AbandonableQuest { id: "quest:main".into(), title: "Найти печать архивариуса".into() })
    );
    assert_eq!(abandonable_quest(&json!({ "worldMemory": { "quests": [{ "id": "quest:main", "title": "Закрыт", "status": "completed" }] } })), None);
    assert_eq!(abandonable_quest(&json!({})), None);
    let hidden = json!({ "worldMemory": { "quests": [
        { "id": "quest:secret", "title": "Тайный сговор гильдии", "status": "active", "visibility": "gm_only" },
        { "id": "quest:known", "title": "Найти пропавший обоз", "status": "active", "visibility": "party" },
    ] } });
    assert_eq!(abandonable_quest(&hidden).map(|quest| quest.id), Some("quest:known".into()));
}

#[test]
fn route_descriptions_stay_out_of_names() {
    let text = "Отправляюсь к смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов, чтобы проверить карту.";
    assert_eq!(to_value(detect(text).expect("уход")), json!({ "destination": "смотровой дамбе", "source": "text" }));
    for (phrase, expected) in [
        ("Идём в деревню вдоль реки", "деревню"),
        ("Уходим в лес через болото, пока не стемнело", "лес"),
        ("Направляемся в порт мимо старых складов", "порт"),
        ("Идём в таверну по старой дороге", "таверну"),
        ("Идём через лес в деревню", "деревню"),
        ("Иду по свежим следам в деревню", "деревню"),
        ("Идём в таверну по соседству", "таверну по соседству"),
        ("Отправляемся в Заречье через лес", "Заречье"),
        ("Идём к старой мельнице вдоль реки", "старой мельнице"),
        ("Идём в деревню Кленовку по тракту", "деревню Кленовку"),
        ("Идём к старому склепу за мельницей", "старому склепу за мельницей"),
        ("Иду в таверну «Морской Змей» расспрашивать о сыне Финна", "таверну «Морской Змей»"),
        ("Отправляюсь в таверну \"Морской Змей\"", "таверну \"Морской Змей\""),
        ("Пойду на рынок купить рыбы", "рынок"),
        ("Уходим из «Серый Причал» и идём к старому маяку на скале", "старому маяку на скале"),
        ("Выходим из деревни и идём на север к руинам", "руинам"),
    ] {
        assert_eq!(destination(phrase).as_deref(), Some(expected), "{phrase}");
    }
    for phrase in ["Иду по коридору к двери", "Иду через зал к стойке", "Отступаем от двери к окну", "Иду к двери через таверну"] {
        assert_eq!(detect(phrase), None, "{phrase}");
    }
    assert_eq!(to_value(detect("Отправляемся в \"Морской Змей\"").expect("уход")), json!({ "destination": "Морской Змей", "source": "text" }));
}

#[test]
fn known_places_and_present_people() {
    let state = json!({
        "scene": { "location": "Таверна «Ржавый Якорь»" },
        "scene_npcs": [
            { "name": "Старый Финн", "location": "Таверна «Ржавый Якорь»" },
            { "name": "Марта", "location": "Таверна «Ржавый Якорь»" },
        ],
        "worldMap": { "locations": [
            { "id": "солеварня", "name": "Солеварня", "known": true },
            { "id": "северный-форт", "name": "Северный форт", "known": true },
            { "id": "ведьмина-падь", "name": "Ведьмина Падь", "known": false },
        ] },
    });
    let context = exit_context_from_state(&state);
    assert!(!context.known_places.contains(&"Ведьмина Падь".to_string()));
    for phrase in [
        "Иду в дальний угол таверны",
        "Иду к трактирщице",
        "Иду к хозяйке таверны",
        "Иду к старой лестнице в подвал",
        "Иду к лесничему у камина",
        "Возвращаюсь на своё место у стола",
        "Иду в другой конец таверны",
        "Иду к Марте",
        "Уходим в тень",
    ] {
        assert_eq!(detect_party_exit_request(phrase, &context), None, "{phrase}");
    }
    assert!(detect_party_exit_request("Идём в старую крепость", &context).is_some());
    assert_eq!(detect_party_exit_request("Иду в Солеварню", &context).map(|r| r.destination).as_deref(), Some("Солеварню"));
    assert!(detect_party_exit_request("Выдвигаемся к Северному форту", &context).is_some());
    assert_eq!(detect("Иду в Солеварню"), None);
    assert_eq!(detect_party_exit_request("Иду в Ведьмину Падь", &context), None);
    assert!(travel_destination_is_place("таверна «Морской Змей»", &context));

    let known = options(&["Серый Причал", "Маяк Серого Причала"], &[]);
    let lighthouse = "Мы с Борином идём к «Маяк Серого Причала» на скале.";
    let found = detect_party_exit_request(lighthouse, &known).expect("уход");
    assert_eq!(party_destination_label(lighthouse, &found.destination, &known).place, "Маяк Серого Причала");
    let town = "Идём в Серый Причал";
    let found = detect_party_exit_request(town, &known).expect("уход");
    assert_eq!(party_destination_label(town, &found.destination, &known).place, "Серый Причал");
}

#[test]
fn speech_calls_lead_the_party() {
    let lighthouse = options(&["Старый Маяк", "Серый Причал"], &[]);
    assert_eq!(
        to_value(detect_party_exit_request("Мирель обращается к Борину: «Ивар молчит — пора искать ответы у Старого Маяка; пойдём туда вместе».", &lighthouse)),
        json!({ "destination": "Старый Маяк", "source": "speech" }),
    );
    assert_eq!(detect_party_exit_request("Мирель говорит Борину: «Я не уйду отсюда, пока не узнаю правду».", &lighthouse), None);
    assert_eq!(detect_party_exit_request("Мирель шепчет: «Пойдём туда, где тише».", &lighthouse), None);
    assert_eq!(detect_party_exit_request("Мирель говорит Борину: «Не пойдём туда — Старый Маяк подождёт».", &lighthouse), None);

    let tarren = options(&[], &["Таррен Кель"]);
    let said = "Мирель сухо замечает Борину: «Раз уж Таррен советует искать знаки, пора к маяку на скале — возможно, там найдётся зацепка об Иле; пойдём туда вместе».";
    assert_eq!(detect_party_exit_request(said, &tarren).map(|r| r.destination).as_deref(), Some("маяку на скале"));
    assert_eq!(detect_party_exit_request("Мирель говорит Борину: «Пора к Таррену, пойдём туда вместе».", &tarren), None);

    let said = "Мирель заносит в тетрадь слова о верёвке: «Пора искать следы у Маяка Чёрной скалы; мы с Бориным идём туда».";
    let found = detect_party_exit_request(said, &options(&["Серый Причал"], &["Эйра"]));
    assert_eq!(found.map(|r| r.destination).as_deref(), Some("Маяк Чёрной скалы"));
    assert_eq!(detect_party_exit_request("Мирель шепчет: «Подожди у Эйры, я схожу туда одна».", &options(&[], &["Эйра"])), None);

    let said = "Мирель закрывает тетрадь: «Гадать бесполезно; у Скального маяка, возможно, удастся найти следы». Она обращается к Борину: «Пойдём туда вместе».";
    assert_eq!(detect_party_exit_request(said, &options(&[], &["Товен Риск"])).map(|r| r.destination).as_deref(), Some("Скальный маяк"));

    let said = "Мирель закрывает тетрадь: «Раз его лодка может прояснить, что творится в порту, пора к маяку на скале. Борин, идём».";
    assert_eq!(detect_party_exit_request(said, &options(&[], &["Оскар Лемм"])).map(|r| r.destination).as_deref(), Some("маяку на скале"));
    assert_eq!(detect_party_exit_request("Мирель шепчет Борину: «Идём, к Инге подойдём позже».", &options(&[], &["Инга"])), None);
}

#[test]
fn nominative_labels() {
    assert_eq!(nominative_place_phrase("старому фамильному склепу за мельницей"), "старый фамильный склеп за мельницей");
    assert_eq!(nominative_place_phrase("водяной мельнице у реки"), "водяная мельница у реки");
    assert_eq!(nominative_place_phrase("заброшенную пещеру"), "заброшенная пещера");
    assert_eq!(nominative_place_phrase("старому замку"), "старому замку");
    assert_eq!(nominative_place_phrase("старой часовне"), "старой часовне");
    assert_eq!(nominative_place_phrase("маяку на скале"), "маяк на скале");
    assert_eq!(nominative_place_phrase("Таверне"), "Таверна");
    assert_eq!(nominative_place_phrase("пещеру у реки"), "пещера у реки");
    assert_eq!(nominative_place_phrase("Мыс Сломанного Зуба"), "Мыс Сломанного Зуба");
    assert_eq!(nominative_place_phrase("Кленовку"), "Кленовку");
    assert_eq!(nominative_place_phrase("маяк"), "маяк");

    let known = options(&["Кленовка", "Вельдбург"], &[]);
    assert_eq!(
        party_destination_label("Продолжаем путь в Кленовку.", "Кленовку", &known),
        DestinationLabel { phrase: "в «Кленовка»".into(), place: "Кленовка".into() }
    );
    assert_eq!(
        party_destination_label("Идём к старому фамильному склепу за мельницей, следы ведут туда.", "старому фамильному склепу за мельницей", &known).phrase,
        "к старому фамильному склепу за мельницей"
    );
    let vote = "Уходим из «Серый Причал» и идём к старому маяку на скале";
    let found = detect(vote).expect("уход");
    assert_eq!(party_destination_label(vote, &found.destination, &ExitOptions::default()).place, "Старый маяк на скале");
}

#[test]
fn objectives_and_onward_routes() {
    let objective = "Найти в Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов другой путь к разгадке: колокол звонит снизу";
    assert!(!objective_names_destination("Другой путь к разгадке", objective));
    assert!(!objective_names_destination("«Другой п", objective));
    assert!(!objective_names_destination("новый выход", "Найти новый выход из подземелья"));
    assert_eq!(objective_remainder(objective, "Другой п"), None);
    assert!(objective_names_destination("смотровая дамба", "Добраться до смотровой дамбы и понять источник звона"));
    assert!(objective_names_destination("Каменный Град", "Вернуться в Каменный Град"));
    assert_eq!(objective_remainder("Добраться до смотровой дамбы, понять источник звона", "Смотровая дамба").as_deref(), Some("Понять источник звона"));

    let full = "Добраться до смотровой дамбы, понять источник звона и не дать толпе открыть шлюзы.";
    assert_eq!(objective_remainder(full, "Смотровая дамба").as_deref(), Some("Понять источник звона и не дать толпе открыть шлюзы"));
    assert_eq!(objective_remainder("Добраться до смотровой дамбы", "Смотровая дамба").as_deref(), Some(""));
    assert_eq!(objective_remainder("Понять источник звона", "Смотровая дамба"), None);
    assert_eq!(
        objective_remainder("Найти в смотровой дамбе того, кто звонит", "Смотровая дамба").as_deref(),
        Some("Найти в смотровой дамбе того, кто звонит")
    );
    assert_eq!(
        objective_remainder("Проверить амбары, найти источник хора и решить, кому позволить открыть южные ворота.", "Южные ворота").as_deref(),
        Some("Проверить амбары, найти источник хора и решить, кому позволить открыть южные ворота")
    );
    assert!(objective_calls_to("смотровой дамбе", full));
    assert!(!objective_calls_to("шлюзам", full));

    let onward = onward_route_objective("Айрская башня", "Дормар");
    assert_eq!(onward, "Продолжить путь из Айрская башня к «Дормар»");
    assert_eq!(onward_route_target(&onward), "Дормар");
    assert_eq!(onward_route_target("Найти пропавшего курьера"), "");
    assert_eq!(onward_route_target("Продолжить путь к Дормару и найти курьера"), "");
    assert_eq!(pending_onward_target(Some(&json!({ "location": "Айрская башня", "objective": onward }))), "Дормар");
    assert_eq!(pending_onward_target(Some(&json!({ "location": "Дормар", "objective": onward }))), "");
    assert_eq!(pending_onward_target(None), "");

    for text in ["продолжим", "Продолжаем!", "продолжаем путь", "Продолжим маршрут.", "идём дальше", "Идем дальше", "Ну, в путь!", "давайте двигаемся дальше", "дальше в путь"] {
        assert!(is_route_continuation(text), "{text}");
    }
    for text in ["продолжим приключение", "продолжим разговор с Мирой", "идём в таверну", "продолжим?", "дальше", ""] {
        assert!(!is_route_continuation(text), "{text}");
    }
}

#[test]
fn unrecognized_destinations_are_named() {
    assert_eq!(
        unrecognized_destination("Иду по свежим следам к провалу у старой арки, чтобы найти телегу или следы груза.", &ExitOptions::default()),
        "провалу у старой арки"
    );
    assert_eq!(unrecognized_destination("Отправляюсь к старой арке по свежим следам телеги, чтобы осмотреть провал.", &ExitOptions::default()), "старой арке");
}
