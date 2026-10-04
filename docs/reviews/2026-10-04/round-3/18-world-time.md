# Третий проход: мировое время и составные последствия

Срез исходников: `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` (4 октября 2026).
Проверялись `appendWorldTimeConsequences` и его владельцы: обещания NPC,
восстановление стабилизированных и нокаутнутых, рассветная перезарядка,
погода, «пока вас не было», курьерская почта и пленные. Runtime не менялся.
Ниже только синтетические состояния; рабочее `storage/`, секреты и внешний
провайдер не использовались.

## Граница проверки

У движка есть два намеренно разных слоя. Низкоуровневый
[`appendTimeAdvance`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L11823-L11854)
пишет `TimeAdvanced`, истечение призыва, смену неба и рассветную
перезарядку. [`appendWorldTimeConsequences`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L11856-L11975)
добавляет поверх него концентрацию, сроки обещаний, death-save recovery,
нокаут-отдых, ход мира и почту.

`sourceState` действительно используется намеренно: все встроенные в эту
обёртку минутные потребители видят состояние перед одним скачком, а `afterTime`
используется только там, где `TimeAdvanced` должен сначала убрать абсолютные
сроки. Это не проверка
ложного закона `AdvanceTime(a+b) == AdvanceTime(a), затем AdvanceTime(b)`.
Ход мира ограничен одним семплом за сутки, погода пишет только смену, а
рассветная перезарядка фиксирует случайные броски в aggregate event. Эти
границы сохранены в выводах.

## WT-01 — long cast обходит часть минутных потребителей

**Тип:** подтверждённый разрыв общего владельца последствий. **Приоритет:**
P1 для согласованности механики. **Уверенность:** высокая.

