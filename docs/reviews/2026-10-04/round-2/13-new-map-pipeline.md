# Второй проход: новый конвейер карт, scene dressing и 2D/3D-проекция

Аудит выполнен по baseline `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7`
(`origin/main`, 4 октября 2026). Первый обзор карт и AI был закреплён на
`c7efdca614cc33f706258d036e86f01c1f189404`; этот проход проверяет изменения
между этими SHA: `scene-dressing`, новые проверки качества и программы сцены,
футпринты предметов и последние 2D/3D-изменения. Runtime, `storage/`, `.env`,
`data/` и рабочие сохранения не менялись.

Проверены [AI и карты первого прохода](../05-ai-world-and-maps.md),
[сравнение похожих проектов](../01-comparable-projects.md), новые тесты
`scene-dressing`, `scene-program-layout`, `map-quality`, `prop-placement`,
`settlement-generator`, `scene-entry-road`, а также seeded-прогоны генератора.
Повторяемая проба находится в
[`new-map-pipeline-probe.mjs`](./new-map-pipeline-probe.mjs):

```powershell
node docs/reviews/2026-10-04/round-2/new-map-pipeline-probe.mjs
```

Она сознательно фиксирует поведение baseline, поэтому её assertions не следует
превращать в постоянный CI-gate без замены ожидаемого результата после исправления.

## MAP-13-01 — P2 — запрошенный dressing теряется на минимальной открытой карте

Тип: подтверждённый low-level gap; уверенность высокая; воспроизводится через
полный `generateSceneGeometry`, но это ещё не доказательство расхождения с
Narrator-ом в живом turn.

