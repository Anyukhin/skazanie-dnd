# Повтор /api/narrate с auto-roll после потери ответа

**Срез:** baseline e1d927f5aa68dc9eca912b527cccf3974ba3e9e7; рабочая ветка
содержит только материалы аудита. Проверка выполнена 4 октября 2026 года.
Runtime не изменялся.

Эта проба проверяет REC-01 из
[round-3/16-client-recovery.md](../round-3/16-client-recovery.md) дальше
статической трассы: backend должен успеть записать ход, локальный HTTP proxy
после этого должен вернуть клиенту 503 либо оборвать соединение, а затем
скомпилированный narrateWithAgent должен повторить ту же фразу без сохранённого
ключа. После каждого вызова probe заново читает реальный /api/rooms/:code и
файлы event store, поэтому число commit-ов и бросков не выводится из ответа
клиента.

Запуск:

```text
node docs/reviews/2026-10-04/round-4/narrate-retry-probe.mjs
```

## Что именно проверено

submitAction вызывает narrateWithAgent с undefined на месте idempotencyKey,
передавая actor id следующим аргументом
([useGameSession.ts#L869-L879](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/useGameSession.ts#L869-L879)).
Значение по умолчанию создаёт новый UUID при каждом вызове
([ai-client.ts#L148-L156](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L148-L156)),
а затем этот ключ уходит в /api/narrate
([ai-client.ts#L169-L191](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/ai-client.ts#L169-L191)).

Probe компилирует именно src/ai-client.ts локальным TypeScript и вызывает
функцию с теми же аргументами, что и production caller:

```js
client.narrateWithAgent(state, 'Проверяю силу', 'Герой', undefined, undefined, 'hero-a')
```

Запускается отдельный server/index.mjs на свободном порту, с пустым
ROUTERAI_API_KEY, временным DND_STORAGE_DIR и отдельной кампанией для
каждого сценария. В Node-пробе включён только локальный auto-roll flag, чтобы
сервер сразу разрешил проверку и записал AbilityCheckResolved; сетевого LLM
вызова при этом нет. Proxy сначала полностью получает ответ backend, тем самым
давая ему закончить commit, и только потом:

* для сценария 503 отвечает клиенту синтетическим HTTP 503;
* для сценария drop уничтожает клиентский сокет;
* для контрольного сценария пропускает оба ответа;
* для positive control с явным ключом возвращает 503 после первого commit,
  а второй запрос с тем же ключом пропускает до backend.

Это существующая пользовательская настройка «Автобросок кубика», доступная в
[панели настроек](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/AppViews.tsx#L1461).
В probe её значение задаётся через замену `window.localStorage`; нажатие самого
переключателя в браузере в этот прогон не входит.

При следующем вызове proxy снова пропускает запрос. В его журнале сохраняются
только два ключа /api/narrate, а число commit-ов, типы событий, roll payload и
мировые минуты читаются из временного event store и room projection.

## Результат

Ниже K1 и K2 — первые и вторые ключи, сокращённые обозначения случайных UUID
из вывода probe.

| Сценарий | Первый вызов клиенту | Backend после первого | Второй вызов | Backend после второго |
| --- | --- | --- | --- | --- |
| 503 после commit | ApiRequestError, status 503, code PROXY_DROP_AFTER_COMMIT | commit_count=1, версии 0→1, 1 AbilityCheckResolved, 1 roll, world_time=0 | успех, idempotent_replay=false, ключ K2 | commit_count=2, версии 0→1, 1→2, 2 события и 2 rolls, world_time=0 |
| socket drop после commit | TypeError: fetch failed | commit_count=1, версии 0→1, 1 AbilityCheckResolved, 1 roll, world_time=0 | успех, idempotent_replay=false, ключ K2 | commit_count=2, версии 0→1, 1→2, 2 события и 2 rolls, world_time=0 |
| same-key control | успех, ключ same-semantic-key | commit_count=1, версии 0→1, 1 событие и 1 roll, world_time=0 | успех, idempotent_replay=true, тот же ключ | commit_count=1, версия 0→1, 1 событие и 1 roll, world_time=0 |
| same-key после 503 | ApiRequestError, status 503, тот же явный ключ | commit_count=1, версии 0→1, 1 событие и 1 roll, world_time=0 | успех, idempotent_replay=true, тот же ключ | commit_count=1, версия 0→1, 1 событие и 1 roll, world_time=0 |

Фактические детали, которые probe проверяет assertions-ами:

```json
{
  "status_503": {
    "first_error": { "status": 503, "code": "PROXY_DROP_AFTER_COMMIT" },
    "first_commits": 1,
    "second_commits": 2,
    "keys_equal": false,
    "event_types": ["AbilityCheckResolved", "AbilityCheckResolved"],
    "world_time_minutes": [0, 0]
  },
  "drop": {
    "first_error": { "name": "TypeError", "message": "fetch failed" },
    "first_commits": 1,
    "second_commits": 2,
    "keys_equal": false,
    "event_types": ["AbilityCheckResolved", "AbilityCheckResolved"],
    "world_time_minutes": [0, 0]
  },
  "same_key_control": {
    "first_commits": 1,
    "second_commits": 1,
    "second_idempotent_replay": true,
    "keys_equal": true,
    "roll_count": [1, 1],
    "world_time_minutes": [0, 0]
  },
  "same_key_after_503": {
    "first_error": { "status": 503, "code": "PROXY_DROP_AFTER_COMMIT" },
    "first_commits": 1,
    "second_commits": 1,
    "second_idempotent_replay": true,
    "keys_equal": true,
    "roll_count": [1, 1],
    "world_time_minutes": [0, 0]
  }
}
```

В двух failure-сценариях первый commit содержит один бросок проверки. Второй
вызов получает новый UUID и создаёт второй AbilityCheckResolved с другим
roll_id; поэтому это уже не только разный transport key, а реальное повторное
механическое действие. Значения кубиков намеренно не фиксируются: серверный
DiceService использует криптографический RNG, а для finding достаточно
подтверждённых новых roll payload и новых state versions.

Контроль с одним ключом проходит через тот же backend: второй ответ помечен
idempotent_replay=true, event store не получает новый commit и новый roll.
Контроль «same-key после 503» проверяет это после той же потери ответа, что и
failure-сценарии: первый backend commit состоялся до 503, а повтор с тем же
ключом оставляет commit_count равным 1. Это отделяет исправно работающую
серверную идемпотентность от потери ключа на клиентском пути.

## Вывод REC-01

**P1 для проверенной ветки, confirmed, real HTTP + compiled client + mechanical
effect.** Если первый /api/narrate успел записать ход, но ответ потерян на
границе proxy, обычный submitAction не может повторить ту же logical operation:
первоначальный UUID не хранится, а следующий вызов генерирует K2. В проверенной
ветке с включённым auto-roll это увеличивает журнал с одного до двух commit-ов,
версии с 1 до 2 и число проверок/бросков с одного до двух. Это доказательство
не распространяется автоматически на manual-roll путь: в нём probe не доводил
первый запрос до commit-producing проверки. Событие не сдвигает мировые часы,
поэтому world_time_minutes остаётся 0; это свойство выбранной проверки, а не
отсутствие второго commit.

Рекомендация из предыдущего прохода подтверждается сквозным фактом: до первого
запроса нужен общий pending envelope с каноническим body и UUID, а запись нельзя
удалять при timeout, 5xx, оборванном ответе или ошибке разбора JSON. Для
submitAction повтор должен брать тот же envelope и тот же ключ; контроль выше
показывает, что сервер уже умеет безопасно вернуть прежний commit при таком
условии. В этот probe runtime не исправлялся.

## Ограничения доказательства

Проба не монтирует React useGameSession, не открывает браузер и не заявляет
browser proof. Она вызывает тот же скомпилированный narrateWithAgent с теми же
позиционными аргументами, которые production hook передаёт на строках
useGameSession.ts#L869-L879. Поэтому это доказательство для реального
клиентского модуля и HTTP-пути, но не
доказательство поведения браузерного React-состояния.

Proxy уничтожает ответ после того, как полностью прочитал backend response. Это
точно моделирует commit-before-drop, но не все варианты обрыва посередине
обработки backend. Проверена одна commit-producing action (Проверяю силу) с
включённым auto-roll; ручная двухфазная карточка, уточнение, social и переходы
сцены требуют отдельных probes. Manual-roll путь в этой пробе не считается
проверенным на двойной commit.

Каждый сценарий запускается на новой временной кампании и новом server process;
после чтения результатов proxy и subprocess останавливаются, storage удаляется.
Выполнены `node --check` и сам probe, оба завершились успешно. Итог общего
`pnpm verify` указан в [сводке прохода](README.md).
