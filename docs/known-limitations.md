# Известные ограничения

## Главный статус

Проект больше не состоит из активного legacy runtime и «изолированных» новых модулей. `server/index.mjs` подключает Rule Pack/Retriever, Dice Service, Roll Registry, Rules Engine, FileEventStore, mode resolver, Game Orchestrator, Narrator, Verifier и Trace Store.

Архитектура остаётся гибридной:

- `legacy` сохраняет прежнюю семантику через compatibility handler;
- `shadow` запускает новый контур для сравнения, не делая его результат авторитетным;
- `enforce` фиксирует события нового Rules Engine и проецирует подтверждённый state обратно в legacy room; базовый видимый бой использует typed server commands и NPC scheduler, а подтверждённый переход группы — `AdvanceScene`/`SceneAdvanced` с optional `ShopAssembler`;
- browser UI и room `PUT` пока сохраняют часть старой state-oriented модели.

Наличие доступного `enforce` не означает готовность к production cutover: ниже перечислены функциональные и эксплуатационные пробелы.

## Покрытие правил и механики

Новый Rules Engine доступен через typed `/api/campaigns/:id/commands` при effective mode `enforce` и через orchestrated `/api/narrate` path. Обычному игроку endpoint разрешает безопасный боевой набор, включая `MakeAttack`, `MakeAreaAttack` и `ChangeWeapon`, за назначенного героя; admin имеет расширенный диагностический набор. Реализованы базовые checks/saves/attacks, damage/healing/temp HP, modifiers, generic resources/conditions, initiative, часть action/movement economy, concentration markers и zero-HP marker. Ограничения:

### Critical hits

Новый Engine для атаки трактует natural 1 как промах, natural 20 как critical и преобразует, например, `1d8+2` в `2d8+2`: удваиваются только кости, не модификатор. Для структурированных ranged-предметов используется DEX, normal/long range и помеха в дальнем диапазоне или рядом с противником; старые луки, арбалеты, гранаты и динамит распознаются по названию. Остаточное ограничение — нет полного справочника всех оружейных свойств, cover, сложных damage riders и учёта боеприпасов; гранаты/динамит являются явно заданным правилом кампании, а не общей гарантией SRD.

### Action economy

Action расходуется для attack/spell; combat spell с casting time `bonus_action` отдельно расходует бонусное действие. В server-authoritative combat перемещение учитывается по пройденному ортогональному пути и сбрасывается при начале следующего хода. Реакция отображается и восстанавливается вместе с экономикой хода, но trigger validation, ready action и reaction windows пока отсутствуют.

### Conditions

Engine хранит generic condition ID/duration, но не применяет индивидуальные эффекты blinded, prone, stunned, poisoned и остальных состояний.

### Concentration

`ApplyDamage` и damage от `MakeAttack` могут создать `ConcentrationCheckRequired`, но нет полного Constitution save workflow, обработки success/failure и завершения связанного эффекта. Будущие spell/effect damage paths должны пройти тот же follow-up parity gate.

### Zero HP и смерть

Есть переход к unconscious marker для поддержанного damage path. Нет death saves, stabilization, instant death, damage while dying и полного восстановления состояния после healing.

### Initiative и turns

Есть сортировка, active index/round и команда/event `EndCombat`/`CombatEnded`; собранная встреча дополнительно получает `EncounterEnded`. Bounded scheduler автоматически пропускает побеждённых и завершает базовый бой, когда не осталось живых героев либо врагов. Tie policy упрощена; отсутствуют surprise, held/delayed turns, полные reaction windows, surrender/flee/objective outcomes и reward/loot lifecycle.

### Карта, дальность и NPC scheduler

В `enforce` ортогональный BFS проверяет проходимые клетки, стены, occupancy, скорость и уже потраченное movement; дальняя атака использует сеточную дистанцию, проверяет прямую траекторию через стены, а метательный предмет — серверную область. Присланные клиентом distance/path/range не считаются источником истины. Ограничения: нет difficult terrain, размерности существ, forced movement, opportunity attacks, cover, высоты/трёхмерной LOS и per-player vision.

NPC scheduler представляет bounded deterministic policy: выбирает ближайшего достижимого героя, при необходимости двигается, делает одну базовую атаку и завершает ход до следующего PC. Это не `npc_controller` и не Tactical Controller agent; нет тактических целей, сложных действий, заклинаний, bonus actions/reactions, morale и координации группы.

