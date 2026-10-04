# Четвёртый проход: очередь комнат и зависание `GameSession` после неполного ответа

**Срез:** `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` (4 октября 2026). Проверены
`src/useGameSession.ts`, его реальные точки вызова из `src/App.tsx` и
`src/AppViews.tsx`, а также исполняемый probe
[`23-queued-room-state-probe.mjs`](./23-queued-room-state-probe.mjs).
Runtime-код, storage, `.env` и зависимости не менялись.

Цель прохода — заменить reduced-модель из round 3 на исполнение тела production
hook. Probe транспилирует сам `useGameSession.ts` локальным TypeScript, вызывает
его `submitAction`, `switchCampaign`, SSE callback и effect очистки очереди.
React scheduler, DOM, сетевые и вспомогательные зависимости в probe заменены
контролируемым harness. Сам probe подтверждает исполнение callback-ов hook.
Для REC-04 дополнительно выполнен [сценарий настоящего браузера](24-browser-queue.md):
обычный выбор B оставил в URL B, а на экране показал сцену и журнал A.

## Результат

| ID | Приоритет | Статус после прохода | Подтверждённое последствие |
| --- | --- | --- | --- |
| **REC-04** | P2 | **подтверждено callback-пробой и браузером** | После переключения A → B queued-снимок A может вернуть экран к A; URL уже остаётся B |
| **REC-03/malformed-200** | P2 | **подтверждено исполнением production hook** | Успешно возвращённый неполный результат `{}` бросает `TypeError`, оставляет `isNarrating` и `busy.current` активными; новые действия блокируются |

Это не исправление поведения. Результаты добавлены как доказательная часть PR;
изменять runtime следует отдельным согласованным изменением с тестом на
идемпотентность/replay и ручным браузерным сценарием.

## REC-04 — stale queued room после A → B

### Исполняемый сценарий

Probe делает следующий порядок, используя реальные тела callback-ов hook:

1. `submitAction('Открыть дверь')` ставит `busy.current = true`, коммитит
   оптимистичное состояние A с `isNarrating: true` и ждёт отложенный ответ
   `narrateWithAgent` ([`useGameSession.ts#L845-L880`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L845-L880)).
2. SSE-картина A с версией 7 попадает в `receive`; из-за `busy.current` она
   действительно добавляется в `queuedRooms` ([`useGameSession.ts#L633-L646`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L633-L646)).
3. `switchCampaign('B')` увеличивает `actionEpoch`, снимает `busy.current`, но
   очередь не очищает ([`useGameSession.ts#L1984-L2000`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1984-L2000)). Затем probe отдаёт ему реальный ответ комнаты B, версии 1, через
   `fetchWithTimeout` ([`useGameSession.ts#L2009-L2018`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L2009-L2018)).
4. После `applyRemote(B)` меняется `state.isNarrating` с оптимистичного `true`
   на серверное `false`. В production это запускает effect с зависимостями
   `state.isNarrating` и `flushQueuedRooms`; probe вызывает тело именно этого
   effect ([`useGameSession.ts#L758-L760`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L758-L760)).
5. Реальный `flushQueuedRooms` видит `busy.current = false`, `roomVersion = 1`
   и queued A с версией 7. Он выбирает A только по номеру версии и передаёт его
   в `applyRoomSnapshot`; ни очередь, ни `applyRoomSnapshot` не проверяют
   `state.sessionCode` ([`useGameSession.ts#L528-L537`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L528-L537),
   [`useGameSession.ts#L579-L596`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L579-L596)).

Фактический вывод probe:

```json
{
  "before_flush": "B",
  "after_flush": "A",
  "queued_version": 7,
  "current_room_version": 1,
  "persisted_campaign": "A",
  "url_campaign": "B"
}
```

Граница исполнения здесь существенна: probe не копирует reduce-модель, а
вызывает production `submitAction`, production `switchCampaign`, production
SSE `receive`, production `queueRoomSnapshot`, production `applyRemote` и
production flush effect. Harness вручную запускает effect после применения B;
он также заменяет hooks, EventSource, storage, транспорт и вспомогательные
модули. Перерендера React в нём нет. Поэтому это проверка выбранного порядка
callback-ов, а не полная интеграционная проверка React. Отдельный браузерный
сценарий подтверждает, что этот порядок достижим через штатный UI.

### Почему `actionEpoch` не закрывает этот случай

