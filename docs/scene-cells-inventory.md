# Инвентаризация потребителей `scene.cells`

Подготовка к M0 из `docs/tactical-map-plan.md`: перечислить всё, что читает или
пишет `scene.cells`, до того как менять контракт клетки. Снято 2026-07-26 на
коммите ветки `agent/mvp-autonomous-campaign`.

Как воспроизвести список:

```bash
grep -rn "scene\.cells\|scene?\.cells" server/*.mjs
```

Сейчас это **22 вхождения в 11 файлах**.

---

## 1. Кто карту создаёт

Единственный производитель — `generateDynamicSceneMap` в
`server/dynamic-map.mjs`. Он возвращает **массив, отсортированный по `y`, затем
по `x`**, и это **разреженный список, а не плотная сетка**: `footprintFor`
пропускает координаты вне контура (`continue` в двойном цикле, строка 158), так
что у пещеры или круглого зала клеток за границей контура просто нет.

Полная форма клетки на выходе генератора:

| Поле | Тип | Домен | Обязательное |
| --- | --- | --- | --- |
| `x`, `y` | number | целые, от 0 | да |
| `type` | string | `floor` \| `wall` \| `water` \| `door` | да |
| `revealed` | boolean | — | да |
| `material` | string | `stone` `wood` `earth` `grass` `sand` `metal` `marble` `ice` | да |
| `variant` | number | 0…5 | да |
| `pattern` | string | `small-room` `great-hall` `keep` `courtyard` `crypt` `cave-cluster` `village` `bridge` `natural` | да |
| `edge_mask` | string | подпоследовательность `nesw` | да |
| `feature` | string ≤ 40 | декор из `featuresFor`, либо **сущность** — см. §4 | нет |

Размер ограничен на входе: `width × height ≤ 500` (`dynamic-map.mjs:144`).

## 2. Четыре разных представления одной клетки

Это главный риск M0: контракт клетки не один, их четыре, и они расходятся по
набору полей. Менять придётся все четыре согласованно.

| Граница | Где | Поля | Что делает с лишними |
| --- | --- | --- | --- |
| Внутреннее состояние | `dynamic-map.mjs`, `state.scene.cells` | все 8 | — |
| Проекция игроку | `viewer-projection.mjs:75` `publicCellFor` | все 8, но `feature` — **только если `revealed === true`** | молча отбрасывает неизвестные |
| Вход сборщика стычек | `encounter-assembler.mjs:268` `validateScene` | **только** `x` `y` `type` `revealed` `feature` | **бросает** `UNEXPECTED_SCENE_CELL_FIELD` |
| Память локаций | `adventure-director.mjs:36` `normalizedSceneCells` | `x` `y` `type` `revealed` + опциональные `feature` `material` `variant` `pattern` `edge_mask` | молча отбрасывает |

Дополнительно `encounter-assembler` сужает `feature` до закрытого списка
`CELL_FEATURES` (строка 210) и запрещает дублирующиеся координаты
(`DUPLICATE_SCENE_CELL`). Лимит на длину массива — 500 клеток
(`maximum_scene_cells`), тот же лимит стоит в `publicCellFor` (`slice(0, 500)`)
и в `normalizedSceneCells` (`slice(0, 500)`).

## 3. Таблица потребителей

`Ч` — чтение, `З` — запись в `scene.cells`.

| Файл | Строки | Ч/З | Что именно | Сетка |
| --- | --- | --- | --- | --- |
| `rules-engine.mjs` | 1042, 1614, 2740, 5999, 6016, 6304, 6306, 6929, 6936 | Ч + **З** | проходимость, размещение, раскрытие, сущности в `feature` | разреженная |
| `index.mjs` | 1146, 1196, 2227, 2667 | Ч | счётчики для трассы, вход `assembleEncounter`, вывод ширины/высоты | 2667 выводит плотность |
| `viewer-projection.mjs` | 101 | Ч | проекция клеток игроку | разреженная |
| `adventure-director.mjs` | 117 | Ч | копия карты в `state.locationMaps` | разреженная |
| `encounter-assembler.mjs` | 272 | Ч | валидация входной сцены | разреженная |
| `npc-controller.mjs` | 110 | Ч | клетки-кандидаты для хода NPC | разреженная |
| `npc-turn-scheduler.mjs` | 148 | Ч | то же, детерминированная политика | разреженная |
| `autonomous-campaign.mjs` | 82 | Ч | нераскрытые `floor`/`door` для исследования | разреженная |
| `autonomous-orchestrator.mjs` | 70 | Ч | то же, исполнение намерения | разреженная |
| `campaign-loop-policy.mjs` | 180 | Ч | счётчик раскрытых клеток | разреженная |
| `free-action-adjudication.mjs` | 161 | Ч | счётчик раскрытых клеток в digest | разреженная |

