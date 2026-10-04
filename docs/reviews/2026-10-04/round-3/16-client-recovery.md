# Третий проход: восстановление клиента после неизвестного ответа, таймаута и смены комнаты

**Срез:** `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` (4 октября 2026; текущий
`HEAD` содержит поверх него только документацию аудита). Проверен клиентский
контур `src/ai-client.ts`, `src/useGameSession.ts`,
`src/tactical-command-recovery.mjs`, `src/auth-client.ts` и точки вызова из
`App.tsx`/`AppViews.tsx`. Серверные ссылки ниже закреплены на том же SHA.

Цель этого прохода — восстановление именно после неопределённого исхода:
соединение оборвалось после записи, запрос завис, ответ имеет неизвестную форму,
вкладка перезагрузилась, пользователь сменил кампанию или SSE прислал кадр в
момент команды. Повтор уже исследованного в [round-2/12](./../round-2/12-command-retries.md)
несовместимого HTTP-запроса под одним ключом здесь не дублируется. Тактические
команды и отдых имеют отдельный безопасный путь в
 [`tactical-command-recovery.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/tactical-command-recovery.mjs),
поэтому ниже зафиксированы пробелы в остальных мутациях.

## Результат

Проверены четыре клиентские границы: подтверждённые transport-факты отделены
ниже от гипотез сквозного поведения. Главный кандидат на усиление — свободное
действие: `/api/narrate` получает случайный ключ внутри `narrateWithAgent`, но
`submitAction` не сохраняет его. Если сервер записал ход и ответ потерялся,
повтор после таймаута или перезагрузки отправляет новую логическую операцию.
Серверная идемпотентность не может сопоставить разные ключи.

| ID | Приоритет | Статус | Сценарий | Последствие |
| --- | --- | --- | --- | --- |
| **REC-01** | P1 | static + transport подтверждены; двойной commit не воспроизведён | свободное действие: commit → потеря ответа → повтор/перезагрузка | новый ключ адресует новую логическую операцию; фактический повторный эффект не проверен |
| **REC-02** | P2 | гипотеза по transport/code path; same-key group outcome не доказан | голос или общий бросок решения отряда: ответ потерян → повтор | новый ключ может отличаться; не доказано, что уже разрешённая группа получит новый commit/d20 |
| **REC-03** | P2 | decoder acceptance подтверждён; full hook lock/runtime не доказан | HTTP 200 с неполным JSON или зависший `/api/roll` | malformed payload проходит без decoder; busy-lock — гипотеза, timeout roll подтверждён статически |
| **REC-04** | P2 | reduced queue model, не full hook execution | кадр комнаты A ожидает в очереди, затем открывается B | модель может выбрать A по версии; epoch/reset guards и фактическое применение не проверены |

Проба запускается без сервера и без рабочей кампании:

```text
node docs/reviews/2026-10-04/round-3/client-recovery-probe.mjs
```

Она компилирует существующий `ai-client.ts` тем же локальным TypeScript, которым
пользуются клиентские тесты, подменяет только `fetch`, а затем проверяет transport
facts и две reduced-модели. Фактический результат этого среза:

```json
{
  "ok": true,
  "scenarios": {
    "narrate_without_explicit_key": {
      "first_key_present": true,
      "second_key_present": true,
      "keys_equal": false
    },
    "malformed_200_decoder_acceptance": {
      "decoder_rejected": false,
      "payload_keys": [],
      "busy_lock_proven": false
    },
    "queued_snapshot_selection_model": {
      "selected_campaign": "A",
      "current_campaign": "B",
      "hook_execution_proven": false
    },
    "skill_roll_transport_timeout": {
      "uses_fetch_with_timeout": false
    }
  }
}
```

Это probe контрактов, static source facts и reduced queue model, а не full-hook или
browser proof. Внешнее browser evidence root уже подтвердило положительный путь
для тактического recovery: первый `MoveActor` получил proxy 503, повтор с тем же
ключом получил `replayed: true`, reload сохранил recovery notice, а версии
остались `2,2,4,4` ([browser-observations.json](./browser-observations.json),
[browser-recovery-receipts.json](./browser-recovery-receipts.json)). Это укрепляет
существующий tactical helper и не доказывает обычный `/api/narrate`, group vote,
malformed response cleanup или stale queue REC-04.

## REC-01 — P1: свободное действие теряет idempotency key после неизвестного исхода

### Трасса

`narrateWithAgent` делает параметр `idempotencyKey` необязательным и при его
отсутствии генерирует новый UUID при каждом вызове
([`ai-client.ts#L148-L156`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L148-L156)). Этот
ключ действительно уходит в `/api/narrate`
([`ai-client.ts#L169-L191`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L169-L191)).

Обычный ввод из `submitAction` вызывает функцию без ключа
([`useGameSession.ts#L845-L880`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L845-L880)). До запроса hook уже ставит
`isNarrating: true`, но в обработчике ошибки сохраняет только системное
сообщение и освобождает `busy`; записи с исходным ключом, телом и кампанией там
нет ([`useGameSession.ts#L889-L919`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L889-L919)).
`fetchWithTimeout` различает timeout, но это не меняет отсутствие pending-записи
([`ai-client.ts#L32-L57`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L32-L57)).

При подтверждении уже показанного proposal ключ создаётся в объекте React state
([`useGameSession.ts#L942-L949`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L942-L949)) и используется при
`confirmPendingAction` ([`useGameSession.ts#L1001-L1026`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1001-L1026)), но общий
снимок для local storage/BroadcastChannel намеренно обнуляет `pendingAction` и
`pendingCheck` ([`useGameSession.ts#L277-L284`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L277-L284)). Из локального хранилища
сохраняется только код активной кампании, не запрос
([`useGameSession.ts#L507-L509`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L507-L509)).
Серверная сторона принимает этот ключ и использует его для stream message и
event-store операции ([`server/index.mjs#L5446-L5455`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L5446-L5455));
один и тот же ключ может быть replay, но новый ключ адресует новый запрос.

### Доказательный сценарий

1. Игрок отправляет «Открыть дверь». Клиент генерирует `K1` и отправляет тело.
2. Сервер проходит commit, но TCP-ответ обрывается до `response.json()` либо
   истекает клиентские 48 секунд ([`ai-client.ts#L192-L216`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L192-L216)).
3. Клиент показывает ошибку; pending-операции с `K1` нет. Нажатие той же кнопки
   или повтор после F5 вызывает `narrateWithAgent` без ключа и отправляет `K2`.
4. Probe непосредственно показывает `keys_equal: false` для двух одинаковых
   вызовов. На сервере duplicate lookup по кампании и ключу происходит именно
   для переданного ключа ([`game-orchestrator.mjs#L2106-L2136`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L2106-L2136)); `K2` не является replay `K1`.

Это не утверждение, что каждая свободная фраза дважды меняет мир: некоторые
фразы открывают проверку или уточнение, а сервер может отказать по новому
состоянию. Подтверждён именно разрыв гарантии «неизвестный исход → повторяет
ровно ту же логическую операцию», от которой зависит отсутствие двойного хода,
стоимости или перехода.
Фактический повторный commit свободного действия здесь не запускался; это verdict
о потере request identity и recovery guarantee, а не receipt двойного эффекта.

### Рекомендация

Ввести общий клиентский `pendingMutation` для всех endpoint-ов, которые могут
создать commit. До отправки сохранять ограниченный envelope
`{ account_id, campaign_id, actor_id, operation, idempotency_key, body, created_at }`
в `sessionStorage` под ключом аккаунта и кампании. В pending хранить именно
канонизированное тело, а не только текст: повтор должен отправлять тот же
`request_kind`, `npc_id`, proposal/check references и `roll_id`.

Очистка должна происходить только после авторитетного `2xx`/безопасного
семантического `4xx`; timeout, abort, 5xx и ошибка разбора JSON должны оставлять
запись и показывать «Повторить это же действие». После загрузки комнаты клиент
может сначала сверить `idempotency_key` с результатом/версией, а затем повторить
тот же body. Тактический helper уже задаёт нужную политику
([`tactical-command-recovery.mjs#L18-L64`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/tactical-command-recovery.mjs#L18-L64));
лучше обобщить его контракт, чем строить второй recovery-путь.

## REC-02 — P2: голос и общий бросок отряда не сохраняют ключ между попытками

`voteAgentInteraction` и `abstainAgentInteraction` вызывают обычный `fetch`
без request ref, pending storage или guard от параллельного нажатия; каждая
попытка создаёт `commandId()` прямо в body
([`useGameSession.ts#L1260-L1305`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1260-L1305)). Общий бросок устроен так же
([`useGameSession.ts#L1307-L1327`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1307-L1327)).

Серверные маршруты используют этот ключ как связь с commit: для голоса новый
ключ проходит `commitDerived`
([`server/index.mjs#L3775-L3809`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3775-L3809)), а для общего броска новый ключ снова вызывает `diceService.roll`
([`server/index.mjs#L3838-L3856`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3838-L3856)). Проверка дубликата после запроса
сравнивает запрос только с тем ключом, который пришёл
([`server/index.mjs#L3803-L3809`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3803-L3809));
новый ключ не обязан считаться повтором того же голоса. Это подтверждает
несохранение client request identity, но не доказывает, что уже разрешённая
группа действительно получит второй commit или что повторный бросок станет
новой d20.

Потенциальный сценарий для проверки (в этом bounded pass не выполнялся):

1. Герой голосует за вариант `north`, клиент отправляет `V1`.
2. Commit записан, но ответ потерян.
3. Повтор кнопки отправляет `V2`. Код `resolvePartyVote` допускает замену голоса
   того же участника и при определённых состояниях может записать новый
   `PartyVoteCast`/`PartyDecisionResolved`; однако без сквозного запроса с
   commit-before-drop нельзя утверждать, что именно такой повтор дошёл до
   второго commit вместо отказа или replay.

Для общего броска ключ также не даёт клиентской гарантии replay прежней d20:
маршрут вызывает `diceService.roll` по новой попытке. Если первый commit уже
закрыл решение, второй запрос может закончиться конфликтом; если запросы
пересеклись до commit, поведение зависит от серверной гонки. Фактический
результат повторного group roll этим probe не проверен.
Смена страницы также теряет оба UUID: refs в hook не
переживают размонтирование. `requestQuestDecision` и `advanceAdventure` лучше,
но только в пределах одного монтирования: `pendingQuestRequest` и
`directorPendingRequestRef` также являются in-memory refs
([`useGameSession.ts#L1223-L1258`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1223-L1258),
[`useGameSession.ts#L2187-L2233`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L2187-L2233)).

Решение — тот же общий pending envelope из REC-01. Для голоса ключ должен быть
связан с `(campaign, interaction, voter, option/abstain)`, для общего броска — с
`(campaign, interaction, voter)`. При повторе нельзя пересобирать body и нельзя
выдавать новый случайный бросок. UI также должен иметь один `busy`/in-flight
guard на interaction, а не полагаться на отключение конкретной кнопки.

Граница: public free die (`rollFreeDie`) — внеигровой бросок, но его текущий
контур также не передаёт пользовательский ключ
([`ai-client.ts#L232-L242`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L232-L242)). Сервер строит ключ
`public-die:<roll.id>` после генерации новой кости
([`server/index.mjs#L5295-L5320`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L5295-L5320)), поэтому повтор после reload
добавляет новый публичный бросок. Это P2 косметической целостности, а не новый
боевой расход.

## REC-03 — P2: часть критических ответов не ограничена timeout и не декодирует `unknown`

### Неполный HTTP 200

`narrateWithAgent` превращает произвольный `response.json()` в `AiTurnResult`
обычным TypeScript cast ([`ai-client.ts#L193-L216`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L193-L216)); runtime-проверки `narration`, `effects`, `turn_id` и версии состояния нет. Probe получил HTTP 200 `{}` и
подтвердил, что decoder не отклоняет payload. Это факт границы JSON, но не
доказательство полного поведения mounted hook.

Ветка после сетевого `try/catch` использует `finishTurn`/`aiResult.narration` и
затем `aiResult.effects.grantItems`
([`useGameSession.ts#L933-L998`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L933-L998)); при `{}` здесь возможен TypeError. Hook до запроса действительно
ставит `busy.current = true` и `isNarrating: true`
([`useGameSession.ts#L845-L864`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L845-L864)), но эта probe не монтирует hook и не доказывает, что UI
останется заблокирован навсегда. Поэтому busy-lock — P2-гипотеза до full-hook
или browser proof.

Та же граница повторяется в `rollSharedDie`, `generateItemImage` и авторизации:
они доверяют JSON после `response.ok`
([`ai-client.ts#L222-L255`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L222-L255),
[`auth-client.ts#L6-L10`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/auth-client.ts#L6-L10)).

### Неограниченный запрос броска

`rollDice` использует обычный `fetch` без `fetchWithTimeout`
([`ai-client.ts#L222-L230`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L222-L230)). `rollPendingCheck` ждёт этот Promise в `Promise.all` и удерживает
`busy.current` до завершения ([`useGameSession.ts#L1075-L1112`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1075-L1112)). Это подтверждает отсутствие client-side
deadline для этого запроса; эффект зависшего Promise на карточку и retry в
mounted UI этим bounded pass не проверен. Серверный `RollRegistry` умеет вернуть тот же
выданный бросок по `check_id` после потери ответа
([`server/roll-registry.mjs#L145-L181`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/roll-registry.mjs#L145-L181)), но текущий клиент не доходит до этой политики без F5.

Нужен единый transport wrapper с четырьмя этапами: bounded timeout/abort,
безопасное чтение `unknown`, нормализация `ApiRequestError` и явная классификация
`authoritative failure`/`unknown outcome`. Decoders должны проверять минимальный
контракт результата до вызова hook. Для неизвестного ответа нельзя автоматически
снимать pending или запускать новый UUID; UI должен предложить точный повтор
сохранившегося запроса.

## REC-04 — P2: очередь SSE/poll snapshots не содержит явного campaign scope

Очередь хранит только `{ version, state }`, без идентификатора кампании
([`useGameSession.ts#L457-L465`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L457-L465)). `queueRoomSnapshot` добавляет любой кадр, а
`flushQueuedRooms` выбирает последний snapshot, сравнивая только числовую
`roomVersion` ([`useGameSession.ts#L579-L596`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L579-L596)). `applyRoomSnapshot` не проверяет, что
`room.state.sessionCode` совпадает с текущей комнатой
([`useGameSession.ts#L528-L537`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L528-L537)).

`switchCampaign` сбрасывает epochs, busy-флаги и кэш карт, но не очищает эту
очередь ([`useGameSession.ts#L1984-L2003`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L1984-L2003)). Это создаёт stale-queue
гипотезу, но сам факт отсутствия `campaignId` ещё не доказывает, что mounted hook
применит старый кадр: epoch/reset guards и момент flush нужно проверить сквозным
сценарием. Reduced model показывает возможный порядок:

1. В кампании A выполняется тактическая команда; SSE приносит A с версией 7,
   но hook ставит его в queue, пока `tacticalBusyRef` истинен.
2. Игрок открывает меню кампании и выбирает B. `switchCampaign` устанавливает
   `roomVersion = 1` для B и применяет B.
3. Если после снятия busy flush действительно выберет очередь без дополнительной
   проверки кампании, версия A=7 больше B=1, и `applyRoomSnapshot` может выбрать
   A. Этот шаг в текущем probe не исполняется через hook.

Probe воспроизводит только reduced selection model и получает
`selected_campaign: "A"` при текущей модели B; `hook_execution_proven` явно
остаётся false. В UI меню кампании
доступно из шапки независимо от тактического busy
([`App.tsx#L304-L305`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/App.tsx#L304-L305)),
а локальный `CampaignModal` блокирует только свои параллельные клики, поэтому
это не требует двух вкладок, но не заменяет full-hook proof.

Если гипотеза подтвердится, риск будет не только визуальным: URL после
`switchCampaign` уже указывает B, тогда
как `state.sessionCode` может снова стать A; последующий action отправится в
неожиданную кампанию. Состояние также может записаться как активная кампания и
перезапустить SSE-эффект для A. Версии нельзя сравнивать между комнатами:
`roomVersion` должен быть scoped к `campaignId`.

Если mounted hook/browser сценарий подтвердит этот порядок, минимальное
исправление:

1. Хранить в queued entry `campaignId` и отбрасывать entry, если он не равен
   текущему `stateRef.current.sessionCode`.
2. На начале `switchCampaign` очищать очередь старой кампании либо переносить её
   в `Map<campaignId, Queue>`; для одного активного стола проще очистить.
3. В `applyRoomSnapshot` проверять `state.sessionCode` до `roomVersion` и
   `applyRemote`.
4. Привязать `fullRoomRequest` к campaign id: сейчас один Promise разделяют
   все комнаты, а `refreshFullRoom` читает `stateRef.current.sessionCode` и после
   await не проверяет, что кампания ещё та же
   ([`useGameSession.ts#L543-L563`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L543-L563)).

## Как обобщить без нового слоя риска

Безопасная последовательность PR:

1. Вынести `request-envelope` из тактического helper в чистый клиентский модуль:
   каноническое тело, ключ, campaign/account/actor scope, состояние `pending /
   committed / unknown / rejected`.
2. Подключить сначала `/api/narrate`, party vote/roll и quest/director; сохранить
   прежние server idempotency keys и не менять event schema.
3. Ввести один `decodeJsonResponse(response, decoder)` для минимальных runtime
   guards и один `fetchWithTimeout`-based transport. Декодеры должны возвращать
   `unknown`-safe ошибки, не TypeError из render/hook.
4. Сначала воспроизвести REC-04 через полный hook или браузер; при подтверждении
   добавить проверку `(campaignId, version)` и epoch в существующие точки
   применения/очереди снимка. Отдельный coordinator оправдан только при
   доказанном повторении одного контракта, а не ради reduced-модели.
5. Добавить тесты на конкретные границы: commit-before-timeout, malformed 200,
   reload pending, duplicate click на vote/roll и switch A→B с queued A. Для
   `/api/roll` проверить, что retry `check_id` возвращает тот же roll id.

Не следует сохранять viewer state целиком в local storage: текущая политика
правильно не кэширует чужую проекцию. Сохранять нужно только ограниченный
нечувствительный envelope запроса; authoritative state после reconnect должен
прийти через room endpoint/SSE.

## Проверки и ограничения

- `node docs/reviews/2026-10-04/round-3/client-recovery-probe.mjs` — **успешно**;
  TypeScript-компиляция `ai-client.ts`, mock-fetch для новых UUID, decoder
  acceptance для malformed response и reduced queue-selection model.
- `node --check docs/reviews/2026-10-04/round-3/client-recovery-probe.mjs` —
  **успешно**.
- `git diff --check` — выполняется после записи отчёта.
- Runtime-код, штатные тесты и browser UI не изменялись и не запускались в
  рамках этого bounded pass; полный `pnpm verify` не заявляется. Browser
  positive evidence root было создано раньше и только перечитано из immutable
  receipts.
- Probe не доказывает production duplicate commit с реальным LLM, busy-lock после
  malformed `{}`, повторный group vote/d20 или фактическое применение queued A
  после switch A→B. Для первых двух потребуется controlled HTTP/full-hook
  сценарий, для последних — mounted hook/browser scenario с временным storage.
  Probe доказывает источник ключа для ordinary narrate, decoder acceptance,
  отсутствие timeout у `rollDice` и риск reduced queue model.
- LIVE-01 из round-2 про отзыв SSE-доступа не повторяется; REC-04 относится к
  клиентской смене кампании и stale queue, даже если доступ пользователя остаётся
  действительным.
