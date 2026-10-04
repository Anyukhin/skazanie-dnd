# Контракт передачи `worldMemory` и дублирующих knowledge-полей

Аудит выполнен по merge-head `988de9d984a21a1618f7c145d3b8805ad8b4988b`,
с источниками приложения, закреплёнными на родительском commit
[`cb045a8466f35696ff24abe9020d6f39dee89462`](https://github.com/Anyukhin/skazanie-dnd/tree/cb045a8466f35696ff24abe9020d6f39dee89462).
Код сохраняет дублирование `knowledge_revealed` и `knowledge_ledger` в публичном
`worldMemory`. Число **1,78 МБ** относится к большой фикстуре
[второго прохода](../round-2/14-state-transfer-cost.md), а не к новому замеру
этого документа. Текущий эксперимент меньшего размера и варианты сжатия
описаны отдельно в [отчёте 33](33-memory-transport.md).

## Граница ответственности

Каноническая память и публичный транспорт сейчас намеренно смешаны по форме,
но не по владельцу поведения:

| Слой | Фактический владелец | Что происходит с полями |
| --- | --- | --- |
| Нормализация снимка | [`server/world-memory.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L562-L595) | Массив `knowledge_ledger` имеет приоритет. Если собственного свойства `knowledge_ledger` нет, массив `knowledge_revealed` используется как legacy fallback; если свойство присутствует, но не является массивом (`null`/`undefined`), нормализатор выбирает пустой ledger. Старый индекс `knowledge` дополняет миграцию. Затем строятся `knowledge` и оба массива как один набор записей. |
| Legacy retention | [`normalizeWorldMemoryLegacy`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L667-L703) | Сохраняет старый лимит, но также возвращает все три формы; это часть совместимости старых снимков, не HTTP-оптимизация. |
| Вход в состояние кампании | [`normalizeCampaignState`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L1840-L1850) и фактический вызов [`ensureSceneWorldMemory`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L2082-L2094), [`ensureSceneWorldMemory`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/scene-memory.mjs#L72-L88) | Любой snapshot/replay/state-import снова нормализует `worldMemory`; transport-поля нельзя удалять здесь. |
| Producer событий | [`worldMemoryEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L1036-L1071) | `RevealWorldFact` и `RecordKnowledgeRevelation` создают события с target IDs; событие остаётся прежним. |
| Reducer/replay | [`appendKnowledge` и `applyWorldMemoryEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L1074-L1093), вызовы из Rules Engine | Каждое раскрытие дописывает ledger, пересобирает `knowledge_revealed`, `knowledge_ledger` и `knowledge`. [`rules-engine.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L24820-L24860) применяет эти события при replay. |
| Видимость игрока | [`worldMemoryForViewer`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L1208-L1258) | Сначала фильтруется ledger по `playerId`, времени и видимым фактам; только после этого строятся `knowledge` и два публичных массива. Использовать неотфильтрованный `knowledge` как источник нельзя: он раскрывает знание раньше исторического момента. |
| Видимость ведущего | Та же функция, admin-ветка | Возвращает полную разрешённую администратору память и оба массива. Это доверенная внутренняя форма, но она тоже попадает в JSON admin-клиента. |

## Значимые потребители

Прямые потребители именно knowledge-форм, а не произвольных коллекций
`worldMemory`, следующие:

| Потребитель | Форма | Риск при удалении alias |
| --- | --- | --- |
| [`quest-consequences.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/quest-consequences.mjs#L20-L35) | Читает `knowledge_ledger ?? knowledge_revealed` для исторического gate | Нельзя переключить на `knowledge` без временной фильтрации; это изменит видимость старых квестовых последствий. |
| `retrieveKnownWorldMemory` в [`world-memory.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/world-memory.mjs#L1465-L1487) | Строит citation из ledger с fallback на `knowledge_revealed` | Должен продолжить получать только viewer-filtered записи и их provenance. |
| [`player-request-router.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/player-request-router.mjs), [`director-agent.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/director-agent.mjs), [`campaign-recap.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/campaign-recap.mjs), [`npc-social-controller.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-social-controller.mjs) | Вызывают `knownWorldLore`, `retrieveKnownWorldMemory`, `retrieveWorldMemory` или `worldMemoryForViewer`; напрямую JSON-алиасы не формируют | Их вход остаётся серверной проекцией. Изменять их ради транспортной экономии не нужно. |
| Rules Engine и scene-memory | Работают с canonical `worldMemory` после нормализации и replay | Удаление поля в reducer или snapshot ломает старые события/снимки и не даёт экономии только на HTTP. |
| Браузерный UI | `src/AppViews.tsx`, `src/PartyPage.tsx`, `src/dungeon-map-parts.tsx` читают quests/threads/summaries/entities/claims; alias не читают | Текущая TS-модель [`WorldMemoryProjection`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/types.ts#L1998-L2033) не объявляет ни `knowledge`, ни `knowledge_revealed`, ни `knowledge_ledger`. Это снижает риск для штатного UI, но не является доказательством наличия полноценного decoder-а или отсутствия внешних клиентов. |

Другие server-модули читают `worldMemory.facts`, `entities`, `quests` и другие
коллекции, но не зависят от этих трёх форм напрямую. Поэтому расширенный
read-model для всей памяти имеет больший blast radius, чем устранение одной
публичной копии.

## Все публичные ingress-пути

Единый владелец публичной формы — `campaignStateForViewer`: он исключает сырую
`worldMemory` из общего spread и вставляет результат `worldMemoryForViewer`
([source](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/viewer-projection.mjs#L1781-L1789),
[insertion](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/viewer-projection.mjs#L1960-L1977)).
`viewerStateFor` добавляет к нему прогноз боя, не создавая второй memory-проектор
([`server/index.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2313-L2315)).

Это покрывает:

- `GET /api/rooms/:code`, включая `map_hash` и полный reconnect;
- SSE `room` кадры, где projection пересобирается для каждого соединения;
- ответы campaign commands, system tick, public dice, party/quest decisions и
  map import/rebuild — они используют `viewerStateFor`;
- ответы свободного действия/наррации и тактических команд — их
  `authoritative_state` проходит через `turnResultForViewer`
  ([`server/viewer-projection.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/viewer-projection.mjs#L2600-L2641));
- admin-ветку `campaignStateForViewer`, которая намеренно возвращает более
  полную форму.

Существующий transport-компактор касается только карты сцены: он умеет
`full/delta/unchanged`, но не сокращает `worldMemory`
([`server/reveal-transport.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/reveal-transport.mjs#L124-L160)).

Следовательно, новый alias-контракт должен принадлежать небольшому чистому
transport-adapter-у **после** `campaignStateForViewer` и
`turnResultForViewer`, а не менять `worldMemoryForViewer`. Последний уже
является владельцем visibility и одновременно используется внутренними
агентами/детерминированным worldkeeper; перенос HTTP-версии в него создал бы
вторую политику видимости. Adapter получает уже разрешённый state/result,
удаляет только дублирующий public alias по согласованной версии и не принимает
сырой canonical state.

## Клиент, reconnect и скрытая проекция

`useGameSession` принимает room/command JSON как `GameState`, затем делает
полный spread authoritative state в `mergeTacticalCommandState`
([`src/useGameSession.ts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L317-L357)).
Для room/SSE тот же объект проходит `applyRemote`, очередь кадров и
`BroadcastChannel` ([`src/useGameSession.ts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L512-L527),
[SSE receive](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L634-L649)).
Кросс-сессионный `localStorage` хранит только код комнаты, поэтому старый
снимок памяти не восстанавливается из него; reconnect получает новый полный
разрешённый room snapshot ([`loadState`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L360-L368),
[`switchCampaign`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L1990-L2028)).

Следствия:

1. Текущий React не требует aliases, но не фильтрует неизвестные поля и не
   является защитой для старых или внешних клиентов. Отсутствие alias-чтения в
   `src` не доказывает наличие decoder-а: например, запрос `/api/narrate`
   отправляет только action/campaign/actor и параметры команды
   ([`src/ai-client.ts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/ai-client.ts#L169-L190)),
   а итоговая память приходит отдельным `authoritative_state` и принимается
   через общий spread.
2. SSE нельзя считать capability negotiation: `EventSource` открывается без
   пользовательского transport-заголовка ([`useGameSession.ts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/useGameSession.ts#L620-L731)).
3. Нельзя удалять поле до viewer-фильтрации: для скрытого зрителя оба alias
   должны описывать только его `playerKnowledge`, включая `asOfMinutes`.
4. Нельзя использовать `worldMemory.schema_version === 2` как transport
   version: это версия доменной схемы, которую создаёт нормализатор, а не
   capability клиента.

## Матрица совместимости

| Поверхность | Сейчас | Безопасный контракт миграции |
| --- | --- | --- |
| Event log, replay, snapshots, `normalizeCampaignState` | Три формы, aliases синхронны | Сохранить без изменений. Transport PR не трогает reducer, event payload, retention и persistence. |
| Admin/private viewer | Полная memory с обоими aliases | Сохранить v1 до отдельного решения admin-клиента; скрытых viewer-данных это не меняет. |
| Player room/command/SSE по умолчанию | `knowledge`, `knowledge_revealed`, `knowledge_ledger` после viewer-фильтра | Оставить v1 по умолчанию, чтобы старый JS и reconnect не получили неполную форму. |
| Новый явно согласованный player transport v2 | Сейчас отсутствует | Отдавать `knowledge_ledger` как единственный массив и derived `knowledge`; удалять только `knowledge_revealed` после фильтрации. Канонический ledger внутри сервера не переименовывать. |
| Текущий `src` | Alias не типизирован и не читается | Добавить тип только для выбранной v2 формы либо не менять UI, если decoder не нужен. Не делать client-side реконструкцию из непроверенных фактов. |
| Старый клиент / unknown client / reconnect без capability | Ожидает прежний shape или может произвольно читать поле | Всегда v1. Отказ/отсутствие capability не должен молча означать v2. |
| Cursor/read-model | Полного cursor-контракта нет | Не объединять с alias PR. Для него отдельно определить viewer, state version, knowledge revision, gap/reconnect и permission invalidation. |

## Выбор миграции

Рекомендуется минимальный PR: убрать дублирование только на явно
версионированной public player transport boundary через чистый adapter после
`campaignStateForViewer`/`turnResultForViewer`. Canonical memory, legacy
normalization, event replay, admin output и существующий full snapshot остаются
прежними. Единственный публичный массив v2 — `knowledge_ledger`; `knowledge`
остаётся индексом для совместимого чтения, но строится из уже отфильтрованного
ledger. Число 1,78 МБ — только измерение из [round 2/14](../round-2/14-state-transfer-cost.md);
новый PR должен перемерить свою малую фикстуру и не переиспользовать эту цифру
как результат.

Версию следует согласовывать явной capability клиента на всех state-путях
(room GET, command responses и SSE query/connection context). Нельзя выводить её
из имени команды, наличия `map_hash`, роли пользователя или domain
`schema_version`. Если для SSE понадобится query capability, тот же режим должен
быть сохранён на reconnect; отсутствие capability возвращает v1.

Более широкий `snapshot + event cursor`, отдельные страницы памяти и
viewer-specific read model — следующий самостоятельный PR. Это уже меняет
семантику repair после пропущенного SSE, initial load, state-version conflict и
проверку видимости новых раскрытий. Тип команды (`MoveActor` и т. п.) не может
решать, нужно ли передавать память: раскрытие возможно через последствия хода.

## Приёмка следующего малого PR

- Канонические `normalizeWorldMemory*`, `ensureSceneWorldMemory`, event producer,
  reducer и replay дают побайтно прежнее состояние; новые тесты не меняют
  порядок/состав событий.
- Введена одна явно названная версия public player transport; v1 остаётся
  default для старого клиента, unknown capability и reconnect.
- В v2 adapter получает уже разрешённый результат `worldMemoryForViewer`,
  сохраняет `knowledge` и `knowledge_ledger`, а `knowledge_revealed`
  отсутствует. Admin output и внутреннее состояние не изменены; selector и
  visibility policy `worldMemoryForViewer` не дублируются.
- Один и тот же v1/v2 decoder покрывает room GET, SSE кадр, tactical/free-action
  `authoritative_state`, system tick, dice/party/quest и map-import ответы.
- Проверены два viewer-а: знание героя A не видно герою B, `asOfMinutes` не
  видит будущее раскрытие, а скрытый факт не появляется через индекс или
  alias. Проверены full reconnect и same-key replay.
- `src/types.ts` явно документирует только выбранную public v2 форму (если она
  нужна UI); alias не добавляется обратно через широкий object spread.
- В отчёте измерен полный HTTP/SSE размер и время для v1/v2 на той же фикстуре;
  cursor/read-model и request-local memoization остаются за пределами PR.
