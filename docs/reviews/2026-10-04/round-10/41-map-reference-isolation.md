# Раунд 10/41 — изоляция ссылок карт между кампаниями

**Вердикт: PASS в проверенных сценариях reducer/event-store/projection.** Для двух кампаний с одной и той же картой (одинаковый `content hash`) раскрытие клетки, состояние двери и состояние реквизита не перетекают из одной кампании в другую. Публичная проекция также строится из отдельной карты и не раскрывает скрытый prop второй кампании.

Базовый SHA исходного runtime: `cb045a8466f35696ff24abe9020d6f39dee89462`. Scope: `MapStore`, snapshot/internalize путь `FileEventStore`, `normalizeCampaignState`, реальные reducer events и `campaignStateForViewer`. Probe напрямую пишет события через `FileEventStore.commit`; он не запускает `AuthoritativeExecutor`, командную валидацию или HTTP, поэтому вывод не распространяется на эти границы. Отдельного `materializeMaps` в дереве нет: соответствующая пара функций называется `externalizeMaps`/`internalizeMaps`.

## Контракты, которые дают изоляцию

- `MapStore` дедуплицирует файл по SHA-256 содержимого и держит ограниченный LRU-подобный кэш по hash. Это общий объект для одинакового hash: [`server/map-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/map-store.mjs#L67-L145).
- При записи снимка `FileEventStore` сначала делает JSON-копию состояния, затем выносит карты в `MapStore`; в снимке остаётся только `MapRef`: [`server/event-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L505-L529).
- При чтении ссылка восстанавливается только после проверки checksum снимка. Затем `_load` снова прогоняет состояние через `_normalizeState`, который принимает JSON-копию. Поэтому разобранная карта из `MapStore` не является объектом `state.scene.map` конкретной кампании. Probe проверяет это двумя отдельными экземплярами `FileEventStore` после seed и после commit при общем `MapStore`: оба cold load получают разные объекты состояния и не разделяют identity с cached blob: [`server/event-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L480-L503), [`server/event-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L541-L584).
- Кэш головы `FileEventStore` хранит `structuredClone` и возвращает новый `structuredClone`, так что ответ одной кампании не может изменить cached head другой загрузки: [`server/event-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L250-L288), [`server/event-store.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L550-L564).
- Внутренний `WeakMap` Rules Engine адресует разобранную тактическую карту по объекту `state.scene.map`, а не по hash. При записи изменения старый ключ удаляется и сериализуется новый объект: [`server/rules/tactical-geometry.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules/tactical-geometry.mjs#L40-L59), [`server/rules-engine.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L2180-L2202).
- Изменения карты идут через реальные события reducer (`AreaRevealed`, `DoorStateChanged`, `SceneObjectStateChanged`), а не через правку снапшота: [`server/rules-engine.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L24440-L24456), [`server/rules-engine.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L24545-L24565).
- Публичная карта сохраняет общую форму сетки и видимую топологию, но для нераскрытых клеток заменяет материал, вариант, поверхность, стоимость движения, высоту и hazards; скрытые props удаляются, как и рёбра/двери, видимые только с нераскрытых сторон. Результат сериализуется в новый transport object, исходное состояние и cache не мутируются: [`server/viewer-projection.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/viewer-projection.mjs#L278-L375), [`server/viewer-projection.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/viewer-projection.mjs#L464-L518).

## Probe границ изоляции

Скрипт [`41-map-isolation-probe.mjs`](./41-map-isolation-probe.mjs) создаёт только временное хранилище и синтетическую карту. На карте есть закрытая дверь, скрытый chest и входная раскрытая клетка. Две кампании инициализируются одним содержимым карты; probe проверяет, что записанные в два снимка `scene.map.hash` совпадают.

После seed создаётся новый `FileEventStore`, и обе кампании перечитываются cold через `internalizeMaps`. Проверяется, что два состояния не имеют общей identity карты и что оба не являются объектом, возвращённым общим cached `MapStore` blob. Затем в `alpha` одним настоящим commit применяются три события: раскрытие клеток, открытие двери и открытие prop. После commit создаётся ещё один новый `FileEventStore`; его cold load снова проверяет отсутствие общей identity состояний и cached blobs. `beta` сохраняет закрытую дверь, пустое состояние prop и нераскрытую клетку. `campaignStateForViewer` показывает prop только для `alpha`, а состояние двери в публичных картах остаётся соответственно `open` и `closed`.

Этот probe проверяет границы хранения, reducer и projection напрямую. Он не является сквозным доказательством HTTP-маршрута, `AuthoritativeExecutor` или командной авторизации.

Запуск:

```text
node docs/reviews/2026-10-04/round-10/41-map-isolation-probe.mjs
{"ok":true,"sameInitialMap":true,"alphaDoor":"open","betaDoor":"closed","alphaPropVisible":true,"betaPropVisible":false}
```

Дополнительно выполнены существующие сторожа:

```text
node --test test/map-store.test.mjs test/tactical-map-state.test.mjs test/viewer-projection.test.mjs
58 passed, 0 failed
```

Они покрывают дедупликацию одинакового содержимого, round-trip снимка, replay с вынесенной картой, защиту snapshot cache от изменения ответа commit, раскрытие через reducer и сокрытие скрытых свойств/props в player projection: [`test/map-store.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/map-store.test.mjs#L40-L215), [`test/tactical-map-state.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/tactical-map-state.test.mjs#L1-L180), [`test/viewer-projection.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/viewer-projection.test.mjs#L1-L120).

## Ограничение контракта

Низкоуровневый `MapStore.get(hash)` возвращает внутренний объект кэша без копии. Если будущий код намеренно получит этот объект и мутирует его, последующий `get` того же hash в процессе увидит мутацию. Это ограничение ownership API, а не найденная утечка штатного приложения: `FileEventStore` копирует состояние до записи и после восстановления, а текущие вызывающие пути `MapStore.get` не отдают сырую ссылку игроку.

Без изменения исходников безопасное правило для следующих изменений: `MapStore` остаётся внутренней зависимостью event store; результат `get` считается заимствованным immutable-значением и не передаётся в mutable response/reducer. Если потребуется новый публичный или долгоживущий caller, сначала измерить стоимость копирования на картах целевого размера и сохранить уже проверенные clone-контракты `FileEventStore`; выбор дополнительной границы владения должен опираться на это измерение, а не на универсальную заморозку объектов.

Известный отдельно отмеченный RCV03 с отсутствующей проверкой hash содержимого JSON здесь не переименовывался и не засчитывался как новый результат этого аудита.