В ветке длительного накладывания (`long_cast`) движок вызывает низкоуровневый
`appendTimeAdvance` напрямую
([`rules-engine.mjs:15226-15239`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/rules-engine.mjs#L15226-L15239)).
Обычный `AdvanceTime`, отдых, перемещение и другие пути вызывают обёртку,
которая после того же `TimeAdvanced` планирует обещания, восстановление,
нокаут, ход мира и почту. Поэтому десять минут long cast — это другой вид
игрового времени, хотя событие часов у него есть.

Проба с `Prayer of Healing`, открытым обещанием со сроком на пятой минуте и
пустым внешним provider дала:

```text
TimeAdvanced(elapsed_minutes=10), ResourceSpent, SpellCast, DieRolled, HealingApplied
NpcPromiseResolved: отсутствует
итоговое время: 10 минут
итог обещания: open
```

Контроль с тем же исходным состоянием и обычным `AdvanceTime(10 минут)`
создаёт `NpcPromiseResolved` и закрывает обещание. Поэтому отсутствие события
не объясняется неработающей фикстурой deadline.

То же расхождение затрагивает стабильное восстановление героя, завершение
нокаут-отдыха, offscreen step и курьерскую почту. Рассвет и погодные события
при этом проходят, потому что они принадлежат низкому слою. Это особенно
трудно заметить по UI: `TimeAdvanced` выглядит корректно, а пропущенные
последствия появляются только при следующем отдельном скачке или системном
такте.

Отдельная проба показывает тот же осознанный, но пока не закреплённый выбор
для `sourceState`: письмо, доставленное на 480-й минуте большого скачка,
создаёт обещание со сроком 540, но этот новый срок не ломается в том же
скачке, даже когда итоговое время уже 1440. Это может быть допустимой
политикой «новые обязательства начинают проверяться со следующего хода», но
сейчас она нигде не объявлена и отличается от ожидания «все сроки до конца
скачка обработаны».

Минимальный вариант улучшения — направить long cast в
`appendWorldTimeConsequences`, оставив `appendTimeAdvance` внутренним
примитивом для случаев, которым сознательно нужны только секундные/рассветные
эффекты. Добавить focused-тест на long cast с обещанием и один тест на
письмо, чей срок истекает внутри скачка. Отдельный реестр или универсальный
clock framework здесь не нужен: владелец уже существует.

## WT-02 — курьер проверяет расписание в начале скачка, а не в минуте доставки

**Тип:** подтверждённая ошибка временного контекста. **Приоритет:** P2.
**Уверенность:** высокая.

[`courierLetterContext`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/courier-letters.mjs#L450-L477)
кэширует `profileState` с исходными `mechanics`, а
[`deliveryFailureFor`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/courier-letters.mjs#L787-L793)
вызывает `profileAtTime(profile)` без параметра времени. Доставка и ответ
планируются ниже в [`planCourierLetterTicks`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/courier-letters.mjs#L909-L1007),
где уже известны `deliveredAt` и `answeredAt`, но они не передаются в проверку
расписания.

Синтетический NPC был недоступен на минуте 0 и доступен с минуты 480. Письмо
с `delivery_due_minutes=480` при скачке 480 минут получило такой результат:

| Проверка | Наблюдение |
| --- | --- |
| `npcProfileAtWorldTime(profile, 480).available` | `true` |
| планировщик письма | `CourierLetterReturned` |
| `payload.reason` | `gone` |

В обратной конфигурации NPC доступен в начале скачка и уходит до минуты
доставки — письмо ошибочно получает `CourierLetterDelivered`. На ответе
работает та же граница: адресат оценивается по началу скачка, а не по
`answeredAt`.

Исправление узкое: дать контексту функцию
`profileAtTime(profile, atMinutes)` или передавать минуту в
`deliveryFailureFor`; для NPC сохранить проверку `npc_world.vitals` и боя, а
расписание вычислять по `deliveredAt`/`answeredAt`. Это не требует второго
счётчика времени и не меняет правила смерти: состояние NPC всё равно берётся
из авторитетного `sourceState`.

## WT-03 — голод пленного живёт во втором, асинхронном часовом контуре

**Тип:** подтверждённая граница атомарности и расширяемости. **Приоритет:**
P2. **Уверенность:** высокая для текущего разделения путей.

`appendWorldTimeConsequences` не планирует `NeglectCaptive`; в нём нет вызова
[`planCaptiveNeglectCommands`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/captives.mjs#L611-L625).
После сохранения комнаты отдельный callback в [`index.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2462-L2495)
загружает кампанию, строит команды и коммитит их вторым проходом через
[`nudgeWorldClocks`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2509-L2564).

Проба с удерживаемым пленным и `AdvanceTime(1440 минут)` дала:

```text
events первой команды: TimeAdvanced
CaptiveNeglected: отсутствует
neglected_at_minutes после replay первой команды: null
planCaptiveNeglectCommands(after, worldMinute=1440): 1 команда
```

В живом HTTP-сервере второй commit обычно следует после `onRoomSaved`, поэтому
это не утверждение, что событие никогда не появится. Но между двумя commit
существует наблюдаемое состояние, а прямой Rules Engine/replay одной команды
не содержит обещанного суточного последствия. Любой новый потребитель,
добавленный по тому же образцу, получает ещё один внешний scheduler и ещё одну
гонку вокруг `state_version`.

Небольшой общий seam уже есть: сделать в `captives.mjs` узкий
`planCaptiveNeglectDrafts(state, { worldMinute })`, вызываемый из
`appendWorldTimeConsequences`, и писать `CaptiveNeglected` в тот же batch с
ограничением текущих 12 записей. Внешний clock можно оставить только как
идемпотентный catch-up для старых кампаний или убрать после миграции. Если
владелец сознательно оставляет второй commit, это нужно зафиксировать как
eventual consistency и покрыть тестом на промежуточное состояние и retry.
Новый общий framework для часов не нужен.

## Рекомендованный порядок

1. Закрыть обход wrapper у long cast и закрепить контракт всех минутных
   последствий focused-тестом.
2. Передавать в курьер фактическую минуту доставки и ответа; отдельно
   проверить NPC schedule, смерть и offscreen relocation внутри большого
   скачка.
3. Выбрать атомарную или явно eventual семантику `CaptiveNeglected`, после
   чего добавить этот путь в тот же owner seam или документировать второй
   commit.

## Проверка

Bounded probe:

```powershell
node docs/reviews/2026-10-04/round-3/18-world-time-probe.mjs
```

Результат: `round-3 world-time probe: 4 boundary behaviours reproduced`.

Связанный focused-набор прошёл без изменений runtime:

```powershell
pnpm exec node --test test/world-time-seconds.test.mjs test/npc-social.test.mjs test/courier-letters.test.mjs test/offscreen-world.test.mjs test/item-dawn-recharge.test.mjs test/death-saves.test.mjs test/captives.test.mjs
```

Результат: **131 passed, 0 failed, 0 skipped**. Это подтверждает текущие
локальные контракты и не скрывает три воспроизведённые границы выше. Полный
`pnpm verify` намеренно не запускался по инструкции прохода.