### EncounterAssembler и mini-compendium

Admin UI/API в `enforce` умеет собрать и сразу начать встречу. Сервер принимает только allowlisted difficulty/theme, считает официальный XP Budget per Character SRD 5.2.1 для уровней 1–20 и выбирает противников из пяти server-owned profiles. Spawn ограничен раскрытыми проходимыми клетками, достижимыми от группы, без feature/occupancy и минимум в 10 футах от каждого героя; `EncounterCreated` и `CombatStarted` входят в один commit, а reducer/replay и player projection подключены к общему контуру.

Это не полный encounter/monster subsystem. Пять записей — только primary-attack projections без traits, saves/skills, resistances/immunities, multiattack, spells, reactions и особых действий. Нет tactics profiles, loot/rewards, Tactical Controller, автоматического Director trigger или realtime multi-browser гарантии.

### Resources, rest и spells

Generic resource pools работают, но rest создаёт marker event без восстановления конкретных ресурсов. Основная доска получила ограниченный server-owned combat spell catalog: spell attack, save, лечение действием/бонусным действием и `summon-beast` vertical slice с ячейками, дальностью и концентрацией. Это не полный spellcasting engine: полного class spell list, upcast, components, class features и сложных эффектов пока нет.

### Торговля и предметы

В `enforce` есть server-authoritative витрина, команды `BargainWithMerchant`, `AppraiseItem`, `BuyItem` и `SellItem`, целочисленная валюта, server catalog, versioned appraisal policy, bounded merchant pricing/purse, проверка владельца/локации/версии и атомарное изменение кошелька героя, кассы NPC, инвентаря и stock в одном event commit. Клиент не передаёт цену, appraisal policy или результат броска и не делает optimistic mutation.

Это узкий economy slice. Ручной `RestockMerchant` есть, но нет полного item corpus, EP, автоматических restock clocks, services/устойчивого диалога, supply/demand, reputation, taxes, theft, debts, crafting и magic-item economy. Текущий appraisal — bounded формула категории/редкости/состояния: он не идентифицирует свойства magic item, а merchant workflow пока фиксирует состояние как `serviceable`. Касса ограничивает ликвидность, но не моделирует спрос на конкретный товар. Торг разрешён один раз для пары герой–торговец и использует упрощённую проверку Харизмы. Минимальный выкуп 1 CP, appraisal formula, наценка и поправка торга являются правилами кампании, а не SRD. Equip/use effects купленных armor, shield и potion ещё не связаны с полной механикой предметов.

### Переходы сцен и автоматическая лавка

В `enforce` resolved решение группы может вызвать server-owned `AdvanceScene`. `SceneAdvanced` атомарно заменяет карту, переносит отряд, обновляет adventure history и очищает прежний encounter; для распознанного поселения bounded `ShopAssembler` добавляет `MerchantCreated` в тот же commit. Wilderness не получает постоянную лавку по умолчанию. Решение связано с `interaction_id + resolved_option_id`, исполняется exactly once при конкурентных запросах, а retry победившего ключа воспроизводится из committed event batch без повторного вызова модели.

Это не полный autonomous Director. Открытие голосования и голоса пока сохраняются в compatibility-room, а не отдельными событиями; потребление resolved decision уже фиксируется в `SceneAdvanced`. Классификация сцены эвристическая, но commerce intent больше не может превратить wilderness в settlement. Повторное использование магазина основано на нормализованной строке локации без устойчивого `location_id`, поэтому одноимённые места могут быть ошибочно объединены. EncounterAssembler пока доступен только вручную администратору и не подключён к Director flow; отдельный NPC social assembler, городской dialogue/services lifecycle и долгосрочные world entities отсутствуют.

## Rule Pack и Retrieval

- В corpus только 21 короткий оригинальный RU/EN пересказ базовой механики, включая 2 economy rules, а не полный SRD или rulebook.
- Нет полного spell, monster, item, class, feat, encounter или economy corpus; отдельно от Rule Pack существуют лишь пять monster primary-attack projections и небольшой server catalog стартового снаряжения.
- Local vector использует deterministic feature hashing, не обученную semantic embedding model.
- Russian stemming и fuzzy matching эвристические; возможны false positives/negatives.
- Ontology expansion ограничен одним bounded шагом.
- Нет production relevance metrics, feedback loop или benchmark для большого pack.

