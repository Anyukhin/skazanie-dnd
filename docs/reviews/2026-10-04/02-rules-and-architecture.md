# Ревью Rules Engine, событийных контрактов и расширяемости

Аудит выполнен на baseline `c7efdca614cc33f706258d036e86f01c1f189404`.
Просмотрены `server/rules-engine.mjs`, `server/rules/core.mjs`,
`server/rules/actors.mjs`, `server/rules/tactical-geometry.mjs`,
`server/event-store.mjs`, `server/contracts.mjs`, `server/rule-pack.mjs`,
`server/rule-retriever.mjs`, `server/ruleset-config.mjs`,
`server/campaign-ruleset.mjs`, `server/authoritative-executor.mjs`, а также
релевантные тесты. Runtime-код, `storage/` и данные не менялись; полный
`pnpm verify` не запускался. Точечно зелёные `rules-engine`, `event-store`,
`rule-pack`, `rule-retriever`, `campaign-ruleset` и `ruleset-config`.
Воспроизводимые безопасные probes для ARC-01/02/04/05/06 и проверки mutation/replay
ARC-07 сохранены в [architecture-probes.mjs](./architecture-probes.mjs) и
запускаются командой `node docs/reviews/2026-10-04/architecture-probes.mjs`;
они используют только временные каталоги и сами их удаляют.