`buildThemedScene` переводит все слова `руин`, `развалин`, `древн`, `пепелищ`
и похожие в `ruinsAsked` ([`scene-themes.mjs#L1413-L1415`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-themes.mjs#L1413-L1415)). В открытой местности затем вызывается
`placeRuinsField` ([`scene-themes.mjs#L1808-L1811`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-themes.mjs#L1808-L1811)). Функция правильно делает минимум один заказанный
попыткой, но `placeRuins` требует свободную рамку вокруг остова, радиус шесть
клеток от входа и свободную землю; на карте 16×16 такой участок часто не
существует. Возврат `placed` игнорируется, поэтому результат возвращается без
`missing_dressing` или warning
([`scene-dressing.mjs#L669-L683`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-dressing.mjs#L669-L683)).

Probe с
`location=Поляна`, `theme=лес`, `description=Древние руины разрушенной заставы`,
`seed=ruins-16-0`, `width=height=16` получает `requested: true`, но
`placed: 0`. Размер 16×16 принимается основным `generateSceneGeometry` (нижняя
граница `integer(..., 16, ...)`), поэтому это не только внутренний вызов
низкоуровневого builder-а. При этом `sceneMapRequirementsFor` не считает
«руины» структурированным обязательным item, и probe не доказывает, что этот
cue попадает в brief Narrator-а как обещание.

Минимальное направление:

1. Если `asked=true`, сначала искать уменьшенный допустимый фрагмент развалин
   или ослаблять только дистанцию до входа/внешнее кольцо, сохраняя spawn,
   двери и достижимость. Нельзя просто поставить глухую рамку поверх входа.
2. Возвращать из dressing структурированный `missing_dressing` с ID рецепта и
   причиной (`NO_FIT`, `NO_FREE_ZONE`), если продукт считает текстовый cue
   обязательным. Caller сможет отдельно решить, включать ли его в brief.
3. Добавить корпус размеров 16×16, 20×20 и 26×26 с обязательной руиной,
   проверкой `auditTacticalMap` и сохранением spawn/roads. Acceptance — названная
   руина либо явно попадает в `missing_dressing`, но не исчезает молча.

## MAP-13-02 — P2 — описание сцены не участвует в топологии моста и режима лагеря

Тип: подтверждённый generator/caller gap; уверенность высокая; воспроизводится
через полный `generateSceneGeometry`, но не объявляется потерей механического
обещания: текущий `sceneMapRequirementsFor` не знает bridge/camp topology.

Полное `sceneText` уже содержит `description` и используется виньетками
([`scene-themes.mjs#L1413-L1415`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-themes.mjs#L1413-L1415)), а `description` действительно передаётся из
`generateSceneGeometryFor` в `buildThemedScene`
([`adventure-director.mjs#L421-L440`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/adventure-director.mjs#L421-L440)). Однако открытая ветка заново строит
`placeText` только из `location` и `theme`, после чего по нему вычисляет
`chasmScene`, `bridgeScene`, `pondScene` и `campScene`
([`scene-themes.mjs#L1772-L1776`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-themes.mjs#L1772-L1776)).

Проба ниже идёт через полный `generateSceneGeometry` с `useLibrary: false`;
это не только прямой вызов тематического builder-а. Для description-only
входа `sceneMapRequirementsFor` возвращает `null`; ручной structured item
`platform` создаёт деревянные клетки, но не восстанавливает `crossing`.

Probe на одном и том же seed показывает:

| Ввод | Наблюдаемая карта |
| --- | --- |
| `location=Поляна`, `theme=лесная поляна`, `description=Мост через ущелье…` | `theme-forest`, `crossing_cells=0` |
| те же location/theme, `description=Разбитый лагерь разбойников` | `scout_tent=0`, `bedroll_cluster=0`; остаётся только малая виньетка |
| контроль: `location=Мост через ущелье`, `theme=дорога` | `crossing_cells=9` |
| контроль: `location=Лагерь разбойников`, `theme=лес` | `scout_tent=1`, `bedroll_cluster=9` |
| `sceneMapRequirementsFor('Мост через ущелье…')` | `null` |
| тот же description с `program: platform` | `crossing_cells=0`, но деревянные клетки настила появляются |

Таким образом, description уже доходит до полного caller-а, но генератор строит
обычный лес, а структурированный repair знает только о `platform`, не о
переправе через ущелье или лагере. Виньетки частично
скрывают проблему: они читают `sceneText`, поэтому мелкий костёр/скатка могут
появиться, однако структурная топология и набор лагерных props не включаются.

Минимальное направление — вычислять эти четыре cue из единого локального
`sceneText` (location + theme + description), а затем отдельно нормализовать
отрицания и конфликтующие фразы. Прямое добавление `description` в регулярное
выражение без слоя смысла уже известно как источник ложных срабатываний
(`«телеги не было»` ставит телегу; это ограничение зафиксировано в
`docs/known-limitations.md`). Для acceptance нужны положительные пары
«описание-only» и отрицательные пары «нет моста/лагеря», плюс контроль того, что
`crossing` сохраняет проходность, spawn и дороги.

## MAP-13-03 — P2 — authored-карта намеренно пропускает dressing; интеграционная граница не проверена

Тип: подтверждённое ограничение конструкции; гипотеза о влиянии на Narrator
требует отдельной проверки brief/HTTP caller.

`buildThemedScene` возвращает новую копию authored-карты до всех вызовов
`placeVignettes`, `roughenGround` и `placeRuinsField`
([`scene-themes.mjs#L1426-L1429`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/scene-themes.mjs#L1426-L1429)). Probe для
`tides-whisper-forest` с описанием «Остывшее кострище и следы лагеря» получает
`authored-tactical-scene`, `vignette_props=0`, `campfires=0`; каталог после
этого не мутируется (`source_unchanged=true`). Сохранение authored props —
разумная защита авторского контура. Не проверено, считает ли production caller
текстовую виньетку обещанием Narrator-а, поэтому это пока интеграционная
гипотеза, а не подтверждённый visibility defect.

Нужно выбрать один из двух явных контрактов: либо authored-карта имеет режим
`fixed_dressing`, и генератор/brief помечают сюжетные decoration cues как
неисполняемые; либо для явно названных безопасных виньеток разрешается второй
проход с collision/audit и bounded budget. В обоих вариантах исходная запись
каталога должна оставаться immutable.

## Влияние последних 2D/3D изменений на прежние UI-наблюдения

UI-05 из [первого отчёта](../04-client-and-rendering.md) остаётся гипотезой и
становится более заметной на новых картах: `propsInTile` каждый раз вызывает
`visiblePropsOnBoard`, а тот фильтрует весь `map.props`
([`board-render.ts#L685-L700`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/board-render.ts#L685-L700)). Новая расстановка даёт примерно 250–312 props на больших
поселениях, поэтому один paint сканирует тот же массив по числу видимых тайлов.
Это аргумент для counters/профиля и tile index, но не измеренное торможение.

UI-06 также остаётся гипотезой: preview области по-прежнему создаёт Mesh на
клетку в [`TacticalBoard3D.tsx#L536-L570`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/TacticalBoard3D.tsx#L536-L570); новые GLB/штампы предметов этот код не батчат. UI-03 и UI-04 новые изменения не затрагивают.

UI-07 остаётся отрицательным finding: `autoReset=false` сопровождается явным
`renderer.info.reset()` на границе pipeline
([`src/board3d-graphics.ts#L268-L365`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/src/board3d-graphics.ts#L268-L365)); новые палитры, рельеф и модели не дают оснований возвращать эту гипотезу в список дефектов.

## Положительные проверки и границы

- Один и тот же seed и вход дают одинаковую сериализацию карты; новые тесты
  scene dressing также это проверяют.
- Футпринты виньеток и развалин проходят локальный `auditTacticalMap`; новые
  сцены сохраняют свободный spawn, двери и проходы в штатном корпусе.
- `node --test test/scene-dressing.test.mjs test/map-quality.test.mjs
  test/scene-program-layout.test.mjs test/settlement-generator.test.mjs
  test/scene-entry-road.test.mjs test/prop-placement.test.mjs` — **86 passed,
  0 failed**.
- `pnpm maps:preview -- --preset all --audit` — **все эталонные сцены чисты**.
- `node docs/reviews/2026-10-04/round-2/new-map-pipeline-probe.mjs` — exit 0;
  вывод содержит три подтверждённых baseline-сценария и проверку отсутствия
  мутации authored source.

Эти проверки не заменяют браузерный прогон 2D/3D, GPU benchmark, live-LLM
оценку или полный `pnpm verify`; их следует выполнить root после объединения
всех отчётов. Срез сравнивает именно pinned baseline `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7`; последующие изменения main сюда не
переносятся автоматически.
