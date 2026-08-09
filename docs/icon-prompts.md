# Промпты для иконок боевых действий

Единый файл для генерации изображений. Порядок работы: Codex генерирует по
промптам отсюда → Клод ревьюит результат → правим промпты и перегенерируем то,
что не легло.

## Зачем

В интерфейсе двадцать пять иконок на весь каталог: `action-atlas-v1.webp` — атлас
5×5, а нужная клетка выбирается по смыслу названия регуляркой. Поэтому Огненный
шар, Огненный снаряд и Огненная стена показывались одной картинкой огня.

Нужно **по картинке на действие**. Всего 532: 439 заклинаний каталога и 93 боевых
действия классов и общего набора.

## Технический контракт

Соблюдать обязательно — иначе картинка не встанет в интерфейс.

| Параметр | Значение |
|---|---|
| Формат | PNG с прозрачностью (альфа-канал) |
| Размер | 512×512, строго квадрат |
| Фон | **Полностью прозрачный.** Ни чёрной плашки, ни рамки — тайл рисует CSS |
| Имя файла | `<id>.png`, где `<id>` — идентификатор из заголовка промпта, буква в букву |
| Куда класть | `public/assets/ui/action-icons/` |

После добавления файлов нужно объявить их в реестре прав и пересобрать список:

```bash
pnpm icons:manifest
```

Реестр `data/asset-rights.json` требует хеш и размер каждого файла под
`public/assets`; без записи `content:verify` падает с `ASSET_REGISTRY_DRIFT`.

## Фон и символ — два независимых слоя

Прозрачный PNG остаётся исходником способности и не получает собственную
подложку. `CombatIcon` кладёт его поверх одного из шести переиспользуемых WebP
256×256 из `public/assets/ui/action-backgrounds/`:

- `martial` — физические атаки и классовые боевые приёмы;
- `arcane` — стихийная и чистая магия;
- `divine` — лечение, свет, паладинские и жреческие силы;
- `nature` — природа, звери, растения, яд и стихии земли/воды/ветра;
- `shadow` — скрытность, проклятия, некротика и психические эффекты;
- `utility` — движение, реакции и нейтральные служебные действия.

Тема выбирается детерминированно по `kind`, `id` и подсказке действия. Поэтому
новый прозрачный рисунок автоматически получает рамку и подходящую панель, а
замена фона не требует пересобирать 532 индивидуальных PNG. Фон и символ должны
оставаться раздельными: это сохраняет маленький размер репозитория и позволяет
переиспользовать один рисунок в разных интерфейсных размерах.

## Стиль: предметная живопись старого фэнтези-атласа

Эталон лежит рядом с индивидуальными файлами:
`public/assets/ui/action-icons/action-atlas-v1.webp`. Нужен тот же визуальный
язык, что у его 25 клеток: **нарисованный вручную фэнтезийный предмет или эффект,
состаренные материалы, тёплый направленный свет, тёмные контуры и сдержанная
палитра с одним смысловым акцентом**.

Референс задаёт обработку предмета, но не компоновку файла. В индивидуальном PNG
нет квадратной плашки, бронзовой рамки и угловых заклёпок: их уже рисует
`.combat-icon` в CSS. Иначе в интерфейсе получится двойная рамка.

**Общая часть, добавляется к каждому промпту** (ниже обозначена как `[СТИЛЬ]`):

> Hand-painted dark-fantasy tabletop RPG inventory icon, matching the rendering
> language of `action-atlas-v1.webp`: tangible illustrated materials, warm
> directional highlights, dark carved contours, restrained weathering, muted
> old-master palette with one clear semantic colour accent. Exactly one centered
> visual concept with a bold compact silhouette and no cropping. Fully
> transparent background; no square tile, no dark plate, no frame, no border,
> no corner ornaments, no medallion, no scenery, no text, no letters, no
> numbers, no watermark. Not photorealistic, not glossy 3D, not flat vector art,
> not a neon glyph or rune. Readable as a 32-pixel thumbnail. The opaque
> subject's longest dimension spans 82 to 88 percent of the 512-pixel canvas,
> centered with balanced margins.

### Цвет следует предмету и эффекту

Школа магии остаётся метаданными карточки, но больше не перекрашивает всю иконку
в один обязательный цвет. Палитра выбирается по изображённому эффекту:

- огонь — угольный красный, оранжевый, охра, бледно-жёлтый жар;
- лёд и чистая магия — стальной синий, фиолетовый кристалл, серебристый свет;
- лечение и жизненная сила — кожа, лен, приглушённый красный, тёплое золото;
- природа и призыв — дерево, камень, мох, сдержанный изумрудный;
- защита и физические действия — сталь, бронза, кожа, дерево;
- скрытность и удержание — чернёный металл, тёмная ткань, небольшой багровый
  или фиолетовый акцент.

Цветовой акцент помогает чтению, но материал и силуэт важнее школьного кода.

### Чего в этом стиле быть не должно

