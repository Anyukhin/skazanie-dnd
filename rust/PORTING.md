# Перенос JS → Rust: правила для исполнителей

План и причины — `docs/rust-rewrite-plan.md`. Здесь — как переносить модуль
`server/*.mjs` так, чтобы перенесённое вело себя **так же**, как JS, и
собиралось вместе с остальными крейтами.

## 1. Принцип этапа паритета

- Переносится **поведение**, строка в строку по смыслу: те же ветки, те же
  приведения, те же тексты (русские строки копируются байт в байт), те же
  коды ошибок. Улучшать правила, тексты и алгоритмы при переносе нельзя —
  отличие от JS считается ошибкой переноса. Найденный в JS баг переносится
  как есть и записывается в отчёт (раздел «Замечено в JS»).
- Данные между модулями — `serde_json::Value` той же формы, что в JS
  (состояние кампании, герои, предметы, события, полезная нагрузка). Внутри
  алгоритма можно и нужно заводить свои структуры и перечисления, если так
  яснее; на границе модуля форма JSON совпадает с JS.
- Экспорт JS `fooBar` → `pub fn foo_bar`; константа `FOO_BAR` → `pub const`
  или `pub static FOO_BAR: LazyLock<…>`. Неэкспортируемое — приватное
  (`pub(crate)`, если нужно соседу по крейту).
- `undefined` против `null`: поле, которое JS кладёт как `undefined`, в JSON не
  попадает — в Rust его просто не вставлять. Возврат `undefined`/`null` —
  `Option`.
- Комментарии и документация — по-русски (AGENTS.md §7), идентификаторы —
  по-английски. Каждый перенесённый модуль начинается с `//!`-шапки: какой
  JS-файл он переносит и за что отвечает.

## 2. Где лежит код

- Крейт `rust/crates/sk-<имя>/`, модуль на каждый JS-файл:
  `server/merchant-economy.mjs` → `src/merchant_economy.rs`,
  `server/rules/core.mjs` → `src/rules_core.rs`. `lib.rs` объявляет модули.
- `Cargo.toml` крейта:

  ```toml
  [package]
  name = "sk-<имя>"
  description = "…по-русски…"
  edition.workspace = true
  version.workspace = true
  publish.workspace = true

  [dependencies]
  serde.workspace = true
  serde_json.workspace = true
  sk-core.workspace = true
  # крейты нижних волн — по пути: sk-ruleset = { path = "../sk-ruleset" }
  ```

- Внешние зависимости берутся из `[workspace.dependencies]` корневого
  `rust/Cargo.toml` (`x.workspace = true`). Корневой `Cargo.toml` не править;
  если нужна новая внешняя зависимость — добавить её в `Cargo.toml` своего
  крейта с точной версией и назвать в отчёте.
- Данные `data/*.json` встраиваются: `include_str!("../../../../data/x.json")`
  (из `rust/crates/sk-x/src/`), разбор один раз в `LazyLock<Value>`.

## 3. Приведения JS — только через `sk_core`