Retriever подключён к search API и orchestrator и строго фильтрует ruleset. Referential IDs Rules Engine согласованы с текущим pack; риск находится не в известном mismatch, а в малом покрытии corpus и необходимости сохранять integrity gate при расширении.

## Intent Parser, Adjudicator и Narrator

- Rule-based parser распознаёт ограниченный набор русских/английских формулировок и типов намерений.
- Target lookup зависит от доступных actor names и текущей projection.
- Некоторые DC, weapon и action defaults остаются упрощёнными.
- Unknown action может стать ruling draft, но полноценного owner approval/versioning workflow нет.
- Versioned role prompts и Verifier подключены, однако legacy mode по-прежнему совмещает больше решений в старом handler.
- Deterministic narration позволяет `enforce` работать без RouterAI key, но не заменяет тестирование реального provider response и отказов.

## Режимы и compatibility layer

### Legacy

Legacy handler остаётся доступным через Game Orchestrator. Browser `src/useGameSession.ts`, localStorage и broad room state остаются частью пользовательского flow. Локальный fallback в `src/game-engine.ts` может создавать последствия вне полного доменного event vocabulary.

### Shadow

Legacy result остаётся авторитетным, а новый engine строит сравнение. Для одного намерения legacy и new path могут независимо выполнить бросок; расхождение RNG тогда выглядит как engine divergence. Целевая модель должна переиспользовать один подтверждённый roll.

### Enforce

FileEventStore commit авторитетен для нового контура, после чего HP/enemies/mechanics/inventory/currency/merchants/movement/tactical turn/battle log/map feedback/economy log, scene/adventure/suggestions и выборочные rulings проецируются в legacy room. Event commit и room projection не являются одной транзакцией. При conflict/error после commit HTTP-результат и compatibility room могут временно расходиться; автоматический reconciliation worker отсутствует.

## Client state и legacy writes

`/api/narrate` загружает trusted room state на сервере, игнорирует поддельный state и отбрасывает клиентские `commands`/Director capability. `/commands` принимает typed allowlisted commands и проверяет actor ownership/version; `AdvanceScene` через generic endpoint запрещён. В player combat path сервер самостоятельно выводит participants, attack profile, AC, damage, advantage/disadvantage и range, а также валидирует turn/path/walls/occupancy/speed/action economy. При этом resolved party vote до авторитетного перехода всё ещё читается из compatibility room.

Compatibility room `PUT` всё ещё принимает broad proposed state. Для non-admin в `enforce` сервер восстанавливает из event store mechanics/enemies, механические поля players, tactical turn, battle log/map feedback, ruleset lock и клетки карты, оставляя игроку только presentation allowlist листа. Это защищает реализованную боевую механику, но не делает endpoint command-only: broad narrative fields и более широкие admin writes могут расходиться с event model.

Browser fallback в `legacy/shadow` использует `Math.random`; такой бросок не является server-authoritative и должен оставаться только compatibility fallback. Этот путь не удалён внедрением `enforce` combat slice.

## Rolls

- `/api/roll` и room dice path используют Dice Service; выданные броски регистрируются в Roll Registry.
- Registry живёт только в памяти процесса, теряется при рестарте и не координируется между Node instances.
- Roll consume не объединён атомарно с event commit и trace write.
- Idempotency event command durable, но не охватывает весь жизненный цикл выданного roll token.
- Shadow path может выполнить независимый второй бросок, как описано выше.

## Persistence, migration и масштабирование

- FileEventStore активен для новых кампаний и `enforce` path: immutable commits, snapshots/checksums, stream versions, replay и durable idempotency.
- Legacy room JSON остаётся compatibility projection; auth и rooms используют синхронный file I/O.
- Создание кампании импортирует начальный snapshot, а orchestrator может лениво импортировать существующую комнату при входе в `shadow`/`enforce`.
- Metadata migrator создаёт точную per-room `.bak`, поддерживает dry-run и ставит `legacy_import_required`, но не является единым end-to-end cutover tool и автоматически не согласует этот flag после lazy import.
- Нет общей транзакции между event stream, legacy room, roll consume и turn trace.
- File locking рассчитан на single-process use; OneDrive sync может создавать внешние конфликты.
- Нет PostgreSQL adapter, multi-process coordination, scheduled backup/retention и production restore verification.

