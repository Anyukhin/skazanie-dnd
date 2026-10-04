# REC-02: повтор голоса и общего броска после потери ответа

**Срез кода:** runtime pinned `88c620e6011ae607913efb224cb8f850b4ee5028`.
Рабочий checkout имеет поверх этого runtime только документацию аудита (`HEAD`
`7f387efc73ec95bc47337df06b84970f5d1340d9`). Проверялся реальный HTTP путь с
временным `DND_STORAGE_DIR`, пустым `ROUTERAI_API_KEY`, admin-only setup и двумя
обычными игроками. Рабочие `storage/`, `data/`, `.env` и runtime-код не менялись.

## Результат

Гипотеза разделяется на два исхода:

| Путь | После первого commit и обрыва ответа | Повтор с тем же телом, но новым ключом | Доказательство |
| --- | --- | --- | --- |
| `POST /api/campaigns/REC02-VOTE/party-decisions/vote-retry/votes` | backend записал `PartyVoteCast` с `vote-k1`, клиент получил сетевую ошибку | same-key `vote-k1` вернул `200` без нового события; новый `vote-k2` записал второй `PartyVoteCast`, версии `1 → 2` | реальный proxy + event log |
| `POST /api/campaigns/REC02-ROLL/party-decisions/roll-retry/roll` | backend записал `DieRolled` и `PartyDecisionResolved` с `roll-k1`; клиент получил сетевую ошибку | same-key `roll-k1` вернул `200` без нового события; новый `roll-k2` получил `409 PARTY_DECISION_CLOSED`, нового `DieRolled` нет | реальный proxy + event log |

Таким образом, REC-02 подтверждён как лишний commit голосования, но не как
двойной результат: в контроле после обоих запросов `state.agentInteraction.votes` остаётся
`{"hero-a":"north"}`, `PartyDecisionResolved` — `0`, ресурсы и мировое время
не изменились. Второй `PartyVoteCast` является заменой голоса того же участника
на тот же вариант при всё ещё открытом решении. Это P2-риск неизвестного
восстановления и лишней записи, а не доказательство усиления голоса или
двойного перехода.

Смена голоса до quorum сама по себе разрешена правильно. Приоритет относится
к восстановлению неизвестного исхода на клиенте, а не к запрету повторного
голосования в Rules Engine. Если игрок действительно выбирает новое действие,
новый ключ уместен; если он восстанавливает потерянный ответ, нужен прежний ключ.

Для общего броска сервер закрывает решение атомарно вместе с первым броском.
Точный same-key контроль возвращает сохранённый replay без новой кости; повтор
с новым ключом получает `PARTY_DECISION_CLOSED`. Это подтверждает текущую
серверную границу, но не реализует recovery клиента: клиент по-прежнему теряет
исходный ключ и сам не выполняет same-key retry. Более общий безопасный replay
для ошибок до/во время lookup здесь не заявляется; в других гонках сервер может
вернуть конфликт до успешного lookup.

## Как устроена проверка

Проба [`30-vote-retry-probe.mjs`](./30-vote-retry-probe.mjs) запускает
`server/index.mjs` на временном порту и ставит перед ним локальный HTTP proxy.
Для каждой операции proxy пересылает запрос backend, полностью читает его
ответ, а затем один раз уничтожает клиентское соединение вместо передачи
ответа. Поэтому сетевой сбой происходит после того, как backend сформировал и
получил полный response body; факт commit дополнительно проверяется чтением
неизменяемых файлов event store.

Для vote использованы два участника и `requiredVotes: 2`: первый голос
`hero-a/north` оставляет interaction открытым, same-key replay не создаёт нового
события, а повтор той же логической операции с новым ключом допустим как замена
голоса и записывает отдельный `PartyVoteCast`. Это намеренно показывает риск
REC-02, а не случайное двойное разрешение: после обоих ключей один actor имеет
один и тот же ballot, `PartyDecisionResolved` не создаётся, а
`resources/world_time` совпадают с первым состоянием.

Для roll используется отдельное открытое решение. Первый запрос записывает
пакет `DieRolled + PartyDecisionResolved`; same-key replay возвращает этот же
пакет и не меняет event log, а повтор с новым ключом видит закрытый interaction
и получает `409 PARTY_DECISION_CLOSED`. В event log остаётся один `DieRolled`,
один `PartyDecisionResolved` и один idempotency key `roll-k1`.

