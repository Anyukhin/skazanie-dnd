# SEC-01: проверка привязки броска через настоящий HTTP

Срез runtime: `88c620e6011ae607913efb224cb8f850b4ee5028`. Проба запускает
отдельный `server/index.mjs` как subprocess на localhost, с временным
`DND_STORAGE_DIR`, пустым `DOTENV_CONFIG_PATH`, `ROUTERAI_API_KEY=''` и без
LLM-вызова. `/api/auth/setup-admin` создаёт администратора стенда, затем
`POST /api/campaigns` создаёт кампанию; дальнейшие `/api/narrate`, `/api/roll` и GET комнаты
выполняются cookie обычного игрока, которому admin fixture назначил `hero-a`.
После прогона subprocess и временный каталог удаляются.

## Результат

Гипотеза SEC-01 подтверждена реальным HTTP-путём. После первой фазы обычной
проверки `Проверяю силу` сервер вернул карточку `check_id`, но три следующих
запроса `POST /api/roll` без `checkId`/`check_id` были приняты (все `200`).
Из значений `[2, 15, 20]` проба выбрала максимальный roll_id
`8fd7444b-77a9-44b1-8388-e833b873f82d`. Затем обычный авторизованный
`POST /api/narrate` принял только эту серверную ссылку и завершил ход:

```json
{
  "roll_id": "8fd7444b-77a9-44b1-8388-e833b873f82d",
  "kept": 20,
  "total": 20,
  "difficulty": 15,
  "player_rolled": true,
  "state_version": 1
}
```

Значение кости не зашито в probe: он проверяет, что `/api/narrate` принимает
фактически возвращённые `kept` и `roll_id`, а не требует конкретной грани.
В этом одиночном bounded-прогоне максимум случайно оказался равен 20; это
результат генератора, а не ожидание теста.

Трассировка не синтетическая: после ответа прочитаны реальные файлы
`storage/engine/campaigns/*/events/*.json`. В них был ровно один commit с
`idempotency_key=http-generic-resolve`, переходом версии `[0, 1]` и одним
событием `AbilityCheckResolved`, с тем же `roll_id`, `kept`, `total` и `difficulty`.
Повтор с тем же ключом вернул `200` и `idempotent_replay=true`; новый ключ для
того же roll_id получил `400` «Бросок уже использован».

Контроли в том же HTTP-сеансе:

| Сценарий | Результат |
| --- | --- |
| `checkId=missing-check-id` | `400`, «Проверка не найдена или истекла» |
| чужой `playerId=hero-b` с cookie владельца `hero-a` | `403`, «Бросок доступен только владельцу героя» |
| повтор уже принятого generic `roll_id` с новым ключом | `400`, «Бросок уже использован» |

Это подтверждает, что campaign/actor binding и одноразовое потребление работают
для существующей записи. Проблема уже: сама выдача записи без карточки проверки
разрешена, и последующая обычная ability-check ветка принимает такую запись.

## Где проходит граница в коде

Роут `POST /api/roll` проверяет владельца героя и кампанию, затем передаёт в
`RollRegistry.issue` необязательный `checkId`; отдельной проверки наличия
`check_id` в HTTP-ветке нет:

[`server/index.mjs#L5355`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L5355),
[`server/index.mjs#L5364`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L5364).

В `RollRegistry.issue` отсутствие `checkId` означает отсутствие
`registeredId`, поэтому создаётся запись с `context=null`; при наличии
карточки, напротив, проверяются её campaign и actor:

[`server/roll-registry.mjs#L147`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/roll-registry.mjs#L147),
[`server/roll-registry.mjs#L152`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/roll-registry.mjs#L152).

`/api/narrate` потребляет roll по `roll_id`, связывая его с campaign, actor и
idempotency key:

[`server/index.mjs#L5473`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L5473),
[`server/roll-registry.mjs#L184`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/roll-registry.mjs#L184).

Но обычный план `MakeAbilityCheck` получает любой `verifiedRoll`; отдельная
проверка, что запись была выпущена для этого `check_id` и текущего action/state,
в этой ветке отсутствует:

[`server/game-orchestrator.mjs#L2611`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/game-orchestrator.mjs#L2611),
[`server/game-orchestrator.mjs#L2648`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/game-orchestrator.mjs#L2648).

Изолированный in-memory probe [`roll-probes.mjs`](../roll-probes.mjs) уже
показывал тот же порядок `issue без checkId → consume → GameOrchestrator`, но
не доказывал HTTP/auth/storage путь. Настоящий HTTP результат выше закрывает
именно эту прежнюю оговорку; он не утверждает, что чужой actor или повторный
roll обходят свои отдельные проверки.

## Следствие

SEC-01 остаётся P1. Игроку достаточно один раз объявить обычную проверку, а
затем выпустить ограниченную здесь только числом запросов серию независимых
серверных d20 без `check_id`, выбрать удачный `roll_id` и применить его к
карточке. Текущие controls не меняют этот вывод: они защищают владельца,
кампанию и повторное потребление уже созданной записи, но не происхождение
записи. Минимальная исправляющая задача — сделать выпуск без существующей
карточки недопустимым для механических ходов либо отклонять unbound запись в
ветке механической проверки. Свободный бросок уже имеет отдельный путь:
`rollSharedDie` → `POST /api/rooms/:code/dice`
([клиент](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/ai-client.ts#L232-L246),
[сервер](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/index.mjs#L5273-L5325)).
Сохранить этот существующий пользовательский сценарий; ещё один dice endpoint
для исправления привязки не требуется.

Проверки воспроизводимости:

```text
node --check docs/reviews/2026-10-04/round-6/29-roll-http-probe.mjs
node docs/reviews/2026-10-04/round-6/29-roll-http-probe.mjs
```

Обе команды завершились успешно в этом срезе. Исходник пробы:
[`29-roll-http-probe.mjs`](./29-roll-http-probe.mjs).