| JS | Rust |
| --- | --- |
| `Number(x)` | `sk_core::js::number(x) -> f64` (`None` = `undefined` → NaN, `null` → 0) |
| `safeInteger(x, f)` (`Number.isSafeInteger(Number(x)) ? … : f`) | `js::safe_int(x, f)` |
| `Number.isFinite(Number(x))` | `js::is_finite_number(x)` |
| `String(x ?? '')` | `js::s(x)`; число f64 → `js::f64_string` |
| `Boolean(x)` / `x === true` / `x === false` | `js::truthy`, `js::is_true`, `js::is_false` |
| `x != null` | `js::present(x)` |
| `x && typeof x === 'object' && !Array.isArray(x)` | `js::is_plain(x)` |
| `{ ...a, ...b }`, `Object.assign` | `js::spread`, `js::assign` |
| `Object.entries/keys` (индексы раньше прочих ключей!) | `js::entries`, `js::keys` |
| `Math.round` (половина — к +∞) | `js::round` |
| `x.toFixed(n)` | `js::to_fixed` |
| `x \| 0`, `x >>> 0`, `Math.imul` | `js::to_int32`, `js::to_uint32`, `js::imul` |
| `Math.max(...[])`, `Math.min(...[])` | `js::max_of`, `js::min_of` |
| `parseInt(x, 10)`, `parseFloat(x)` | `js::parse_int`, `js::parse_float` |
| `array.sort()` без сравнителя (по строкам!) | `js::default_sort` |
| число в JSON (`2`, а не `2.0`) | `js::num(f64)` или `Value::from(i64)` |
| `toLocaleString('ru-RU')` для целого | `js::ru_integer` |
| `normalize('NFKC')`, `trim()`, `slice(a, b)` | `sk_core::text::nfkc`, `text::trim`, `text::slice` |
| `String(x ?? '').normalize('NFKC').trim().slice(0, n)` | `text::clean(x, n)` (`clean_lower` — с `toLocaleLowerCase`) |
| `toLocaleLowerCase('ru-RU')` / `toLowerCase()` | `text::lower` |
| `a.localeCompare(b)` | `text::locale_compare` (ICU, как Node) |
| регулярное выражение `/…/iu` | `sk_core::re!(r"…", "iu")` — синтаксис JS, см. ниже |
| `new RegExp(src, flags)` | `text::js_regex(src, flags)` |
| `re.test(t)`, `t.replace(re, r)` | `text::test`, `text::replace_all` / `replace_first` (`$&` → `${0}`) |
| `createHash('sha256')…digest('hex')` | `sk_core::hash::sha256_hex` |
| `randomUUID()` | `hash::uuid_v4` |
| `Date.now()`, `toISOString()`, `Date.parse()` | `sk_core::clock::now_ms`, `clock::iso`, `clock::parse_iso` |
| `new Map()` / `new Set()` (порядок вставки) | `indexmap::IndexMap` / `IndexSet` (`sk_core::indexmap`) |
| `structuredClone(x)` | `x.clone()` |
| `JSON.stringify(x)` / `JSON.stringify(x, null, 2)` | `js::stringify` / `js::stringify_pretty` (числа и порядок ключей как в JS; хеши по тексту JSON — только ими, `serde_json::to_string` печатает `100.0` и `1e21`) |

Регулярные выражения: `re!` переводит синтаксис JS — `\b`, `\w`, `\d` в JS
только ASCII даже с флагом `u`, и макрос это сохраняет; `\p{L}`, lookbehind,
именованные группы работают. Паттерн копировать из JS без правок.

Уроки первой волны (нарушение каждого уже ломало паритет):

- **`String(x)` и `String(x ?? '')` — разные функции.** `js::s` — второе
  (`undefined`/`null` → `""`); для `String(x)` в сравнениях
  `String(a) === String(b)` — `js::string` (`"undefined"`, `"null"`).
- **Удаление ключа — только `shift_remove`.** `Map::remove` при
  `preserve_order` — это `swap_remove`: последний ключ встаёт на место
  удалённого, и порядок JSON расходится с JS (а хеш карты считается по
  `JSON.stringify`, то есть зависит от порядка).
- **Ключи прототипа.** `obj[key]` в JS находит `constructor`, `toString`,
  `__proto__` у любого объекта. Где исход на таких ключах виден снаружи —
  повторить (и закрепить тестом), иначе считать ключ неизвестным и записать в
  «Замечено в JS».
- **`localeCompare()` без локали зависит от машины**: Node на Windows
  владельца — ru-RU, боевой Docker — en-US. Rust повторяет боевой сервер.
  Каждый генератор эталонов **первой строкой** импортирует
  `rust/fixtures-env.mjs` (`import '../../../fixtures-env.mjs'`), который
  ставит локалью по умолчанию en-US.
- `Math.asin`, `Math.hypot`, `Math.cos` и пр. в V8 могут отличаться от
  системных в последних битах; если результат влияет на клетку или порядок —
  переносить алгоритм V8/fdlibm (готовые есть в `sk-geometry`).

Помощники состояния — `sk_core::game` (`find_actor`, `list_actors`,
`conditions`, `combat`, `mechanics`, …). Если нужного помощника нет — завести
приватный в своём модуле, а не править `sk-core`.

