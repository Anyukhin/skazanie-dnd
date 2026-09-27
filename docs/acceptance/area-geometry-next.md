# Кандидат следующей геометрии круглых областей

Исторический кандидат. 24 сентября заменён реализацией с аналитическим
вычислением площади и общим модулем `server/circular-area-geometry.mjs`.
Два пилота подключены в рабочей ветке; актуальные проверки и границы —
в [wave10](wave10-2026-09-24.md). Описанный ниже Temp-патч не применять
поверх новой реализации.

Ветка после PR #85 сохраняет legacy-геометрию sphere/cylinder как клеточный
Chebyshev-radius. Для `radius: 5` она возвращает 3×3 клетки. Это удобный
legacy baseline, но не независимое правило D&D 2014.

Первичные правила задают другую основу:

- [D&D 2014 Spellcasting: Areas of Effect](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/spellcasting#AreasofEffect)
  определяет sphere радиусом от точки происхождения и cylinder кругом заданного
  радиуса с отдельной высотой.
- [D&D 2014 Combat: Variant Playing on a Grid](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/combat#PlayingOnAGrid)
  задаёт квадрат 5 футов, движение по клеткам, диагонали, углы и дальность;
  эти правила не заменяют круг квадратом.
- [DMG 2014: Areas of Effect](https://www.dndbeyond.com/sources/dmg/running-the-game#AreasofEffect)
  задаёт перевод области на сетку: origin выбирается на пересечении, а для
  круговой области клетка затрагивается при покрытии не менее половины её
  площади.

## Изолированный patch-кандидат

Кандидат находится в `%TEMP%` и не меняет рабочее дерево:

`C:\Users\anton\AppData\Local\Temp\skazanie-circular-geometry-v2-20260923`

24 сентября исходники кандидата и patch-файлы также сохранены вне Temp:
`C:/Users/anton/.codex/backups/skazanie-circular-geometry-v2-20260924/`.
Рядом `index.json` с размерами и SHA-256; build-каталоги не копировались.

Файлы:

- `shared/circular-area-geometry.mjs` — чистый rasterizer с адаптивным
  интегрированием площади пересечения круга и клетки;
- `area-geometry.ts` — кандидатный client adapter с веткой
  `geometryVersion: 'circle-grid-v2'`, legacy fallback остаётся прежним;
- `server/rules-engine.mjs` — кандидатные точки подключения для server owner:
  `positionInArea`, `positionInEffect`, `areaCellsOf`, point-area targeting и
  запись новой геометрии в новые события;
- `circular-area-geometry.test.mjs` — независимые ручные эталоны и проверки
  совместимости;
- `area-geometry.patch`, `rules-engine.patch`, `shared-module.patch`,
  `shared-types.patch`, `client-types.patch`, `candidate-test.patch` — diff
  кандидата для ревью.

Проверка кандидата:

```text
node --test C:\Users\anton\AppData\Local\Temp\skazanie-circular-geometry-v2-20260923\circular-area-geometry.test.mjs
6/6 passed
node --check ...\shared\circular-area-geometry.mjs
node --check ...\server\rules-engine.mjs
```

## Ручные эталоны

Координаты ниже — клетки относительно origin-пересечения `(0,0)`. Символ `#`
означает клетку, покрытую кругом минимум на 50%; строки идут сверху вниз.
Ожидания записаны вручную и не вычисляются rasterizer-ом.

| Радиус | Эталон строк | Клеток |
| ---: | --- | ---: |
| 5 фт | `## / ##` | 4 |
| 10 фт | `.##. / #### / #### / .##.` | 12 |
| 20 фт | `..####.. / .######. / ######## / ######## / ######## / ######## / .######. / ..####..` | 52 |
| 30 фт | `....####.... / ..########.. / .##########. / .##########. / ############ / ############ / ############ / ############ / .##########. / .##########. / ..########.. / ....####....` | 112 |

Для radius 5 круг занимает четыре квадрантные клетки вокруг пересечения.
Текущие 9 клеток — это квадрат `[-1..1] × [-1..1]`; он не совпадает с этим
круговым эталоном. При сравнении важно учитывать и смену положения origin:
переход от центра клетки к пересечению меняет не только край области.

## Версионирование и origin mapping

Новая семантика не должна менять старые replay-события. Предлагается:

```text
legacy-grid-v1       // отсутствие поля или явное значение; текущий Chebyshev
circle-grid-v2       // circle-cell coverage >= 50%, origin на пересечении
```

Для новых point-area cast-событий сервер после проверки команды сохраняет:

```json
{
  "area_geometry_version": "circle-grid-v2",
  "area_grid_origin": { "x": 7, "y": 4 }
}
```

Для persistent `SpellAreaCreated` используется аналогичная пара полей
`geometry_version` и `grid_origin`. Если поля отсутствуют, reducer и
`positionInEffect` используют legacy-v1. Старые события и сохранённые области
не мигрируются автоматически.

Текущий UI выбирает клетку `(x,y)`, а не произвольную точку. До появления
интерактивного выбора пересечения применяется детерминированное правило
`gridOriginForTargetCell`: выбранная клетка `(x,y)` отображается как origin
на её северо-западном пересечении `(x,y)`. Preview обязан рисовать crosshair
на этом пересечении и показывать выбранную клетку как часть области. Это
устраняет скрытое округление и позволяет позднее добавить выбор любого из
четырёх соседних пересечений без изменения server contract.

Для self-origin сфер/цилиндров rollout должен отдельно определить anchor
актора и крупную площадь. Кандидат намеренно не угадывает несколько origin-ов
для крупного существа.

## Что ещё нужно перед применением

1. Принять `circle-grid-v2` как отдельную версию geometry и выбрать первые
   пилоты (например, Fireball, Fog Cloud, Spirit Guardians) без изменения
   legacy campaigns.
2. Добавить server-side validation: версия и origin выводятся сервером из
   spell profile и выбранной клетки; клиент не может прислать произвольный
   размер или origin.
3. Согласовать LoE от grid intersection с клеточной картой, особенно у стен,
   закрытых углов и крупных фигур.
4. Добавить HTTP/SSE/replay проверки новых полей, затем отдельный browser pass
   через CUA с 2D/3D preview. На этой проверке доступен Codex In-app Browser
   (CUA state: browser id `1`, вкладок на момент аудита нет); fallback browser
   automation не использовался.
5. Только после пилота обновить зависимые spell profiles и acceptance matrix.

Никакие production-файлы, persistent data или event schemas в этой проверке не
изменялись.