## Security

- Self-registration остаётся открытой при публикации tunnel.
- Доступ к комнате теперь проверяется по admin/hero assignment; это лучше знания room code, но не explicit membership/role model.
- Broad compatibility PUT остаётся доверительной поверхностью, хотя его ACL и validation усилены.
- Security headers, включая CSP, активны; Origin check допускает same-host/localhost, но запрос без `Origin` также разрешён.
- CSRF token или double-submit mechanism отсутствует.
- Narration/image generation имеют in-memory per-user limits, но они сбрасываются после restart, не работают между процессами и не учитывают token/cost budget.
- Auth rate limit in-memory и основан на socket IP; proxy может объединить нескольких пользователей.
- Generated items требуют аутентификации.
- NarrationBrief, visibility projection, Verifier и trace redaction активны.
- Explanation route проверяет доступ к кампании, но не применяет event-level visibility projection к возвращаемому trace.
- `x-forwarded-proto`/trusted proxy configuration требует отдельной production проверки.

Подробнее — `security-model.md`.

## Deployment

- Compose может публиковать порт 8787 на всех host interfaces; безопасная binding policy зависит от deployment.
- Tunnel URL и доступность зависят от внешнего сервиса.
- Docker daemon, public tunnel path и real HTTPS/proxy headers не покрыты end-to-end test.
- Base images не закреплены digest-ами; dependency specs используют `latest` при наличии lockfile.
- Frontend запрашивает Google Fonts, тогда как активная CSP может блокировать внешний stylesheet/fonts. Offline и deployed presentation могут отличаться.

## Тестирование

Актуальный suite включает unit tests доменных компонентов. Отдельный domain integration test проходит Orchestrator→Rules Engine→FileEventStore→reopen/replay для исследования, social ruling, check/save, spell/resource/concentration, боя, лечения, condition, явного `EndCombat`, rest и `/why`.

Real-HTTP integration scenarios поднимают `server/index.mjs` во временном storage и проверяют:

- создание shadow-кампании и admin switch в `enforce`;
- strict rules search;
- `enforce` damage command и отсутствие повторного применения по idempotency key;
- turn explanation;
- `/api/narrate /why`, использующий server state вместо forged client state;
- JSON 404 для неизвестного API;
- боевые команды обычного игрока, ownership/allowlist и запрет прямого `ApplyDamage`;
- игнорирование поддельных attack modifier/AC/damage/advantage fields;
- path/walls/occupancy/speed/action economy и очередь хода;
- bounded NPC turn, persistent `battleLog`/`mapFeedback`, idempotent retry и идентичный replay после HTTP restart;
- Director → `SceneAdvanced` → optional `MerchantCreated`: атомарный городской переход, отсутствие стационарной лавки в wilderness, forged system command, semantic idempotency conflict, room projection и replay после HTTP restart;
- merchant lifecycle/ShopAssembler, bargain/appraise/buy/sell, forged price/appraisal policy, ограниченную кассу, stale quote, appraisal registry и persistent `economyLog`.

Этот тест узкий. Не доказаны:

- полная UI/browser regression;
- real RouterAI behavior и provider failures;
- Docker/Pinggy/HTTPS end-to-end;
- production migration, rollback и restore существующего storage;
- crash между commit/projection, multi-process concurrency и load;
- содержательный shadow comparison с единым roll;
- reconciliation после сбоя между event commit и room projection;
- security penetration testing и обход quotas/visibility.

Не проверены расширенный encounter corpus с полными stat blocks и loot, диагонали/difficult terrain/cover/LOS, spells/conditions/death saves, Tactical Controller agent, автоматическая Director integration и синхронный бой нескольких браузеров. Поэтому `enforce` пригоден для ограниченного контролируемого сценария, но не должен считаться завершённым production cutover или полной заменой D&D-стола.

## Provenance и assets

Происхождение и условия распространения трёх PNG assets в `public/assets` не зафиксированы в доступных metadata. До публичной дистрибуции их следует документировать либо заменить ассетами с подтверждёнными правами. Подробности — `ATTRIBUTION.md` и `THIRD_PARTY_NOTICES.md`.