Числа: где JS считает в дробях (`/`, `Math.sqrt`, проценты), считать в `f64` и
приводить как JS (`Math.floor` → `f64::floor`). Целочисленное деление Rust
(`7 / 2 == 3`) — частая ошибка переноса.

Порядок: `Array.prototype.sort` устойчив, как `sort_by` в Rust. Сравнитель
`(a, b) => a - b` → `partial_cmp`/`cmp` по числам; сравнитель с
`localeCompare` → `text::locale_compare`.

## 4. Случайность, время, ввод-вывод

- Случайность правил — только через `sk_dice::Dice` (внедряется). Детерми-
  нированные сиды генераторов (хеш строки, mulberry32 и т. п.) переносятся
  точно, с `wrapping_*` и `js::to_uint32`, чтобы давать **те же** карты.
- Чтение файлов `data/` — `include_str!`. Запись на диск и сеть в модулях
  нижних волн не появляется; если JS-модуль пишет файлы (store, map-store,
  usage-ledger), переносится его логика над `std::fs`, а не форма вызова.
- Модель (LLM) в модулях нижних волн не вызывается; если JS принимает
  клиента модели параметром — в Rust это трейт-параметр, описанный в модуле.

## 5. Ошибки

- Отказ правила (`throw new RuleError(code, …)`, `ruleError(…)`) →
  `sk_core::RuleError { code, message }`, `Result<T, RuleError>`; тексты и
  коды — как в JS.
- Иные `throw new Error('…')` → `Result<T, String>` или свой `thiserror`-тип,
  если вызывающие различают причины.
- `panic!`/`unwrap()` на данных игрока или кампании запрещены: старые
  кампании содержат любой мусор, JS его переживал.

## 6. Проверка

Окружение (Git Bash):

```bash
export PATH="$USERPROFILE/.cargo/bin:$HOME/.cargo/mingw64-root/mingw64/bin:$PATH"
cd <worktree>/rust
cargo build -p sk-<имя>
cargo test -p sk-<имя>
```

Node для эталонов: `"$LOCALAPPDATA/OpenAI/Codex/bin/5b9024f90663758b/node.exe"`
(в `PATH` его нет). Серверные модули JS не требуют `node_modules`.

- **Тесты переносятся.** Для каждого JS-модуля открыть его тесты
  (`test/<модуль>*.test.mjs`) и перенести проверки, касающиеся самого модуля
  (не HTTP и не UI-контракты): в `#[cfg(test)] mod tests` модуля или
  `crates/sk-<имя>/tests/<модуль>.rs`.
- **Эталоны из JS.** Где выход сложный (генераторы, таблицы, тексты), снять
  эталон прогоном JS: скрипт `rust/crates/sk-<имя>/fixtures/gen-<модуль>.mjs`
  импортирует `../../../../server/<модуль>.mjs`, пишет
  `fixtures/<модуль>.json` (входы и ожидаемые выходы); Rust-тест читает его
  через `include_str!` и сравнивает. Скрипт и JSON коммитятся — так эталон
  можно пересоздать. Сотни случаев лучше трёх.
- **Бюджет эталонов — до ~10 МБ на крейт.** Крупный выход (карты, каталоги,
  длинные цепочки) храни как sha256 строки `js::stringify` по случаю, а целиком —
  только первые расхождения для отладки: эталоны лежат в git, и 26 МБ одного
  крейта уже заметны.
- Сборка без предупреждений (`cargo build` чистый, `#[allow]` — только с
  комментарием, зачем).

## 7. Git и отчёт

- Работать только в выданном worktree и ветке; трогать только свой крейт
  (`rust/crates/sk-<имя>/`). Чужие крейты, `server/`, `src/`, `test/`,
  `docs/`, `storage/` — не менять.
- Коммитить своё по мере готовности (`git add rust/crates/sk-<имя>` и
  `rust/Cargo.lock`, если он изменился), сообщение — по-русски, с
  `[skip ci]` в заголовке и строкой
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` в конце. Не пушить.
- Итоговый отчёт: какие модули и функции перенесены; сколько тестов и
  эталонных случаев; отклонения от JS и почему; «Замечено в JS» — баги и
  странности исходника; что не перенесено и почему (заглушек без объяснения
  быть не должно).
