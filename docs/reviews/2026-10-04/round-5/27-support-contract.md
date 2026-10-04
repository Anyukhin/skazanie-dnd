# Статус механики и фактическое разрешение команды

Срез выполнен по полному baseline SHA `88c620e6011ae607913efb224cb8f850b4ee5028`.
Проверен узкий контракт каталожного статуса: источник override → карточка,
которую получает клиент → авторитетная команда → события и расход ресурса.
439 карточек целиком не переаудировались. Ниже только трассы, для которых
поведение подтверждено исходным кодом и коротким воспроизводимым прогоном.

## Что считается guard

`server/combat-spells.mjs` выставляет `mechanicsSupport` из override, а при
наличии override без явного значения считает карточку `partial`
([строки 38–50](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/combat-spells.mjs#L38-L50)).
В Rules Engine `verified` и `partial` разрешаются, а `heuristic` и
`ruling-only` отклоняются до исполнения с разными кодами
([`assertMechanicsSupported`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L929-L940)).
Обычный public `CastSpell` проходит через player sanitizer: сервер сам добавляет
`server_authoritative: true` и принимает из тела только разрешённые поля
([базовая команда](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L656-L667),
[ветка CastSpell](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L1210-L1310)).
Поэтому попытка подменить статус или добавить `server_authoritative: false` в
public JSON не является обходом: до Rules Engine доходит серверная команда.
Это статическая трассировка исходников, а не отдельный HTTP-прогон в этой роли.

UI также не считает `heuristic` и `ruling-only` исполнимыми: presentation
помечает их `blocked: true`, тогда как `partial` остаётся доступным
([таблица presentation](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/tactical-ui.ts#L541-L580)).
В боевой колоде это отражено в `disabled` и в badge статуса
([spell tile](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L2632-L2676)).
Это рабочая граница безопасности. Она не означает, что `partial` совпадает с
полным текстом карточки.

## Подтверждённые сужения

### `infestation`: partial оставляет inert marker в SRD-профиле

В override основной профиль объявляет `conditions: ["forced-random-move-5"]`
и пишет в описании случайное перемещение, но поле `randomMoveFeet: 5` находится
только внутри `mechanics2014`
([override](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/data/dndsu-spell-mechanics-overrides.json#L301-L317)).
Для обычного `srd_5_2_1` `spellForRuleset` убирает блок `mechanics2014`, после
чего handler `save` всё равно добавляет условие, а ветка случайного шага
срабатывает только при наличии `spell.randomMoveFeet`
([развилка редакции](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/combat-spells.mjs#L47-L58),
[создание rider-а](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L16398-L16430)).

Прогон в `srd_5_2_1` получил `partial`, `SpellCast`, урон и
`ConditionAdded(forced-random-move-5)`, но не получил ни `DieRolled` с purpose
`spell_random_move:infestation`, ни `ActorMoved`; позиция цели не изменилась.
По исходному UI здесь виден только общий badge `ЧАСТИЧНО` и сгенерированная
общая фраза про формализованную часть: отдельное отсутствие случайного шага в
боевой плитке не показано. Это не обход guard и не потеря ресурса — это
неполный effect-marker, который выглядит как событие эффекта, хотя сам по себе
ничего не делает.

Положительный контроль уже есть в существующем тесте 2014: для того же ID он
ожидает `DieRolled(spell_random_move:infestation)` и `ActorMoved`
([тест](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/test/spell-forced-movement-and-typed-riders.test.mjs#L58-L67)).
Значит, наблюдение относится к расхождению профилей редакций, а не к общему
отсутствию handler-а.

Вариант расширения с минимальным объёмом: сначала согласовать уже имеющийся
`supportNote` и override по `rulesetId` — в SRD либо убрать condition-marker,
либо явно написать «урон есть, случайного перемещения нет», а в 2014 оставить
`randomMoveFeet`. Только если такие расхождения повторятся у нескольких
семейств, имеет смысл обобщить их descriptor-ом; вводить новый descriptor
сейчас рано.

### `green-flame-blade`: partial не даёт выбрать вторую цель

Override говорит о втором противнике рядом с выбранной целью, но не объявляет
отдельный `target_ids`/selection contract
([override](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/data/dndsu-spell-mechanics-overrides.json#L262-L279)).
По исходному UI выбирается только primary enemy; отдельного поля для второго
врага в этом tile нет. После попадания Rules Engine
фильтрует живых соседних врагов и сортирует их по `actorId`, затем наносит rider
первому кандидату
([`secondTarget`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L15873-L15892)).

В probe primary `enemy-2` стоял рядом с двумя допустимыми врагами. Ответ
содержал вторичный fire `DamageApplied` по `enemy`, выбранному серверной
сортировкой, а не отдельным выбором игрока. Status оставался `partial`, а
`supportNote` был общей фразой без этого ограничения. Сейчас это безопасное
серверное сужение: клиент не может подменить вторую цель, но игрок не может
выбрать другого допустимого врага.

Вариант расширения: вынести «вторичные цели» в общий контракт
`primary_target + secondary_target_ids`, с серверной проверкой расстояния,
visibility и faction. Пока контракт не добавлен, карточке нужен точный
`supportNote` и UI-подпись «второй противник выбирается сервером».

### `witch-bolt`: ресурс расходуется, повторного действия нет

У override есть явное и честное замечание: исполняются первичное попадание и
урон, но луч не получает повторное действие
([override](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/data/dndsu-spell-mechanics-overrides.json#L2686-L2702)).
В авторитетном CastSpell Rules Engine сначала выбирает ячейку и затем создаёт
`ResourceSpent`, а handler атаки сохраняет концентрацию и первичный урон
([проверка и выбор ячейки](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L6640-L6670),
[оплата перед SpellCast](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L15290-L15315)).
Probe подтвердил один расход `spell_slots_1`, `SpellCast`, концентрацию и
первичную атаку; после применения событий через reducer в `combatActions`
не появилось отдельного действия `witch-bolt`. Файловый commit и HTTP этот
probe не выполняет; ограничение повторного луча дополнительно закреплено
в самом `supportNote`.

Это не скрытый дефект статуса: подробности заклинания уже прямо сообщают о
неподдержанном повторе, поэтому `partial` здесь используется честно. Но
по исходному UI боевой tile показывает только общий badge и полное описание, а конкретное
ограничение видно лишь в detail-панели. Для ресурсов это важная граница
продуктового контракта: игрок может потратить ячейку, ожидая повторного луча,
если ориентируется на плитку и не открывает детали.

Параметры оформлены как `<details>` без `open`, а пояснение статуса находится
в `title` значка внутри этой панели
([`DungeonMap.tsx#L3773-L3781`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L3773-L3781)).
Это статическая трасса расположения заметки; браузерный сценарий расхода ячейки
в этом проходе не выполнялся.

Вариант расширения: сделать `supportNote` обязательным для `partial` при
наличии `resource` или `concentration`, а в tile tooltip/aria-label показывать
эту заметку перед подтверждением. После появления continuation action статус
можно поднять только отдельным evidence-пакетом: повторный action, дальность,
концентрация, выход цели и replay.

## Что не является обходом

`mage-hand` в probe получает `MECHANICS_NOT_VERIFIED`, `feather-fall` получает
`RULING_REQUIRED`: resolver отвергает команды до выдачи набора событий. Это
проверка Rules Engine. Public sanitizer прослежен отдельно по исходникам;
сквозная HTTP-попытка обхода клиентскими полями в этом probe не выполнялась.

## Минимальный следующий шаг

Для расширения общего контракта сначала достаточно согласовать существующий
`supportNote` с ruleset-specific override и выводить его в tile/detail там, где
partial расходует ресурс. Если такие расхождения повторятся у нескольких
семейств, следующим шагом можно ввести server-owned descriptor эффекта с
полями `support`, `unsupported_effects`, `target_contract` и `resource_policy`,
из которого строятся `assertMechanicsSupported`, tile/detail и acceptance
receipt. Пробный descriptor сейчас не нужен; архивное воспроизведение лежит в
[`27-support-contract-probe.mjs`](./27-support-contract-probe.mjs).

Проверка отчёта:

```text
node docs/reviews/2026-10-04/round-5/27-support-contract-probe.mjs
```

Probe не запускает HTTP, не пишет storage/data и не изменяет runtime. Его
synthetic fixtures доказывают маршрутизацию Rules Engine и события, но не
заменяют полную UI/browser-приёмку.