- собственной тёмной подложки, рамки, медальона или угловых украшений;
- неоновых линий, рун, плоских векторных знаков и равномерного свечения;
- фотореализма, глянцевого 3D и современного mobile-game render;
- более одного главного предмета и одного простого вторичного мотива;
- мелкой россыпи искр, дыма и декора у краёв холста;
- текста, букв, цифр, читаемых надписей;
- деталей, которые исчезают при уменьшении до 32 пикселей.

## Приёмка идёт по 32 пикселям, а не по 512

Главный урок первого пилота: генератор выдаёт прекрасные картинки в полный
размер, которые в реальном размере превращаются в цветное пятно. Красота
исходника ничего не значит — иконка живёт в 34 и 27 пикселях.

Отсюда пять требований, которые важнее художественности:

1. **Один главный предмет или эффект.** Допустим один простой вторичный мотив:
   сердце в ладони, цепь на запястье, ветер вокруг сердца. Россыпь равноправных
   деталей в 32 пикселях сливается в пятно.
2. **Крупный слитный силуэт.** Предмет узнаётся по внешнему контуру раньше, чем
   зритель замечает фактуру металла, ткани или огня.
3. **Фактура не заменяет форму.** Царапины, швы и блики поддерживают материал,
   но не несут смысл в одиночку и могут исчезнуть при уменьшении.
4. **Контраст с тёмно-коричневым тайлом** (`#2a221a`). Тёмный знак пропадёт.
5. **Одинаковый масштаб предмета.** Самая длинная сторона непрозрачной области —
   82–88% холста. Для высокой ладони это высота, для огненной стены — ширина.
   Предмет центрирован, противоположные поля сбалансированы.

Как проверяю: скриптом собираю контактный лист — каждую иконку ужимаю до 32 px
усреднением по блоку, кладу на тайл цвета интерфейса, увеличиваю без сглаживания.
Плюс декодирую PNG и считаю границы непрозрачной области.

---

## Пилот: двенадцать иконок

Генерируем сначала **только эти двенадцать**. Они покрывают весь диапазон: три
огненных заклинания подряд (проверка на различимость близких эффектов), магию с
разными материалами и четыре физических действия (проверка предметного языка).

После пилота — ревью, правка, и только потом остальные 520.

| № | Файл | Что это | Школа / тип | Основной образ |
|---|---|---|---|---|
| 1 | `fireball.png` | Огненный шар | Воплощение | сферический клубок огня |
| 2 | `fire-bolt.png` | Огненный снаряд | Воплощение | горящий наконечник |
| 3 | `wall-of-fire.png` | Огненная стена | Воплощение | широкая полоса пламени |
| 4 | `cure-wounds.png` | Лечение ран | Воплощение | перевязанная ладонь и сердце |
| 5 | `magic-missile.png` | Волшебная стрела | Воплощение | три кристальных дротика |
| 6 | `shield.png` | Щит | Ограждение | стальной щит с ударом |
| 7 | `conjure-animals.png` | Призыв животных | Вызов | лесной тотем-след |
| 8 | `hold-person.png` | Удержание личности | Очарование | скованная каменная ладонь |
| 9 | `dash.png` | Рывок | действие | две подошвы в движении |
| 10 | `ready-action.png` | Готовность | действие | песочные часы |
| 11 | `sneak-attack.png` | Коварная атака | умение | кинжал из складки плаща |
| 12 | `second-wind.png` | Второе дыхание | умение | сшитое сердце и поток воздуха |

Три первых иконки намеренно используют одну огненную палитру. Они обязаны
различаться не цветом, а формой: круглый шар, диагональный снаряд, широкая стена.

---

### 1. `fireball.png` — Огненный шар

> One compact spherical ball of living flame: a dense orange-red fiery orb with
> several broad curling flame tongues wrapping around it and a hot pale-yellow
> core. It must read as a ROUND EXPLOSIVE FIREBALL, not a sun symbol, arrow, or
> wall of fire. Palette: ember orange, scarlet, warm gold, pale fire-yellow
> highlights, and dark burnt-red internal shadows.
> [СТИЛЬ]

### 2. `fire-bolt.png` — Огненный снаряд

> One compact magical projectile flying diagonally from lower left to upper
> right: a sharp forged-bronze arrowhead wrapped in a short red-orange flame
> trail, with three broad trailing streaks. It must read as ONE FAST FLAMING
> BOLT, singular and directional, not a round fireball or normal wooden arrow.
> Palette: ember orange, scarlet, warm gold, dark iron-bronze, pale fire-yellow
> highlights.
> [СТИЛЬ]

### 3. `wall-of-fire.png` — Огненная стена

> One wide low barrier made of five large connected upright tongues of flame
> rising from a short scorched stone base. The flames form a coherent horizontal
> wall with an unmistakably blocking silhouette, not a ball, projectile, bonfire,
> or separate candles. Palette: ember orange, scarlet, ochre and pale
> fire-yellow; dark weathered stone only at the base.
> [СТИЛЬ]

### 4. `cure-wounds.png` — Лечение ран