## Фактический результат probe

Успешный прогон напечатал следующие существенные поля:

```json
{
  "runtime_pin": "88c620e6011ae607913efb224cb8f850b4ee5028",
  "vote": {
    "first_request": "connection_dropped_after_upstream_body",
    "same_key_status": 200,
    "same_key_event_count": 1,
    "retry_status": 200,
    "first_votes": {"hero-a": "north"},
    "retry_votes": {"hero-a": "north"},
    "resources_unchanged": true,
    "world_time_unchanged": true,
    "retry_event_types": ["PartyVoteCast"],
    "event_log": [
      {"event_type": "PartyVoteCast", "idempotency_key": "vote-k1", "state_version_after": 1},
      {"event_type": "PartyVoteCast", "idempotency_key": "vote-k2", "state_version_after": 2}
    ],
    "vote_commit_count": 2,
    "resolved_count": 0
  },
  "roll": {
    "first_request": "connection_dropped_after_upstream_body",
    "same_key_status": 200,
    "same_key_event_count": 2,
    "retry_status": 409,
    "retry_code": "PARTY_DECISION_CLOSED",
    "event_log": [
      {"event_type": "DieRolled", "idempotency_key": "roll-k1", "state_version_after": 1},
      {"event_type": "PartyDecisionResolved", "idempotency_key": "roll-k1", "state_version_after": 2}
    ],
    "die_rolled_count": 1,
    "resolved_count": 1
  }
}
```

## Связь с клиентом и сервером

Клиент действительно создаёт новый UUID при каждом нажатии: `voteAgentInteraction`
передаёт `idempotency_key: commandId()` в
[`src/useGameSession.ts#L1260`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/useGameSession.ts#L1260),
а `rollAgentInteraction` делает то же в
[`src/useGameSession.ts#L1307`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/useGameSession.ts#L1307).
Pending envelope между ошибкой и повтором отсутствует; проба воспроизводит именно
эту границу, подставляя `k1`, затем `k2`.

В открытой панели выбранный вариант получает класс `selected`, но не становится
disabled: кнопки блокируются только при `resolved`
([`AppViews.tsx#L308-L341`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/AppViews.tsx#L308-L341)).
Это статическая связь с доступным повторным нажатием, а не выполненный
браузерный сценарий потери ответа.

Серверный vote route принимает ключ и вызывает `commitDerived` с
`resolvePartyVote` в
[`server/index.mjs#L3764-L3809`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L3764-L3809).
Для roll route кость создаётся сервером, затем `resolvePartyRoll` и commit идут
в [`server/index.mjs#L3825-L3865`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L3825-L3865).
Идемпотентность привязана к переданному ключу; `k2` не является replay `k1`.
Проба также отправляет `k1` второй раз после обрыва: exact-body replay сейчас
возвращается как `200` без нового commit для обоих endpoint-ов. Это контроль
серверного маршрута, а не проверка будущего клиентского pending envelope; UI
пути из `useGameSession.ts` всё ещё генерируют новый UUID на каждом вызове.

## Ограничения и вывод

Это сквозное доказательство backend commit/retry на pinned runtime, но не
браузерный сценарий и не проверка конкретной React-ветки после `fetch` exception.
В нём нет LLM-вызова, второго окна или реального пользователя. Голос проверен в
состоянии, где первый vote не закрывает quorum; для обычного одноучастникового
голоса повтор, как и для общего броска, должен попасть в закрытое решение.

Минимальное исправление остаётся из REC-01: сохранять исходный request envelope
и повторять тот же ключ и каноническое тело после неизвестного исхода. Для vote
это устраняет второй commit; для roll это сохраняет безопасный replay path даже
если ответ потерян после атомарного закрытия решения.

Проверки: `node docs/reviews/2026-10-04/round-6/30-vote-retry-probe.mjs`,
`node --check docs/reviews/2026-10-04/round-6/30-vote-retry-probe.mjs`,
`git diff --check`. Итог общего `pnpm verify` указан в [сводке прохода](README.md).
Runtime и штатные тесты не менялись.