Ответ старого `submitAction` после переключения действительно увидит новый
`actionEpoch` и выйдет с «Действие было отменено» ([`useGameSession.ts#L885-L887`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L885-L887)). Это защищает только продолжение старого async action. Очередь комнат использует
отдельный `queuedRooms` ref и не сверяет epoch/campaign, поэтому stale snapshot
применяется уже после безопасного выхода старого action.

### Реальный production caller

Переключение комнаты из `CampaignModal` вызывает `onSwitch(campaign.code)` без
prefetched state ([`src/AppViews.tsx#L202-L206`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/AppViews.tsx#L202-L206)). Поэтому сценарий не зависит от недоступного тесту внутреннего вызова: достаточно выбрать другую кампанию, пока обычный свободный action ждёт ответ. Контроль кампании и импорт карты также используют ту же функцию с уже загруженным state ([`src/App.tsx#L1062-L1070`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/App.tsx#L1062-L1070), [`src/App.tsx#L1902-L1908`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/App.tsx#L1902-L1908)).

### Минимальное исправление для отдельного PR

Нужно связать queued entry с кампанией и не позволять старой очереди пересекать
границу комнаты:

1. Добавить в entry `campaignId` в момент приёма SSE/poll snapshot.
2. В начале `switchCampaign` очистить очередь старой кампании либо хранить
   очереди в `Map<campaignId, ...>`; для одного активного hook достаточно
   очистки.
3. В `flushQueuedRooms` и `applyRoomSnapshot` проверять соответствие entry/state
   текущему `stateRef.current.sessionCode` до сравнения `roomVersion`.
4. Проверить тем же тестом рассинхрон URL/cache: `switchCampaign` уже меняет URL,
   а `applyRemote(A)` вновь сохраняет A в `localStorage` через `persistLocal`.

Версии разных кампаний принадлежат разным журналам. Численное сравнение B=1 и
A=7 не определяет, какой снимок допустимо показать после выбора B.

## REC-03 — неполный результат narrate оставляет hook заблокированным

Второй сценарий того же probe подменяет `narrateWithAgent` на
`Promise.resolve({})`. HTTP в нём не поднимается: проверяется уже возвращённое
клиентским модулем значение. Отдельная [проверка transport decoder](../round-3/16-client-recovery.md)
в предыдущем проходе установила, что неполный HTTP 200 принимается decoder-ом;
эти две проверки не являются единым end-to-end сценарием. `submitAction` после
сетевого `try/catch` вызывает `finishTurn`. Там production
код читает `aiResult.effects.roll` и `aiResult.narration.trim()` без runtime
проверки ([`useGameSession.ts#L815-L842`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L815-L842)). Исключение происходит уже после `await`, вне блока, который превращает сетевую ошибку в обычный результат ([`useGameSession.ts#L866-L884`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L866-L884)).

Фактический вывод:

```json
{
  "first_rejection": "Cannot read properties of undefined (reading 'roll')",
  "is_narrating_after_rejection": true,
  "second_submit": {
    "ok": false,
    "error": "Сейчас нельзя отправить это действие."
  }
}
```

Второй вызов проходит через реальный `submitAction` и останавливается на
`busy.current`, а state остаётся с `isNarrating: true`. Подтверждена блокировка
следующего действия в том же экземпляре hook; перезагрузка браузера для этого
сценария не проверялась. Нужны runtime-проверка ответа до `finishTurn` и
гарантированное снятие блокировки при исключении после ответа. Это не доказывает,
что штатный сервер сам выдаёт `{}`: ответ намеренно повреждён harness-ом.

## Проверки и ограничения

- `node docs/reviews/2026-10-04/round-4/23-queued-room-state-probe.mjs` — **PASS**:
  оба сценария исполнили production hook callbacks; `queued A` применился после
  загрузки B, неполный результат narrate оставил блокировку.
- `node --check docs/reviews/2026-10-04/round-4/23-queued-room-state-probe.mjs` — **PASS**.
- `git diff --check` — **PASS** по добавленным файлам; Git показал только
  существующее предупреждение о преобразовании CRLF в изменённом файле другого
  прохода.
- В probe нет настоящего DOM, React scheduler и браузерного EventSource. Это
  ограничивает claims о timing конкретного браузера, но не меняет факт, что
  production callback/guard сам принимает stale state при указанном порядке.
- Runtime-код не изменён. Итог общего `pnpm verify` указан в
  [сводке четвёртого прохода](README.md).