> One weathered human hand wrapped with a broad linen bandage across the palm,
> gently cupping a small warm red-gold heart-shaped healing ember. The hand and
> heart form one compact silhouette. It must read as PHYSICAL WOUNDS BEING
> TENDED, not an attack or religious emblem. Palette: aged parchment skin,
> beige linen, muted crimson heart, warm golden healing highlights.
> [СТИЛЬ]

### 5. `magic-missile.png` — Волшебная стрела

> Exactly three slender arcane darts arranged in a tight fan and all pointing
> upper right. Each dart is a small faceted violet-blue crystal arrowhead with a
> short pale magical trail. Exactly three, evenly separated and countable at
> 32 px. It must read as A COUNTED MAGICAL VOLLEY, not one arrow. Palette:
> desaturated violet crystal, steel-blue, pale lavender-white highlights, small
> antique-gold accents.
> [СТИЛЬ]

### 6. `shield.png` — Щит

> One broad, slightly battered medieval heater shield shown frontally, forged
> from dark blued steel with a thick aged bronze rim. A fresh bright impact
> gouge and a small cluster of three angular golden sparks strike the upper-left
> edge. It must read as A HARD BARRIER TAKING A HIT. Palette: dark blued steel,
> tarnished bronze, warm gold impact highlight.
> [СТИЛЬ]

### 7. `conjure-animals.png` — Призыв животных

> One large stylised wolf paw print made as a tangible carved forest talisman:
> four broad toe pads and one central pad, weathered brown stone or wood edged
> with moss-green magical light, with three short curling green wisps rising
> from behind it. One paw only, no animal body, pack, or fine fur. It must read
> as A SUMMONED BEAST. Palette: weathered umber, moss green, muted emerald
> highlights.
> [СТИЛЬ]

### 8. `hold-person.png` — Удержание личности

> One upright weathered stone hand and wrist tightly locked by a heavy dark-iron
> shackle around the wrist, with a short taut chain crossing the palm. Fingers
> together, rigid pose, compact silhouette. It must read as A PERSON FORCEFULLY
> IMMOBILISED, not a waving hand or weapon. Palette: pale worn stone, blackened
> iron, small violet-magenta binding accents.
> [СТИЛЬ]

### 9. `dash.png` — Рывок

> Two worn leather boot sole prints angled from lower left toward upper right,
> the rear print smaller, accompanied by three broad ochre speed scratches
> swept backward. Make a single compact directional cluster. It must read as
> RAPID FORWARD MOVEMENT, not standing feet. Palette: cracked tan leather, dark
> brown tread, muted amber-gold motion accents.
> [СТИЛЬ]

### 10. `ready-action.png` — Готовность

> One sturdy antique bronze hourglass shown frontally, with thick
> wooden-bronze posts and pale sand visibly suspended at the narrow waist rather
> than fully fallen. Two small taut golden glints flank the waist. It must read
> as WAITING AT THE CRITICAL MOMENT, not a potion or lantern. Palette: aged
> bronze, dark walnut, cloudy glass, pale parchment-gold sand.
> [СТИЛЬ]

### 11. `sneak-attack.png` — Коварная атака

> One narrow blackened-steel dagger angled steeply downward, its upper half
> emerging from and partly concealed by a single torn fold of dark
> charcoal-purple cloak. A small sharp crimson glint burns at the blade tip.
> The dagger and cloak form one compact silhouette. It must read as A BLADE
> STRIKING FROM CONCEALMENT, not a sword duel. Palette: blackened steel, worn
> dark purple cloth, aged bronze hilt, restrained crimson tip highlight.
> [СТИЛЬ]

### 12. `second-wind.png` — Второе дыхание

> One battered red leather heart emblem with visible stitched repairs, wrapped
> by a single broad pale-blue wind ribbon that curves upward and opens at the
> top. The heart remains dominant; the ribbon suggests breath and renewed
> momentum. It must read as PERSONAL STRENGTH RETURNING, distinct from medical
> bandaging. Palette: worn oxblood-red leather, aged gold stitches, pale
> desaturated blue-white wind ribbon, warm bronze edging.
> [СТИЛЬ]

---

## Что проверю на ревью

1. **Различимость.** Шар, снаряд и стена огня рядом в 32 px — разные силуэты?
2. **Прозрачность.** Нет ли чёрной подложки, которая перекроет тайл.
3. **Масштаб.** Самая длинная сторона непрозрачной части — 82–88% холста.
4. **Читаемость в 32 px** на контактном листе.
5. **Единство набора.** Одинаковая манера кисти, контур, состаренность материалов
   и направление света.
6. **Формат и имя.** PNG, 512×512, альфа, имя точно равно идентификатору.

## Полный набор

Пилотный стиль распространён на остальные 520 иконок. Итоговый каталог содержит
532 отдельных PNG: 439 заклинаний и 93 действия. Школа магии использовалась
только для разбиения генерации на партии; палитра по-прежнему следует
конкретному предмету или эффекту.

Каждый итоговый файл прошёл chroma-key removal, нормализацию масштаба,
технический QA и визуальную проверку анатомии, геометрии, псевдотекста и
читаемости в 32 px. Полный отчёт и контакт-листы описаны в
`docs/icon-generation-checkpoint.md`.
