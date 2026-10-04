# Швы расширения: три вертикальные механики и два минимальных интерфейса

Аудит выполнен на срезе `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` с
учётом ветки PR, где уже лежит второй проход. Runtime не менялся. Цель этого
прохода — найти повторяемый шов, который действительно облегчает добавление
новой механики, а не ещё раз предложить механическое деление
`rules-engine.mjs`.

## Три реальные вертикали

### Письмо курьером

Команда начинается в [`server/index.mjs:1765-1799`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L1765-L1799): санитайзер разрешает только
адрес, тело, героя и ожидаемую версию состояния. `reply_draft` намеренно не
принимается из браузера. В HTTP-маршруте она выбирается в
[`server/index.mjs:4956-5019`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L4956-L5019); письмо обязано быть единственной атомарной
командой, после серверной проверки повтор не вызывает модель.

Канонизация продолжает путь в [`server/rules-engine.mjs:4388-4407`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L4388-L4407):
удаляются camelCase-алиасы, текст нормализуется, а политика получает
`house_rule_id`. Правило допуска находится отдельно в
[`server/rules-engine.mjs:5537-5562`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L5537-L5562) и вызывается и из HTTP-предварительной
проверки, и из движка (`:6000-6003`). Исполнение — ветка `SendLetter` в
[`server/rules-engine.mjs:20041-20080`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L20041-L20080): `planCourierLetter` создаёт полный
снимок письма, событие списывает кошелёк и добавляет мировые минуты.

