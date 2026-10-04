# Сравнительное исследование расширяемых RPG-проектов

Дата среза: 4 октября 2026 года (MSK). Исследованы только первичные источники:
официальные репозитории, файлы в них и официальная документация проектов. Для
репозиториев зафиксирован commit, полученный 4 октября; даты commit указаны в
UTC. Это отдельное исследование архитектурных практик, а не вывод о конкретных
дефектах текущего кода «Сказания».

| Проект | Зафиксированный источник | Лицензия кода |
| --- | --- | --- |
| [Loreweaver](https://github.com/1A7432/loreweaver/tree/b4600230a25157ffd74d14fdbb361903d47da87e) | `main` `b460023` от 2026-09-30; [plugin contract](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/docs/plugins.md), [protocol](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/docs/protocol.md) | MIT; содержимое SRD и паков имеет отдельные условия |
| [boardgame.io](https://github.com/boardgameio/boardgame.io/tree/5e9a2c94bde803fae8b081958c406c4d0a7be8ae) | `main` `5e9a2c9` от 2026-08-10; [Master](https://raw.githubusercontent.com/boardgameio/boardgame.io/5e9a2c94bde803fae8b081958c406c4d0a7be8ae/src/master/master.ts), [storage base](https://raw.githubusercontent.com/boardgameio/boardgame.io/5e9a2c94bde803fae8b081958c406c4d0a7be8ae/src/server/db/base.ts) | MIT |
| [PlanarAlly](https://github.com/Kruptein/planarally/tree/f41ccbaab4ed3983844700c844bc181c3c7bd0af) | `dev` `f41ccba` от 2026-10-02; [architecture](https://github.com/Kruptein/planarally/blob/f41ccbaab4ed3983844700c844bc181c3c7bd0af/ARCHITECTURE.md), [mods](https://www.planarally.io/docs/dm/mods/) | MIT |
| [Foundry D&D5e](https://github.com/foundryvtt/dnd5e/tree/d1f0cb192c30d2653aaccf010ea32025c74ac6a4) | `6.0.x` `d1f0cb1` от 2026-10-03; [base activity model](https://raw.githubusercontent.com/foundryvtt/dnd5e/d1f0cb192c30d2653aaccf010ea32025c74ac6a4/module/data/activity/base-activity.mjs), [activity mixin](https://raw.githubusercontent.com/foundryvtt/dnd5e/d1f0cb192c30d2653aaccf010ea32025c74ac6a4/module/documents/activity/mixin.mjs) | MIT для software-компонента; изображения и прочие assets отдельно |
| [Evennia](https://github.com/evennia/evennia/tree/a89a9b94e4d7ed0acfee86def533b77bf6baa512) | `main` `a89a9b9` от 2026-08-19; [core beliefs](https://raw.githubusercontent.com/evennia/evennia/a89a9b94e4d7ed0acfee86def533b77bf6baa512/.agents/docs/core-beliefs.md), [persistent Scripts](https://raw.githubusercontent.com/evennia/evennia/a89a9b94e4d7ed0acfee86def533b77bf6baa512/evennia/game_template/typeclasses/scripts.py) | BSD-3-Clause |
| [Tabletop Club](https://github.com/drwhut/tabletop-club/tree/a4fb379b0f4af1f066bf378bd652d8be90d64e32) | `master` `a4fb379` от 2026-08-30; [asset packs](https://docs.tabletopclub.net/en/stable/custom_assets/asset_packs/asset_pack_structure.html), [lobby server](https://github.com/drwhut/tabletop_club_lobby_server/tree/01aff1694cc9731082419f1f127e49c3494e617e) | MIT для кода; assets могут иметь разные открытые лицензии |

## 1. Loreweaver: наиболее близкий AI-кейс

В [README Loreweaver](https://github.com/1A7432/loreweaver/blob/b4600230a25157ffd74d14fdbb361903d47da87e/README.md) описаны четыре роли: Keeper-модель ведёт ход,
engine-код владеет бросками и листами, Scribe предлагает сверку нарратива с
ledger, а Director создаёт презентационные блоки. README и `plugins.md` — это
docs-described контракт, а не доказательство каждого runtime-пути; два важных
механизма подтверждаются исходниками: [Scribe](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/agent/scribe.py)
действительно отделяет bounded bookkeeping от fiction, а [Document layer](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/core/documents.py)
реализует projection registry и единый outbound choke point. Новая система правил
кладётся в YAML; для сложного случая docs и pack loader предусматривают отдельный
sandbox-скрипт с заранее выполненным броском и bounded verdict.

Главный extension seam — слой данных и pack-манифест. Реальный [pack loader](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/core/pack.py)
собирает `.lwpack` из правил, карт, lorebook, skills, панелей и media, проверяет
hash/границы архива и оставляет `install != enable`. Кодовые расширения разложены
по риску: data plugins и allowlisted skills считаются безопасными, server-side
Python entry points отложены. Это хороший образец постепенного расширения без
превращения каждого модуля в произвольный плагин, но не основание немедленно
вводить такую же общую систему в «Сказании».

Для многопользовательской видимости исходник [core/documents.py](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/core/documents.py)
действительно задаёт одну границу: каждый тип `Document` реализует
`project(document, viewer)`, а наружу всё проходит через проекцию. В protocol 2.x
`audience` и фильтр переменных разрешаются сервером;
клиентское `visible_when` управляет только отрисовкой уже разрешённого блока и
обязан закрывать блок при ошибке. Campaign chronicle сохраняет документы,
сворачивает старые записи в summary при заполнении контекстного окна и оставляет
последние четыре хода нетронутыми. Это сочетает долговременную память с
ограниченным prompt budget.

Для «Сказания» применимы `install != enable` как свойство уже существующих
versioned rule/content packs и отдельный Scribe-подобный постаудит предложений
модели. Не следует переносить напрямую Python/TUI-структуру, доверять клиентскому
рендеру как контролю секрета или оставлять модель единственным источником памяти.
Loreweaver docs и код показывают два разных решения: его Stage Director намеренно
player-scoped (см. [реальный source](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/agent/stage_director.py)
и [isolation test](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/tests/architecture/test_director_isolation.py)),
тогда как Keeper получает закрытый контекст. Для «Сказания» это не означает
универсально лишать доверенные Director/Scene Architect закрытых данных: их
контракт может быть server-owned и role-specific; public Narrator обязан получать
только viewer projection. Сам проект предупреждает, что Keeper может получить
keeper-only lore и удалённый LLM-провайдер её увидит; provider keys хранятся в
локальной SQLite без шифрования. Код MIT, но это не лицензия на чужие SRD,
adventure text и assets; software-лицензия — [MIT](https://raw.githubusercontent.com/1A7432/loreweaver/b4600230a25157ffd74d14fdbb361903d47da87e/LICENSE).

## 2. boardgame.io: компактные контракты authoritative multiplayer

`Master` держит authoritative state и получает два явных интерфейса: `TransportAPI`
для отправки update/patch/chat и `StorageAPI` для state, metadata, initial state и
deltalog. В `onUpdate` сервер проверяет credential, активность игрока, допустимый
move и `_stateID`; устаревшая команда отклоняется, если move специально не
помечен `ignoreStaleStateID`. После reducer state рассылается целиком или как
delta, а `deltalog` добавляется в storage. `onSync` возвращает state, initialState,
log и отфильтрованные player metadata. Storage base поддерживает sync/async
адаптеры и фильтры списка матчей.

Видимость задаётся [`game.playerView`](https://github.com/boardgameio/boardgame.io/blob/5e9a2c94bde803fae8b081958c406c4d0a7be8ae/docs/documentation/api/Game.md)
`({G, ctx, playerID})`; для plugin есть такой же `playerView`. Это полезнее, чем разрозненные проверки в UI: состояние режется
перед transport. Extension seam здесь — конфигурация Game (moves, phases, turns,
plugins, playerView), а не наследование большого сервера.

Для «Сказания» стоит перенять разделение `Engine`/`Transport`/`Storage`, проверку
версии состояния и delta-представление для тяжёлых read-моделей. Но snapshot + log
контракт boardgame.io не обещает атомарности event commit и projection, а
`playerView` — функция конкретной игры, не полноценная иерархия ролей, скрытых
документов и viewer-specific traces. Поэтому это источник интерфейсных идей, а не
замена event store. Лицензия кода — [MIT](https://raw.githubusercontent.com/boardgameio/boardgame.io/5e9a2c94bde803fae8b081958c406c4d0a7be8ae/LICENSE).

## 3. PlanarAlly: real-time VTT, временные сообщения и клиентские модули

Архитектура PlanarAlly разделяет Python-сервер и TypeScript/Vue-клиент. В [официальном описании self-hosting](https://www.planarally.io/server/setup/self-hosting/)
также зафиксированы отдельные persistent volumes. В игровом
сеансе Socket.IO даёт двусторонний канал, а обычный HTTP обслуживает остальное;
namespaces отделяют asset store от core. Socket-событие может иметь `temporary`:
сервер проверяет права и рассылает его, но не тратит время на persistence. Это
полезная граница для presence, курсора и preview, которые не должны засорять
канонические события. API клиента рекомендует вызывать wrapper-функции, а не
импортировать socket напрямую, чтобы типы и протокол менялись в одном месте.

Состояние хранится в SQLite через ORM; `save.py` отвечает за миграции. Документация
отдельно требует сохранять `data`, `static/assets` и `static/mods`, а WAL-файл
важен для восстановления. Видимость на карте составляется из слоёв, уровней,
private DM-layer, fog-of-war, light/line-of-sight и трёх прав shape (edit,
movement, vision). Это конкретный пример того, как право менять объект и право
видеть его эффект могут быть разными.

Mods — [`.pam` zip по официальному API](https://www.planarally.io/docs/dm/mods/),
запускаемый в браузере. Мод не получает произвольный server code и не читает БД;
для хранения ему выдан DataBlock API. Зафиксированный commit с [mod registry,
lifecycle, dispose и опубликованным `@planarally/mod-api`](https://github.com/Kruptein/planarally/commit/f41ccbaab4ed3983844700c844bc181c3c7bd0af)
подтверждает этот extension seam исходником; полный commit diff содержит [registry](https://github.com/Kruptein/planarally/blob/f41ccbaab4ed3983844700c844bc181c3c7bd0af/client/src/mods/registry.ts), [lifecycle](https://github.com/Kruptein/planarally/blob/f41ccbaab4ed3983844700c844bc181c3c7bd0af/client/src/mods/lifecycle.ts) и [`@planarally/mod-api`](https://github.com/Kruptein/planarally/blob/f41ccbaab4ed3983844700c844bc181c3c7bd0af/mod-api/src/index.ts). Это безопаснее серверного исполнения
кода, но экспорт кампании не включает mods, а API меняется между релизами.

Для «Сказания» подходят отдельные ephemeral transport events, явные ACL на
видимость/действие и versioned client API. Нельзя брать client-side mods для
правил, бросков или secret projection: они годятся для панелей и локального UX.
Также не следует копировать связку «SQLite snapshot плюс asset folders» поверх
канонического event store без outbox/reconciliation. Код PlanarAlly — [MIT](https://raw.githubusercontent.com/Kruptein/planarally/f41ccbaab4ed3983844700c844bc181c3c7bd0af/LICENSE).

## 4. Foundry D&D5e: registry, base schema и hooks вместо ветвления

В D&D5e для Foundry действие описано базовой `BaseActivityData` schema. Общие
поля включают activation, consumption, duration, effects, range, target, uses и
visibility; конкретные типы (attack, cast, check, save и другие) расширяют модель.
`ActivityMixin` добавляет metadata, `canUse`, скрытие по attunement/identification/
level и применение consumption. `Item.createActivity(type, data)` получает
`CONFIG.DND5E.activityTypes[type]` и создаёт зарегистрированный document class.
Wiki проекта прямо описывает, что модули могут добавлять свои activity types.

[`Activities wiki`](https://github.com/foundryvtt/dnd5e/wiki/Activities) и
[`Advancement wiki`](https://github.com/foundryvtt/dnd5e/wiki/Advancement) явно
документируют эти точки расширения. Advancement устроен аналогично: custom type наследует базовый `Advancement`,
описывает data/config/display и регистрируется в `game.dnd5e.advancement.types`.
Общие hooks, например `dnd5e.postActivityConsumption`, дают контроль вокруг
операции, не заставляя модуль переписывать обработчик атаки. Это хороший образец
для «Action Definition + Resolver + metadata + lifecycle hooks».

В «Сказании» такой registry может описывать action/spell/feature schema, UI
metadata, resource consumption и projection labels. Базовая schema должна быть
узкой и versioned; resolver обязан оставаться в Rules Engine и писать события.
Нельзя напрямую импортировать классы Foundry: они зависят от глобального
runtime, DataModel и документов Foundry. Репозиторий указывает MIT только для
software-компонента; SRD 5.1/5.2, изображения и прочие assets имеют собственные
условия, поэтому license provenance нужно вести на уровне пакета. Software-компонент
помечен [MIT](https://raw.githubusercontent.com/foundryvtt/dnd5e/d1f0cb192c30d2653aaccf010ea32025c74ac6a4/README.md#licenses),
а SRD/assets не следует считать автоматически MIT.

## 5. Evennia: typeclasses, composable hooks и fail-closed locks

Evennia сознательно является toolkit, а не игрой: core предоставляет networking,
persistence и command routing, а genre/mechanics остаются downstream. Один
`ObjectDB` получает Python `db_typeclass_path`; поведение расширяется subclass-ом,
а произвольные persistent attributes хранятся через `db` без новых таблиц.
Жизненный цикл вынесен в hooks вроде `at_object_creation`, `at_pre_move`,
`at_look`; CommandSets объединяются set-операциями, поэтому состояния можно
добавлять и снимать композиционно.

Для доступа Evennia использует [lock mini-language](https://www.evennia.com/docs/5.x/Components/Locks.html), который парсит только
разрешённые lock functions, и начинает с deny-by-default; это же ограничение
зафиксировано в [core beliefs](https://raw.githubusercontent.com/evennia/evennia/a89a9b94e4d7ed0acfee86def533b77bf6baa512/.agents/docs/core-beliefs.md).
`Script` — persistent
объект для систем без физического присутствия (экономика, combat tracker) с
interval/ticker, pause/restart и server start/shutdown hooks. Это даёт понятный
seam для мировых сервисов и расписаний.

Для «Сказания» полезна терминология и форма: feature-команда может быть
композируемым модулем с lifecycle hooks, а permission policy должна быть
fail-closed и декларативной. Однако mutable attributes на объектах и direct
hooks нельзя сделать вторым authoritative path рядом с событиями. Их роль лучше
ограничить derived/read model, bounded state или адаптером к typed command/event.
Evennia распространяется под [BSD-3-Clause](https://raw.githubusercontent.com/evennia/evennia/a89a9b94e4d7ed0acfee86def533b77bf6baa512/LICENSE.txt).

## 6. Tabletop Club: asset packs и дешёвый lobby, но не authority

Tabletop Club — Godot multiplayer simulator. Asset pack — обычная папка,
сканируемая при старте; подпапки типизируют boards/cards/dice/games/music и
`config.cfg` содержит name, author, license, URL, physics и ignore. Сохранение
создаёт `.tc` и thumbnail `.png`, а сохранённая игра может поставляться внутри
pack. Это простой и понятный путь для community content и воспроизводимых
стартовых сцен.

Отдельный [lobby server](https://github.com/drwhut/tabletop_club_lobby_server/blob/01aff1694cc9731082419f1f127e49c3494e617e/README.md) — WebSocket-сервис для уникальных четырёхбуквенных room
codes. После входа он только сигнализирует WebRTC offer/answer/candidate, а клиенты
соединяются peer-to-peer. Сервер умеет перечитывать TOML-конфигурацию и менять
лимит комнат/сообщений без рестарта. Сам README предупреждает, что rate/connection
limits отсутствуют и рекомендует reverse proxy; metrics отмечены как будущая
работа. Значит, это полезная модель lobby/signalling, но не authoritative
mechanics или durable campaign state.

«Сказанию» можно взять manifest-поля provenance/license и pack-ориентированный
контент, а при необходимости отделить лёгкий lobby от игрового сервера. Нельзя
переносить P2P authority, snapshot save как каноническую историю или физическую
модель как основу D&D-правил. Код — [MIT](https://raw.githubusercontent.com/drwhut/tabletop-club/a4fb379b0f4af1f066bf378bd652d8be90d64e32/LICENSE), но официальная документация отдельно
предупреждает, что assets имеют разные лицензии.

## Сводные выводы для дальнейшего расширения «Сказания»

Сравнение не требует создавать новые универсальные слои. В «Сказании» уже есть
владельцы большей части этих задач: `server/authoritative-executor.mjs` задаёт
`executeCommands`/`commitDerived`/`commitControl`, capability allowlist,
optimistic retry и idempotency; `server/event-store.mjs` хранит события,
snapshots и replay; `persistAuthoritativeProjection` вместе с projection
outbox/checkpoint и reconciliation обслуживает совместимую room read-model;
`server/viewer-projection.mjs` отвечает за state/event/response visibility;
`server/reveal-transport.mjs` уже различает `full`/`delta`/`unchanged` и при
сомнении возвращает полный snapshot. Поэтому рекомендации ниже — точки усиления
этих владельцев, а не предложение второго authoritative path.

1. **Усилить существующий ruleset/pack owner.** `server/rule-pack.mjs` уже
   валидирует manifest, source registry, version, license, IDs, numeric integrity
   и coverage; `ruleset-config.mjs`/campaign lock уже привязывают кампанию к
   выбранному versioned pack. Для следующего расширения достаточно добавлять
   provenance, compatibility/migration metadata или новый resolver в эти форматы.
   Активный или запрошенный pack должен по-прежнему fail closed: ошибка загрузки
   или валидации не может тихо превратить его в пустой/частичный pack. Если когда-
   нибудь появится discovery необязательных пакетов, только неактивный пакет можно
   изолированно пометить недоступным и показать диагностике; включённый pack
   должен останавливать запуск/переключение с точной ошибкой.
2. **Довести единственный authoritative executor до всех writers.** Практика
   boardgame.io с version check и transport/storage seam подтверждает направление,
   уже заложенное в `AuthoritativeExecutor`. Полезный следующий аудит — список
   оставшихся прямых `eventStore.commit` и проверка, что каждый производный путь
   имеет явную capability/allowlist, а каждый conflict/retry описан тестом. Новый
   outbox создавать не нужно: следует расширять текущий projection
   outbox/checkpoint/reconciliation и не вводить ещё один writer для room JSON.
   `reveal-transport` следует расширять только через его существующий full fallback:
   delta применима, когда восстановленная проекция побайтно совпадает.
3. **Сохранять существующую границу видимости.** Новый state/event/response
   surface должен подключаться к `viewer-projection.mjs`, а карта — к текущему
   reveal transport и его тестам. При этом роли не обязаны получать одинаковый
   brief: trusted Director/Scene Architect могут работать с закрытым контекстом
   в своих server-owned contracts, если их intent и capability остаются bounded;
   public Narrator должен получать только разрешённую viewer projection и
   committed events. Эта граница точнее универсального запрета для всех AI-ролей.
4. **Расширять уже собранный AI pipeline.** `GameOrchestrator`, intent parser,
   retriever, adjudicator, Rules Engine и `narrator.mjs` уже разделяют proposal,
   validation, commit и narration; verifier проверяет текст после commit. Из
   Loreweaver имеет смысл взять только bounded Scribe-паттерн для конкретной
   дырки (например, evidence-gated world-memory/trackers), разместив его в
   существующем orchestration/narration owner и не превращая его в новый общий
   agent framework. LLM по-прежнему не назначает числа, ресурсы, координаты или
   события.
5. **Обобщать локально, по владельцу домена.** Foundry и Evennia показывают
   пользу base schema + metadata + lifecycle hook, но в текущем проекте это
   следует применять внутри существующего Rules Engine, `server/rules/*`,
   deterministic narration или `authoritative-executor` — например, для нового
   spell/action contract с resolver и тестом. Универсальный plugin framework,
   произвольные server-side hooks и отдельная permission DSL сейчас расширят
   поверхность сильнее, чем помогут; capability allowlist и текущие command
   contracts уже дают нужный seam.
6. **Не вводить новый neutral wire protocol преждевременно.** boardgame.io и
   Loreweaver подтверждают ценность versioned contracts, но у «Сказания» уже
   существуют HTTP/room/reveal contracts и versioned rule packs. Новое поле
   следует добавлять через текущую схему/миграцию и соответствующие guards;
   отдельная capability negotiation нужна только при появлении второго реального
   клиента. License/provenance нужно продолжать вести в существующих rule/asset
   registries, не создавая параллельный каталог.

Эти выводы согласуются с продуктовыми принципами «Сказания» — серверная
честность, event-sourced причинность, видимость по правам и раздельные полномочия
AI. Конкретный порядок работ и приоритеты оставлены общему аудиту; этот файл
фиксирует только сравнительные ограничения и места существующих owners, которые
стоит расширять.

## Что подтверждено и что нельзя считать доказанным

Подтверждены только перечисленные design contracts, исходные файлы и ограничения
по состоянию на зафиксированные commit/docs. Сравнение не доказывает, что каждая
функция проекта покрыта тестами, масштабируется на произвольное число кампаний
или безопасна при недоверенных community packs. Рекомендации по применению к
«Сказанию» — архитектурные гипотезы для следующего аудита; конкретные места
реализации должны пройти отдельную проверку текущего кода, тестов и migration
contracts.
