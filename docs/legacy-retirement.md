# Этап 8: удаление legacy runtime

## Граница cutover

В live runtime существует только `enforce`. Значения `legacy` и `shadow` могут
быть прочитаны из старого snapshot или `.env`, но немедленно нормализуются в
`enforce` и не выбирают отдельную ветку исполнения.

Удалены или закрыты:

- legacy/shadow branches и `legacyHandler` в `GameOrchestrator`;
- shadow comparison и переключение режима;
- lazy import room snapshot из обычного игрового запроса;
- `LegacyStateSynchronized`, способный заменить event state полным snapshot;
- широкая запись `PUT /api/rooms/:code` — endpoint возвращает `410`;
- передача клиентом `state`, `player`, mode override или raw roll в
  `/api/narrate`;
- браузерные проверки, боевые последствия и игровой `Math.random`;
- прямое сохранение общего d20 в room: теперь это событие `PublicDieRolled`.

`storage/rooms` временно остаётся server-owned read-моделью для старого UI.
Клиент может её читать, но не заменять. Новые кампании создаются через
`FileEventStore.initializeCampaign`; `LegacyStateImported` разрешён только
явному offline-importer старых сохранений.

## Hash-verified projection

Версия state сама по себе не доказывает совпадение read-модели с replay.
`projection-integrity.mjs` рассчитывает SHA-256 канонических игровых полей.
Projection outbox подтверждается только после совпадения hash, а checkpoint
хранит `projection_checkpoint_hash`.

Read-only проверка:

```bash
pnpm cutover:audit
pnpm cutover:verify
```

`cutover:verify` завершается с кодом `2`, если найден хотя бы один orphan,
ошибка replay, несовпадение projection hash, неподтверждённый outbox или
retired mode в room.

## Текущее сохранённое storage

Аудит рабочего `storage/` на 25 июля 2026 года нашёл семь пар
room/event-stream. Их версии совпадают, но канонические hash расходятся; один
stream также расходится между snapshot load и replay без snapshots. Никакие
пользовательские сохранения автоматически не переписывались.

До фактического data cutover необходимо:

1. остановить записи и создать проверенную зашифрованную резервную копию;
2. для каждой расходящейся кампании определить каноническую сторону;
3. выполнить reconciliation на копии storage;
4. получить `ready: true` от `cutover:verify`;
5. провести restore/rollback rehearsal и выдержать установленное rollback
   window;
6. только затем удалить compatibility read-модель.

Broad snapshot sync запрещён: исправления канонического состояния должны быть
типизированными событиями либо явной одноразовой миграцией с manifest.