Сейчас в проекте уже есть полезное разделение: `core`, запросы к акторам и
тактическая геометрия вынесены в листовые модули, а `world-memory`, NPC,
предметы и несколько политик имеют собственные normalizer/apply-функции.
Тест [server-import-graph.test.mjs:73](../../../test/server-import-graph.test.mjs#L73)
запрещает циклы. Это хорошая основа для следующего шага. Проблема не в том,
что Rules Engine обязан быть микросервисом, а в том, что один файл всё ещё
содержит несколько разных интерфейсов: нормализацию, проверку команд,
разрешение, envelope событий, reducer, replay и текстовые сводки.

Severity: P1 может нарушить авторитет редакции, целостность журнала или
восстановление принятого хода; P2 требует расширения или неблагоприятного
сценария, но уже имеет понятный путь к дрейфу; P3 — локальный долг без
немедленной потери состояния. Effort: S/M/L/XL; confidence — уверенность
аудита.

## Находки

### ARC-01 — P2: commit-first записывает несовместимую редакцию в metadata

`FileEventStore.commit()` умеет сам создать отсутствующую кампанию:
[event-store.mjs:778-803](../../../server/event-store.mjs#L778-L803). При этом
начальный snapshot строится из `initialStateFactory`, но metadata создаётся с
жёсткими `srd_5_2_1`, `5.2.1` и одноимённым pack:
[event-store.mjs:449-470](../../../server/event-store.mjs#L449-L470). Поэтому временный
repro с factory, возвращающей `ruleset_id: dnd_5e_2014`, и первым `commit()` без
`initializeCampaign()` даёт `state.ruleset_id = dnd_5e_2014`, но
`metadata.ruleset_id = srd_5_2_1`. Обычный HTTP-create вызывает
`initializeCampaign`, однако публичный контракт EventStore и системные
производители могут пойти через commit-first.

Это подтверждённое поведение внутреннего EventStore API и integration risk;
обычный HTTP create в просмотренном пути сначала вызывает initialization.
Канонический runtime state при этом берётся из state/replay, поэтому probe не
доказывает поломку игрового ruleset или восстановления. Он оставляет дрейф
metadata, audit и cutover: операционный инструмент, который доверяет metadata,
может показать неверную редакцию. Confidence: 1.0; effort: S. Минимальный
выбор — запретить `commit()` до инициализации с отдельным
кодом ошибки. Если commit-first нужен, metadata следует получать из
нормализованного initial state и валидировать через `rulesetProfile`, а не из
констант. Тест должен создать dnd-кампанию только через commit-first и требовать
совпадения state/metadata либо ожидаемого отказа.

### ARC-02 — P2: неизвестное событие принимается, повышает версию и молча теряется

Нормализация события проверяет форму `event_type`, но не существование
контракта: [event-store.mjs:595-615](../../../server/event-store.mjs#L595-L615). Commit
сразу прогоняет его через reducer и сохраняет:
[event-store.mjs:798-837](../../../server/event-store.mjs#L798-L837). В основном reducer
у неизвестного типа срабатывает пустая ветка `default`:
[rules-engine.mjs:24707-24711](../../../server/rules-engine.mjs#L24707-L24711).

Короткий repro с временным каталогом записал `TypoEvent` с payload `hp: 999`:
commit вернул `state_version: 1`, событие осталось в журнале, но состояние не
изменилось и ошибки не было. Это подтверждённый internal contract behavior; по
этому аудиту не утверждается, что именно такой payload принимается обычным
непривилегированным HTTP writer. Риск появляется при опечатке в новом writer или
расхождении allowlist и reducer. Confidence: 1.0; effort: M.

Нужен один реестр event contract: `event_type` → версия envelope/payload,
проверка и reducer handler. EventStore может проверять только контрактные
поля, а Rules Engine — применение. Старые события, которые намеренно
игнорируются, должны проходить только через legacy replay policy; новые current
события должны отвергаться до записи. Нельзя просто удалить `default`: старый
replay и forward compatibility надо сохранить явно. Проверки: неизвестный
current event получает 4xx/ошибку до commit; старый поток с legacy marker
остаётся воспроизводимым.

### ARC-03 — P2: source_rule_ids остаётся недоверенным metadata на внутренних/admin-путях

`sourceIdsFor()` отвергает только ID с префиксом другой установленной редакции,
но неизвестный `evil:invented-rule` принимает:
[rules-engine.mjs:4200-4210](../../../server/rules-engine.mjs#L4200-L4210). Затем
`normalizeCommand` сохраняет его, а `eventFrom` переносит в событие:
[rules-engine.mjs:4212-4231](../../../server/rules-engine.mjs#L4212-L4231) и
[rules-engine.mjs:7098-7126](../../../server/rules-engine.mjs#L7098-L7126). На
реальном player HTTP path `sanitizePlayerCombatCommand()` строит allowlisted
`base` без source IDs ([index.mjs:1210-1215](../../../server/index.mjs#L1210-L1215)),
поэтому unprivileged client injection здесь не доказан. Но
`/api/campaigns/:id/commands` для admin и часть внутренних callers передают
другие команды дальше без этого санитайзера
([index.mjs:4971-4980](../../../server/index.mjs#L4971-L4980)); внутренний repro
на `MakeAbilityCheck` возвращает forged ID одновременно в `result.command` и
`result.events[0]`.

Механику это прямо не подменяет, но ломает доверие к аудиту: trace, rule search
и проверка «каким правилом решено» могут ссылаться на несуществующий источник.
Это internal trusted-metadata risk, а не доказанная атака обычного игрока.
Confidence: 1.0; effort: S. Для внешней команды source IDs должны быть
server-owned: принимать только ID активного ruleset/allowlisted pack либо
убирать их из JSON-команды и добавлять после маршрутизации. `house_rule_id` и
`ruling_id` остаются отдельными полями. Тест должен проверять неизвестный
префикс и ID другой редакции; внутренние nested commands должны по-прежнему
добавлять canonical IDs сами.

### ARC-04 — P2: неизвестный ruleset продолжает исполняться как legacy на широком internal API

`normalizeCampaignState` превращает любой непустой `ruleset_id` в строку и не
вызывает `rulesetProfile`:
[rules-engine.mjs:1969-1979](../../../server/rules-engine.mjs#L1969-L1979). В
`resolveCommand` неизвестный `made-up` state всё же проходит обычную проверку,
а fallback `RULE_IDS` остаётся `srd_5_2_1` через
[rules-engine.mjs:4200-4215](../../../server/rules-engine.mjs#L4200-L4215). Repro:
`normalizeCampaignState({ruleset_id: 'made-up', players: [...]})` затем
`MakeAbilityCheck` успешно выдаёт событие с
`srd_5_2_1:checks:ability-check`.

HTTP-создание обычно закрывает это через `rulesetLock`; прямой EventStore,
импорт и внутренний вызов движка остаются более широкими входами. Это
подтверждённый internal contract behavior и integration risk, но не доказанный
внешний HTTP defect. Confidence: 0.95; effort: M. Проверку существования профиля и
соответствия pack-ов нужно сделать на границе activation/command, не внутри
legacy replay: старый журнал должен читаться, но кампания с неизвестной
редакцией должна быть явно locked до миграции. Версию по умолчанию следует
брать из profile; сейчас строка `5.2.1` задана прямо в
[rules-engine.mjs:1973-1976](../../../server/rules-engine.mjs#L1973-L1976).

### ARC-05 — P2: rule entity_refs не связаны с glossary

`validateRulePack()` проверяет, что `entity_refs` — массив строк, но не требует,
чтобы значения существовали в glossary:
[rule-pack.mjs:261-293](../../../server/rule-pack.mjs#L261-L293) и
[rule-pack.mjs:325-338](../../../server/rule-pack.mjs#L325-L338). Мутация загруженного
pack с `rules[0].entity_refs = ['missing:term']` проходит валидацию. Retriever
затем просто получает пустой результат `pack.glossary.filter(...)` в
[rule-retriever.mjs:156-168](../../../server/rule-retriever.mjs#L156-L168), поэтому
пакет выглядит валидным, но теряет aliases и обогащение поиска.

Confidence: 1.0; effort: S. Проверка subset glossary IDs и тест на неизвестный
ref сделают ошибку локальной при сборке pack. Это не требует DSL или зависимости.

### ARC-06 — P2: одинаковые rule IDs в разных pack-ах молча shadow-ятся

`RuleRetriever` проверяет уникальность `pack_id`, но при сборке документов не
проверяет уникальность пары `(ruleset_id, rule.id)`:
[rule-retriever.mjs:295-316](../../../server/rule-retriever.mjs#L295-L316). Во время
поиска результаты складываются в `Map` по `document.id`:
[rule-retriever.mjs:363-404](../../../server/rule-retriever.mjs#L363-L404). Repro с
копией `srd_5_2_1` под новым `pack_id` проходит constructor, но все совпавшие
результаты внезапно несут последний pack; порядок загрузки определяет победителя.

Это опасно при добавлении расширения или override: оператор думает, что включил
два пакета, а один silently заменяет другой. Confidence: 1.0; effort: S/M.
Базовое правило — отвергать duplicate IDs при сборке retriever. Если override
когда-нибудь понадобится, он должен быть отдельной manifest-связью
`replaces` с единственным детерминированным приоритетом и проверкой совместимой
версии, а не неявным порядком массива.

### ARC-07 — P2: trusted reducer всё ещё нормализует состояние на каждом событии

`applyGameEventCurrent` начинает каждый event с
`normalizeCampaignState(rawState)`
([rules-engine.mjs:21941-21957](../../../server/rules-engine.mjs#L21941-L21957)).
EventStore уже ввёл `reducerNormalizesInput` и trusted fast path, но этот reducer
сам повторяет нормализацию, а fast path снимает только вторую нормализацию
результата: [event-store.mjs:364-398](../../../server/event-store.mjs#L364-L398).
Исторический комментарий в EventStore сообщает замер: до кэша `_load` занимал
82% CPU и 1–2 секунды на команду для кампании двух героев 11-го уровня:
[event-store.mjs:241-260](../../../server/event-store.mjs#L241-L260).

Повторная нормализация — установленный факт, а величина ускорения после её
устранения — гипотеза, которую надо измерять benchmark-ом; probe печатает
`arc07_100_apply_ms` для повторного сравнения, без обещания speedup. Confidence: 0.9;
effort: M. До замены нужно проверить, какие post-event invariants даёт
нормализация и не мутирует ли её вход. Без изменения событий нужен внутренний
`applyGameEventNormalized(normalizedState, event)` и внешний совместимый
`applyGameEvent(rawState, event)`, который нормализует только на публичной
границе. EventStore передаёт trusted reducer именно во внутренний путь, а
полный replay и legacy остаются через внешний wrapper. Нужен benchmark на
`replayEvents`/`FileEventStore.load` плюс byte/deep equality с полным replay.

### ARC-08 — P2/design hypothesis: монолит имеет слишком широкий интерфейс для дальнейших правил

`rules-engine.mjs` содержит 25 161 строку, импортирует десятки доменных модулей
([rules-engine.mjs:1-509](../../../server/rules-engine.mjs#L1-L509)), экспортирует 61
имя и напрямую импортируется 34 серверными модулями. Проверка команд занимает
примерно [5627-7095](../../../server/rules-engine.mjs#L5627-L7095), resolver —
[11751-21266](../../../server/rules-engine.mjs#L11751-L21266), reducer —
[21941-24754](../../../server/rules-engine.mjs#L21941-L24754). Это не defect само по
себе: поведение тестируемо. Но добавление нового домена требует одновременно
трогать allowlist, normalization, validate, resolve, reducer и summary, что
увеличивает шанс забыть одну точку.

Confidence: 0.95; effort: XL суммарно, но первый шаг S/M. Не предлагаю новый
движок, DSL или публичную систему plugins. Нужны несколько фиксированных
внутренних seams, а не универсальный registry для произвольного кода.

Приоритет практический: сначала закрыть ARC-02 и ARC-04 как internal boundaries
авторитета, затем ARC-01 и ARC-03 для согласованности metadata и аудита. ARC-05
и ARC-06 можно сделать в проверках пакетов независимо от игрового runtime.
ARC-07 может дать выигрыш после characterization, а ARC-08 следует вести
только маленькими обратимыми шагами: каждая фаза должна оставлять прежний
публичный entrypoint и прежний replay.

Это отдельная будущая задача после завершения и сверки миграции executor. Старый
`docs/agent-architecture-plan.md` сознательно исключает рефакторинг движка из
своего шага ([строки 290-292](../../../docs/agent-architecture-plan.md#L290-L292)
и [строка 466](../../../docs/agent-architecture-plan.md#L466)); ниже не
предлагается расширять тот план или выполнять extraction «заодно». Его можно
начинать только отдельным change set с characterization и совместимостью replay.

## Безопасное деление монолита

1. **Characterization (S).** Зафиксировать таблицу всех 61 экспортов, 90
   разрешённых команд, event types, порядок событий и source IDs. Снимки должны
   сравнивать `resolveCommand`, `replayEvents`, `eventSummary` и legacy streams.
   На этом шаге runtime не меняется.

2. **Pure command seam (S/M).** Вынести `normalizeCommand` и `sourceIdsFor` в
   листовой `server/rules/command-normalization.mjs` с одним интерфейсом
   `normalize(input, normalizedState) -> command`. Вынести envelope factory
   `eventFrom` рядом с контрактной проверкой. `rules-engine.mjs` сохраняет
   прежние re-export-ы, а event payload/type/schema не меняются. ARC-03 следует
   исправить до переноса, чтобы новый seam сразу стал server-owned.

3. **Вертикальные slices (M/L).** Первыми отделить уже очерченные домены:
   combat actions/attacks, scene movement/objects, character/item lifecycle,
   campaign/world commands. Для каждого seam достаточно фиксированного набора
   функций `validate(command, state, context)`, `resolve(command, state, context)`
   и `apply(state, event)`. Это мини-интерфейс внутренней реализации, не
   публичный DSL: список slices задаётся кодом, порядок reducer-ов остаётся
   явным, зависимости направлены на листовые каталоги и geometry.

4. **Reducer dispatcher (L).** Сначала перенести существующие
   `applyWorldMemoryEvent`, `applyNpcSocialEvent`, `applyItemLifecycleEvent` и
   похожие вызовы в фиксированную таблицу handlers; затем вырезать группы switch
   по ownership. Общие post-event consumers (`world_deeds`, `law`, tavern,
   captives) оставить после основного handler order, потому что текущий порядок
   является частью replay-контракта:
   [rules-engine.mjs:24713-24752](../../../server/rules-engine.mjs#L24713-L24752).
   Unknown current event должен падать по ARC-02; legacy policy должна быть
   отдельной веткой.

5. **Normalizer и trusted fast path (M).** Сначала снять fresh benchmark и
   characterization: вход нормализатора не мутируется, а
   `normalize(apply(event, normalize(state)))` совпадает с текущим публичным
   результатом по deep equality и всем post-event invariants. Только после этого
   разделить state canonicalization и event application по ARC-07. Каждая
   normalizer-функция должна быть чистой и иметь тест на snapshot/replay. Бамп
   `GAME_STATE_PROJECTOR_VERSION` разрешён
   только при изменении формы snapshot; event schema, event order и старые
   reducer markers не менять ради косметического разбиения.

Критерии завершения каждого шага: `test/server-import-graph.test.mjs` остаётся
зелёным; `node --test test/rules-engine.test.mjs test/event-store.test.mjs`
даёт прежний результат; replay из нулевого состояния совпадает со snapshot;
старые event streams и idempotency сохраняют byte/deep-equivalent outcome;
новый slice можно тестировать через его seam, не импортируя 25k-line entrypoint.

## Что не стоит обобщать сейчас

[`contracts.mjs:11-28`](../../../server/contracts.mjs#L11-L28) содержит пустые `RuleRepository`,
`CampaignRepository` и прочие заготовки без реальных adapters. По deletion test
они пока не дают leverage; переносить EventStore в абстрактный repository слой
до второго работающего backend не нужно. Также не следует превращать rule pack в
универсальный исполняемый DSL: текущий pack полезен как versioned source and
retrieval catalog, а детерминированное поведение должно оставаться в серверном
коде. Это согласуется с найденными аналогами в
[сравнительном исследовании](./01-comparable-projects.md): расширение данными и
allowlisted контрактами дешевле и безопаснее произвольного server-side plugin.
