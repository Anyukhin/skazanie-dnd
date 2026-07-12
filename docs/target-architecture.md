# Целевая архитектура

## Цели

Целевая система должна сохранять текущий UI и API на время миграции, но перенести механическую власть с LLM и browser state на проверяемые серверные команды, события и reducer.

Ключевые инварианты:

1. LLM интерпретирует и повествует, но не пишет HP, ресурсы, инвентарь или порядок боя.
2. Каждый механический результат имеет `rule_id`, `house_rule_id` или `ruling_id`.
3. Все случайные значения выдаёт Dice Service и связывает с `roll_id`.
4. Каждая кампания закреплена за конкретным ruleset и набором packs.
5. Состояние меняется только применением сохранённых событий.
6. Команда с повторным `idempotency_key` не создаёт события повторно.
7. Narrator получает только разрешённую visible projection.
8. Новый путь можно включать постепенно и откатывать без потери legacy room.

Часть этой схемы уже подключена: runtime собирает Rule Pack/Retriever, Dice Service/Roll Registry, Rules Engine, FileEventStore, Game Orchestrator, Narrator/Verifier и trace store, а режимы переключаются по кампании. Этот документ описывает **конечные инварианты**, а не заявляет, что они уже полностью достигнуты. Сейчас остаются legacy full-room compatibility writes, частичная event→room projection, in-memory roll registry, неполное P0-покрытие и ограниченные integration tests.

## Целевой игровой цикл

```mermaid
flowchart TD
    Request["Существующий API/UI request"] --> Auth["Auth + campaign membership"]
    Auth --> Load["Campaign + ruleset lock + state version"]
    Load --> Intent["Intent Parser"]
    Intent --> Clarify{"Нужно уточнение?"}
    Clarify -->|да| Response["Compatibility response"]
    Clarify -->|нет| Queries["Rule queries"]
    Queries --> Retriever["Rule Retriever: exact ruleset filter"]
    Retriever --> Judge["Adjudicator"]
    Judge --> Validate["Command schema + ACL + provenance + version"]
    Validate --> Engine["Rules Engine"]
    Engine --> Dice["Dice Service / Roll Registry"]
    Engine --> Events["Game Events"]
    Events --> Append["Atomic Event Repository append"]
    Append --> Reducer["Reducer"]
    Reducer --> Snapshot["Snapshot policy"]
    Reducer --> Projection["Visibility projection"]
    Projection --> Narrator["Narrator"]
    Narrator --> Verify["Verifier"]
    Verify --> Trace["Decision trace + /why"]
    Trace --> Response
```

## Ответственность компонентов

### API compatibility adapter

- Принимает текущие request shapes.
- Преобразует их в versioned command request.
- Возвращает текущему frontend знакомые narration/effects/state fields.
- Не выполняет механику и не пишет state самостоятельно.

### Game Orchestrator

- Загружает campaign metadata и snapshot.
- Разрешает engine mode.
- Передаёт только visible state в Intent Parser/LLM.
- Запускает retrieval строго для `campaign.ruleset_id` и `enabled_rule_packs`.
- Обеспечивает один idempotency scope на пользовательский ход.
- Append-ит события с expected stream/state version.
- Создаёт decision trace.

Orchestrator не должен содержать формулы конкретных правил: они принадлежат Rules Engine и Rule Pack.

### Intent Parser

Возвращает структуру намерения, список целей, недостающие данные и уверенность. Он не генерирует commands и не изменяет state. Rule-based parser может быть быстрым первым уровнем, LLM — ограниченным fallback после redaction hidden state.

### Rule Pack и Rule Repository

- Immutable/versioned corpus.
- Стабильные IDs, manifest, license/provenance, bilingual text и aliases.
- Referential-integrity check между rules, ontology, engine command mappings и house rules.
- Numeric translation integrity как обязательный ingestion gate.
- Активная кампания не меняет ruleset автоматически при обновлении файлов.

### Rule Retriever

Обязательный порядок:

```text
normalize query
→ aliases/glossary
→ exact ruleset_id + enabled packs filter
→ lexical/local-vector search
→ merge
→ bounded ontology expansion
→ deterministic rerank
```

Нельзя сначала искать по всем редакциям, а затем удалять чужие результаты: фильтр должен применяться до scoring и expansion.

### Adjudicator

- Выбирает применимые rules и предлагает typed commands.
- При низкой уверенности возвращает clarification или explicit ruling draft.
- Не выполняет roll и не применяет events.
- Не создаёт «каноническое правило» из ответа модели.

### Rules Engine

- Валидирует command allowlist, actor permissions, target visibility, provenance, ruleset и expected state version.
- Просит Dice Service о roll только после validation.
- Возвращает events; сам не пишет repository.
- Reducer применяет только известные versioned event types.
- Повторный replay одинакового event stream даёт одинаковое state.

### Dice Service и Roll Registry

- Парсит ограниченную грамматику dice expressions.
- Использует криптографический RNG в production и deterministic injected RNG в тестах.
- Привязывает roll к campaign, actor, purpose, visibility и expiry.
- Consume выполняется один раз; повтор с тем же idempotency key возвращает тот же результат, с другим — ошибку.
- Registry должен стать durable либо быть частью одной атомарной turn transaction. In-memory registry недостаточен для нескольких процессов и рестарта.

### Event Repository и snapshots