**Плотную сетку не ожидает никто.** Каждый потребитель либо фильтрует массив,
либо строит `Map` по ключу `"x,y"`. Единственное исключение — `index.mjs:2667`,
который *выводит* ширину и высоту как `max(x) + 1` и `max(y) + 1`; это
производная величина для трассы, а не требование к хранению.

## 4. Запись сущности в `cell.feature` — два места

Оба в `server/rules-engine.mjs`, оба внутри применения событий. Это то самое
смешение декора и сущностей, ради которого затевается M0.

**`rules-engine.mjs:6936` — `EntitySpawned`:**

```js
if (Array.isArray(state.scene?.cells)) state.scene.cells = state.scene.cells.map((cell) =>
  cell.x === entity.x && cell.y === entity.y ? { ...cell, feature: entity.kind, revealed: true } : cell)
```

`entity.kind` пишется в то же поле, где лежит декор (`table`, `rock`, `stairs`).
Побочный эффект: появление сущности **безусловно раскрывает клетку**. Декор,
который там был, теряется безвозвратно — восстановить его после ухода сущности
нечем.

**`rules-engine.mjs:6304-6306` — падение врага:**

```js
if (isEnemyActor(state, target) && Array.isArray(state.scene?.cells)) {
  const position = actorPosition(state, target)
  if (position) state.scene.cells = state.scene.cells.map((cell) =>
    cell.x === position.x && cell.y === position.y && cell.feature === 'enemy' ? { ...cell, feature: undefined } : cell)
}
```

Снимается только литерал `'enemy'`. Если `EntitySpawned` записал другой `kind`,
метка останется на клетке после смерти сущности. Отдельно: здесь пишется
`feature: undefined`, то есть **ключ остаётся в объекте** — после сериализации в
`storage/` он исчезает, и в памяти форма клетки отличается от формы после
перезагрузки.

Остальные две записи сущностей не касаются и меняют только `revealed`:

- `rules-engine.mjs:6016` — расстановка отряда после перехода сцены;
- `rules-engine.mjs:6929` — событие `AreaRevealed`.

## 5. Что важно учесть в M0

1. **Разреженность уже везде.** Переход на явный разреженный формат ничего не
   ломает; переход на плотный, наоборот, потребует материализовать пропуски.
2. **Четыре набора полей, а не один.** `encounter-assembler.validateScene` —
   самая жёсткая граница: она **падает** на незнакомом поле клетки, а не
   игнорирует его. Любое новое поле нужно добавлять туда же, иначе
   `index.mjs:2227` и `rules-engine.mjs:1614` начнут бросать
   `UNEXPECTED_SCENE_CELL_FIELD`.
3. **`feature` перегружен.** Пока в одном поле живут декор и сущность, «убрать
   сущность» и «убрать декор» неразличимы. Разделение полей — единственное
   место, где придётся тронуть reducer, и именно оно требует миграции.
4. **Скрытие `feature` — часть модели видимости**, а не косметика:
   `publicCellFor` отдаёт `feature` только на раскрытой клетке. Сторож —
   `test/viewer-projection.test.mjs`.
5. **Лимит 500 клеток продублирован в четырёх местах** (`dynamic-map.mjs:144`,
   `encounter-assembler.mjs:7`, `viewer-projection.mjs:101`,
   `adventure-director.mjs:43`). Менять — только все сразу.
6. **`index.mjs:2667` обращается к `transition.scene.cells` без `?.`** и считает
   `Math.max(...)` по массиву. На пустом массиве это даёт `-Infinity`, на
   отсутствующей сцене — исключение. M0 меняет выход генератора, поэтому этот
   путь стоит перепроверить.

## 6. Сохранённые данные

`scene.cells` попадает на диск двумя путями: в состоянии кампании и в
`state.locationMaps` (`adventure-director.mjs:105`, запись `{ version: 1, cells }`).
У записи карт локаций **уже есть поле `version`**, у самой `scene.cells` — нет.
Это даёт готовую точку для миграции карт локаций и подтверждает, что для
`scene.cells` версию придётся вводить.