Состояние и replay принадлежат домену почты: `normalizeCourierLetterState` и
`applyCourierLetterEvent` находятся в [`server/courier-letters.mjs:280-339`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/courier-letters.mjs#L280-L339).
Общий редьюсер лишь подключает их в
[`server/rules-engine.mjs:24739-24743`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L24739-L24743). Проекция состояния регистрирует ключ
`courier_letters` в [`server/viewer-projection.mjs:1484-1489`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/viewer-projection.mjs#L1484-L1489) и собирает
публичную форму в `:1988-1991`; канал событий повторно использует
`courierLetterForViewer` в `:2187-2211`. На клиенте команда сведена к одному
callback в [`src/useGameSession.ts:1811-1816`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1811-L1816), а форма и ограничения живут в
[`src/DungeonMap.tsx:3284-3358`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/DungeonMap.tsx#L3284-L3358). Контракт покрывают
[`test/courier-letters.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/courier-letters.test.mjs) и [`test/courier-letters-ui-contract.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/courier-letters-ui-contract.test.mjs).

### Пленные

У пленных пять пользовательских команд и одна серверная (`NeglectCaptive`),
что видно в [`server/captives.mjs:68-75`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/captives.mjs#L68-L75). Входная граница повторяет форму
письма, но добавляет `skill`: [`server/index.mjs:1511-1541`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L1511-L1541); выбор санитайзера и
запрет смешивания с другими командами — `:4962` и `:5071-5075`. Движок
канонизирует `captive_id` и навык в [`server/rules-engine.mjs:4294-4305`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L4294-L4305), затем
проверяет фазу боя, владение героем, статус пленных и поселение в
`:5709-5738`. `COMMAND_RULES` и общий allowlist тоже знают эту семью
([`server/rules-engine.mjs:743-750`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L743-L750), `:824-831`).

В `resolveCommand` пять действий образуют не одну запись, а разные пакеты
событий: допрос с серверным броском и адресной записью знания
[`server/rules-engine.mjs:18992-19041`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L18992-L19041), отпускание и передача страже
`:19043-19145`, кормление, голод и казнь `:19147-19209`. Поэтому попытка
свести их к таблице только по имени уже потеряла бы порядок событий,
видимость и связь казни с общей механикой урона.

Реестр нормализуется и применяется внутри [`server/captives.mjs:653-755`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/captives.mjs#L653-L755);
общий reducer отдельно обрабатывает боевой переход `CaptiveTaken` и кошелёк
передачи ([`server/rules-engine.mjs:23787-23824`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L23787-L23824)), после чего вызывает
`applyCaptiveEvent` (`:24743`). Состояние и событие используют один белый
список `captiveForViewer`: [`server/viewer-projection.mjs:2296-2308`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/viewer-projection.mjs#L2296-L2308), а ключ
реестра — `:1490-1493` и `:1961`. Клиентский маршрут разделён на пять
явных команд в [`src/useGameSession.ts:1828-1851`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1828-L1851); две панели действий
находятся в [`src/DungeonMap.tsx:3001-3010`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/DungeonMap.tsx#L3001-L3010) и `:3359-3392`. Основные проверки,
replay и приватность находятся в [`test/captives.test.mjs:615-724`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/captives.test.mjs#L615-L724).

### Таверна

Таверна занимает четыре команды ([`server/tavern-life.mjs:127-158`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/tavern-life.mjs#L127-L158)), но имеет
особое правило атомарности: в HTTP-маршруте это отдельная проверка
[`server/index.mjs:4967-4990`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L4967-L4990). Санитайзер допускает только героя, соперника,
ставку и подход ([`server/index.mjs:1684-1720`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L1684-L1720)). В Rules Engine эта семья
повторно объявлена в `COMMAND_RULES` ([`server/rules-engine.mjs:778-791`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L778-L791)),
канонизируется в `:4367-4387` и валидируется в `:5848-5960`, где проверяются
сцена, бой, покрытие кассы, открытый раунд и деньги.

Исполнение намеренно не является одной строкой: открытие бросает кость NPC и
переводит ставку в эскроу ([`server/rules-engine.mjs:19612-19678`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L19612-L19678)), ответ
содержит ветки честной игры, жульничества и наблюдения, а уход — отдельную
сдачу. Публичные события должны сохранять порядок кошелька и раунда.
`normalizeTavernState`, `tavernForViewer` и `applyTavernEvent` живут в
[`server/tavern-life.mjs:489-930`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/tavern-life.mjs#L489-L930); общий reducer подключает их в
[`server/rules-engine.mjs:23921-23943`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L23921-L23943) и `:24731`. Проекция состояния и
событий использует отдельные ветки [`server/viewer-projection.mjs:1513-1519`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/viewer-projection.mjs#L1513-L1519),
`:1971-1979` и `:2152-2177`. Callback-и клиента собраны в
[`src/useGameSession.ts:1771-1805`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1771-L1805), а полноценная панель — в
[`src/DungeonMap.tsx:3146-3283`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/DungeonMap.tsx#L3146-L3283). [`test/tavern-life.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/tavern-life.test.mjs) проверяет не
только успех, но и эскроу, тупики, приватность и replay; UI-контракт —
[`test/tavern-ui-contract.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/tavern-ui-contract.test.mjs).

## Повторяемый кластер

У трёх вертикалей уже есть хорошие владельцы состояния. Узкое место — путь
команды вокруг них. Для каждой семьи фактически приходится поддерживать:

| Шаг | Повтор в коде |
|---|---|
| Вход игрока | отдельный `sanitizePlayer...Command` в `index.mjs`; общий dispatch `:4956-4980` |
| Канонизация | отдельная ветка `normalizeCommand` для captives/tavern/courier |
| Авторитетность | `COMMAND_RULES`, `ALLOWED_COMMAND_TYPES`, семейная ветка `validateCommand` |
| Исполнение | отдельные `case` в одном `resolveCommand`, часто с несколькими событиями |
| Replay | доменный `apply...Event` плюс специальные кошелёк/бой ветки общего reducer |
| Выдача наружу | ключ в whitelist, карточка состояния и ручная очистка event payload |
| UI | callback в `useGameSession`, prop в `DungeonMap`, доменная панель и контрактный тест |

Это не означает, что все семь шагов надо объединить. Две самые похожие
санитайзеры (`captives` и `tavern`) повторяют проверку неизвестных полей,
героя и `expected_state_version`; почта добавляет адрес и текст, но сохраняет
тот же каркас. Напротив, `resolveCommand` у таверны и пленного содержит
разный порядок и перекрёстные эффекты. Автоматическое превращение всех
`case` в таблицу было бы мелким интерфейсом с большой скрытой зависимостью.

## Вариант A: family-adapter полного жизненного цикла

Ввести статический внутренний реестр семей, без plugins и динамической загрузки:

```text
Family {
  commandTypes,
  normalize(command, state),
  validate(command, state, context),
  resolve(command, state, context),
  applyEvent(input, event, state),
}
```

Rules Engine сначала находит семью по `command_type`, затем вызывает её
методы; общий reducer оставляет порядок доменных применений и retention.
`captives.mjs`, `tavern-life.mjs` и `courier-letters.mjs` уже имеют два
элемента такого интерфейса — `commandTypes` и `applyEvent`, поэтому первый
пилот может не переносить механику, а только добавить адаптеры для нормализации
и проверки.

Плюс — максимальная локальность: новая семейная ветка со временем живёт возле
своей политики, а движок знает один вызов. Минус — `resolve` потребует
передавать dice service, `eventFrom`, проектор промежуточного состояния,
экономику, мировые часы и фабрики общих событий. Если передать их десятком
полей, интерфейс станет мелким фасадом над Rules Engine; если спрятать
замыканиями, replay и тесты начнут зависеть от порядка импорта. У пленного
казнь всё равно должна вызвать общую механику `npcHarmEventDrafts`, а у
таверны — общий `applyGameEvent` между бросками. Значит, этот вариант глубок
только после явного порта для небольшого семейства; сейчас он дорог и рискован.

## Вариант B: таблица политики входной команды

Сделать узкий seam только на границе игрока. Общий helper в текущем владельце
HTTP-команд принимает статическую политику:

```text
InputPolicy {
  types: COURIER_LETTER_COMMAND_TYPES,
  allowedFields: [...],
  unknownFieldCode: 'COURIER_COMMAND_UNKNOWN_FIELD',
  parse(input, type),
  atomic: true,
}
```

Helper выполняет одинаковые проверки белого списка, владения героем,
`expected_state_version` и `server_authoritative`; `parse` остаётся маленьким
доменным адаптером для `body`, `skill`, ставки или адреса. Статическая таблица
заменяет три копии маршрутизации и сохраняет `assertSendLetterAllowed`,
`validateCommand`, `resolveCommand`, event projection и UI без изменений.
Существующие `CAPTIVE_*`, `TAVERN_*`, `COURIER_*` sets остаются источником
истины; второй список имён не создаётся. Специальные действия (черновик
ответа модели, `NeglectCaptive`, эскроу) остаются явными в своих владельцах.

Это меньший, но более глубокий интерфейс: caller сообщает семейную политику,
а общий helper прячет повторяющуюся безопасность. Цена — центральный
`rules-engine.mjs` всё ещё будет знать о механике, а таблица не уменьшит
размер `resolveCommand`. Зато seam проверяется двумя настоящими адаптерами
(`Courier`, `Tavern`), а не гипотетическим plugin-контрактом; `Captive` можно
подключить после того, как особый `skill` и серверный `NeglectCaptive` будут
покрыты тем же тестом.

## Решение и критерии пилота

Рекомендую начать с варианта B на `SendLetter` и четырёх команд таверны.
Это повторяет уже существующего владельца и сокращает интерфейс входа, не
трогая доказанную семантику событий. Вариант A оставить только как следующий
эксперимент для `Courier`, если после двух адаптеров станет виден стабильный
контракт `validate/resolve`, а не просто желание уменьшить файл.

Пилот считается допустимым, если:

1. Канонические команды и все отрицательные коды до/после совпадают побайтно;
   неизвестное поле, чужой герой, пустое письмо и неподходящая ставка по-прежнему
   отклоняются до первого события.
2. `resolveCommand` выдаёт тот же порядок, payload, `policy_id`, visibility и
   `event_schema_version`; `replayEvents` даёт идентичные `courier_letters`,
   `tavern` и кошельки.
3. Повтор с тем же idempotency key не запускает модель и не создаёт новый
   commit. Для этого нужны существующие проверки
   [`test/courier-letters-ui-contract.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/courier-letters-ui-contract.test.mjs), [`test/tavern-life.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/tavern-life.test.mjs),
   [`test/security.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/security.test.mjs) и [`test/player-request-router.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/test/player-request-router.test.mjs) плюс один
   тест на соответствие descriptor→sanitizer.
4. `PROJECTED_STATE_KEYS` и event redaction остаются явными: новый ключ нельзя
   автоматически публиковать только потому, что он зарегистрирован в политике.
   UI проверяется теми же HTTP-контрактами; общий компонент панели не вводится.

До этих условий не следует обобщать редьюсер, проектор или весь UI в
«движок фич». Один статический seam для повторяющегося входного каркаса даёт
локальность и обратимость; остальная вертикаль пока получает больше пользы
от явных доменных владельцев.