Минимальная event envelope:

```json
{
  "event_id": "...",
  "event_type": "DamageApplied",
  "schema_version": 1,
  "campaign_id": "...",
  "turn_id": "...",
  "command_id": "...",
  "actor_id": "...",
  "target_ids": ["..."],
  "source_rule_ids": ["..."],
  "house_rule_id": null,
  "ruling_id": null,
  "state_version_before": 12,
  "state_version_after": 13,
  "visibility": "party",
  "payload": {},
  "created_at": "..."
}
```

Append должен быть атомарным относительно stream version и idempotency key. Snapshot — производная оптимизация; event log остаётся источником аудита. Legacy JSON сохраняется отдельно до завершения миграции.

Текущий `FileEventStore` уже реализует этот контракт для одного файлового deployment и подключён к runtime: immutable commit files, lock, idempotency, optimistic version, checksummed snapshots и replay. В целевой архитектуре он остаётся concrete adapter, а не частью Rules Engine. До production-grade cutover нужны failure/concurrency tests и единая transaction boundary либо восстанавливаемый protocol для event commit, roll consume, legacy projection и trace.

### Narrator

Получает:

- visible projection до и после хода;
- подтверждённые events и rolls;
- retrieved rule excerpts, разрешённые к раскрытию;
- narration constraints.

Narrator не получает repository handle и не может добавить event. Его ответ — только текст, suggestions и ссылки на уже подтверждённые trace IDs.

### Verifier

Проверяет, что narration:

- не меняет механику сверх events;
- не раскрывает `gm_only`/`npc_private` данные;
- не называет неподтверждённые roll/HP/resource values;
- не ссылается на чужой ruleset;
- имеет допустимый размер и JSON shape.

При провале используется безопасный deterministic summary событий, а не непроверенный текст.

## Ruleset lock кампании

В campaign metadata обязательны:

```text
ruleset_id
ruleset_version
enabled_rule_packs
enabled_house_rules
ruleset_locked_at
```

Rules Engine, Retriever и event append должны получить один и тот же lock. Command с другим ruleset отклоняется до roll. Обновление pack создаёт новый version/pack ID; оно не меняет активные кампании автоматически.

## Режимы миграции

### `legacy`

- Работает существующий путь.
- Новый pipeline может быть полностью выключен.
- Legacy room остаётся авторитетным.

### `shadow`

- Legacy response остаётся авторитетным.
- Новый pipeline получает тот же нормализованный input и копию state.
- Shadow не append-ит production events и не расходует второй независимый случайный roll. Для сравнения используются записанные legacy roll values либо отдельный deterministic shadow seed.
- Расхождения записываются в обезличенный comparison report.

Текущая реализация сохраняет legacy outcome авторитетным и формирует comparison trace, но может независимо получить случайность в legacy и новом engine. Это известное отклонение от целевого single-roll invariant; его необходимо устранить до использования divergence как статистически корректного сигнала.

### `enforce`

- Только новый pipeline создаёт авторитетные events/state.
- Legacy adapter формирует совместимый ответ для UI.
- При внутренней ошибке выполняется явный fail-closed/rollback path; нельзя незаметно применить legacy мутацию поверх частично append-нутых событий.

Resolver должен поддерживать precedence `test > user > campaign > global > default`, но любое включение `enforce` требует durable persistence, migrations и integration tests.

Resolver и admin per-campaign switch уже работают. Наличие одного временного HTTP integration-сценария достаточно для smoke-проверки, но не заменяет migration rehearsal, browser/RouterAI/restart tests и эксплуатационный gate для реальной кампании.

## Visibility

Projection строится на сервере до обращения к LLM или клиенту:

- `public` — всем;
- `party` — участникам кампании;
- `specific_player` — allowlist players;
- `gm_only` — владельцу/ведущему;
- `npc_private` — только серверной логике.

Скрытые map cells, NPC plans, secret DC и private rolls не должны попадать в prompt, trace для игрока или error body.

## `/why` и trace

Каждый ход сохраняет:

- engine mode и versions;
- intent и retrieval queries;
- retrieved rule IDs и scores;
- ruling/house rule;
- validated commands;
- rolls;
- events;
- state versions;
- verifier result;
- divergence report в shadow.

`/why` должен читать эту запись через visibility filter. Он объясняет уже принятое решение и никогда не запускает ход повторно. Сейчас endpoint проверяет доступ пользователя к кампании, но не выполняет полную event-level projection содержимого explanation; это незакрытая часть целевого контракта.

## Persistence evolution

1. **Выполнено:** подключить FileEventStore adapter за orchestrator без изменения формы основного UI/API.
2. **Частично:** создавать `LegacyStateImported` для новых и лениво открываемых кампаний; metadata runner остаётся отдельным и не reconciles `legacy_import_required`.
3. **Частично:** хранить event state отдельно и проецировать совместимые поля в legacy room; commit и projection пока не атомарны.
4. **Частично:** unit-тестировать replay/snapshot и сравнение shadow; добавить restart/concurrency и реальные migration datasets.
5. **Доступно только как canary-механизм:** переключать отдельную тестовую кампанию на enforce после backup/rehearsal.
6. Перенести event/snapshot storage в транзакционную БД или эквивалентный durable protocol при необходимости нескольких процессов.
7. Удалять legacy path только после миграции всех кампаний и проверенного rollback window.
