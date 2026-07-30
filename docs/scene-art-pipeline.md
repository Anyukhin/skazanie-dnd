# Иллюстрации сцен

Каталог атмосферных иллюстраций находится в `public/assets/scenes/`. Это
декоративный слой заголовка сцены: он не задаёт геометрию, координаты,
проходимость, видимость или скрытые факты мира. Авторитетной остаётся серверная
карта.

## Визуальный контракт

- 1280×512 WebP;
- широкая establishing-композиция, читаемая в невысоком заголовке;
- тёмное фэнтези, grounded materials, единая живописная фактура;
- окружение без персонажей и сюжетно значимых подсказок;
- без текста, рамки, логотипа, водяного знака, сетки и игровых фигур;
- оригинальная иллюстрация, а не копия опубликованного арта.

Исходники созданы 30 июля 2026 года встроенным ImageGen, по одному отдельному
вызову на файл. Результаты генератора имели размер 1983×793; в репозиторий
попали только приведённые через Pillow 11.1.0 файлы 1280×512 WebP (`quality
86`, Lanczos, центральный fit). Фактические SHA-256 и размеры зарегистрированы
в `data/asset-rights.json`. Общие `rights_status` и `distribution` реестра не
менялись: сгенерированный результат всё равно проходит общий release review.

## Общая основа промпта

Каждый отдельный блок из следующего раздела добавлялся к этой общей основе:

```text
Use case: stylized-concept
Asset type: wide game scene header illustration for a Russian dark-fantasy
tabletop campaign UI
Style/medium: premium hand-painted dark fantasy environment concept art,
grounded materials, subtle ink-and-gouache texture, original design
Composition/framing: very wide cinematic establishing shot, approximately 5:2
aspect ratio, strong center and edge readability when cropped to 1280×512, no
frame, no UI
Constraints: environment only; no text, letters, numbers, readable signs or
symbols, logo, watermark, border, map grid, game pieces, visible traps,
monsters, bodies, gore, branded or copyrighted imagery
Avoid: anime, cartoon, photoreal stock-photo look, bright neon, busy foreground
clutter, illegible darkness
```

## Промпт каждого файла

Ниже записаны индивидуальные части prompt. Вместе с общей основой выше они
образуют полный контракт каждой генерации.

### `building`

`building-01.webp`

```text
Primary request: an original medieval roadside inn interior at evening, warm
hearth, rough timber beams, long wooden tables, travel cloaks near the entrance,
rain visible through small windows; no characters and no story-critical clues
Lighting/mood: warm firelight against cool blue rain, welcoming but mysterious,
deep atmospheric perspective
Color palette: burnt amber, dark walnut, slate blue, muted moss
Materials/textures: worn timber, soot-darkened stone, iron fittings, damp glass
```

`building-02.webp`

```text
Primary request: an original medieval manor courtyard in steady evening rain,
timber gallery, stone well, lanterns under the eaves, wet cobbles and a closed
wooden gate; no characters and no story-critical clues
Lighting/mood: cool rainy dusk with restrained amber lantern pools, inhabited
yet quiet
Color palette: slate blue, wet charcoal, dark oak, muted amber
Materials/textures: rain-dark timber, rough stone, iron hinges, wet cobbles
```

### `temple`

`temple-01.webp`

```text
Primary request: an original ancient stone temple sanctuary at candlelit
twilight, tall columns, simple altar, faded wall mosaics, incense haze, shafts
of cold light from high narrow windows; no characters and no story-critical
clues
Lighting/mood: reverent, solemn, mysterious; warm candles against cool moonlight
Color palette: old ivory, muted gold, deep indigo, weathered bronze
Materials/textures: worn marble, cracked plaster, tarnished bronze, thin incense
smoke
```

`temple-02.webp`

```text
Primary request: an original ruined hilltop shrine at moonlit night, broken
colonnade, weathered altar stone, a few sheltered votive candles, wind moving
pale fabric, distant valley; no characters and no story-critical clues
Lighting/mood: sacred melancholy, cold moonlight with tiny warm candle accents
Color palette: moonlit gray, faded ivory, deep blue, muted brass
Materials/textures: eroded stone, cracked marble, old cloth, lichen
```

### `crypt`

`crypt-01.webp`

```text
Primary request: an original ancient underground crypt corridor, heavy stone
arches, sealed burial niches, low braziers, drifting dust, worn flagstones
disappearing into shadow; no characters and no story-critical clues
Lighting/mood: solemn and old, restrained ember glow, readable shadows
Color palette: charcoal stone, old bone, rust brown, dim amber
Materials/textures: rough masonry, soot, tarnished iron, dry dust
```

`crypt-02.webp`

```text
Primary request: an original vaulted burial chamber with several closed stone
sarcophagi, faded funerary reliefs, a dry reflecting basin, thin roots through
cracked ceiling stones; no characters and no story-critical clues
Lighting/mood: quiet, ancient, mournful; cool shaft of light and faint warm
braziers
Color palette: limestone gray, desaturated teal, umber, muted amber
Materials/textures: carved stone, dust, dry roots, oxidized metal
```

### `cave`

`cave-01.webp`

```text
Primary request: an original vast natural limestone cavern with a still
underground pool, layered stalactites and stalagmites, narrow ledges, subtle
mineral reflections; no characters and no story-critical clues
Lighting/mood: mysterious and serene, soft cold reflected light, deep but
readable space
Color palette: slate, desaturated turquoise, mineral gray, faint warm earth
Materials/textures: wet limestone, dark water, mineral deposits, mist
```

`cave-02.webp`

```text
Primary request: an original winding basalt cave chamber with high natural
arches, pale mushroom clusters, scattered rubble and a narrow stream, no
magical crystals; no characters and no story-critical clues
Lighting/mood: hushed subterranean mystery, dim natural blue-gray glow, readable
depth
Color palette: charcoal basalt, smoke gray, muted blue, earthy beige
Materials/textures: rough volcanic rock, damp stone, soft fungi, shallow water
```

### `forest`

`forest-01.webp`

```text
Primary request: an original ancient mixed forest at early dawn, massive oaks
and birches, fern-covered ground, fallen log, a faint natural path through mist;
no characters and no story-critical clues
Lighting/mood: quiet wonder with restrained unease, soft dawn rays through mist
Color palette: deep moss, silver birch, muted gold, cool fog blue
Materials/textures: bark, wet leaves, moss, fern, morning mist
```

`forest-02.webp`

```text
Primary request: an original dense conifer forest at blue twilight after rain,
dark pines, a small clearing, wet stones, low fog between trunks; no characters
and no story-critical clues
Lighting/mood: cool, watchful, atmospheric but readable
Color palette: pine black-green, slate blue, wet granite, faint silver
Materials/textures: needles, rain-dark bark, lichen, wet stone, ground fog
```

### `road`

`road-01.webp`

```text
Primary request: an original old trade road crossing open moorland at golden
overcast evening, worn milestones, bent grasses, distant low hills, wagon ruts
leading toward the horizon; no characters and no story-critical clues
Lighting/mood: journey, distance and quiet anticipation, subdued warm horizon
under heavy clouds
Color palette: muted ochre, peat brown, sage gray, steel blue
Materials/textures: packed earth, coarse grass, weathered stone, layered clouds
```

`road-02.webp`

```text
Primary request: an original narrow mountain pass road during a clearing storm,
switchback trail, dark wet cliffs, wind-bent shrubs and a distant stone bridge;
no characters and no story-critical clues
Lighting/mood: arduous travel and fresh air after danger, cold storm light with
a pale break in the clouds
Color palette: wet granite, steel blue, muted green, pale silver
Materials/textures: rough rock, mud, rainwater, scrub grass, cloud mist
```

### `settlement`

`settlement-01.webp`

```text
Primary request: an original small medieval village at dusk, timber houses
along a muddy main street, modest market stalls closing, stone well, chimney
smoke and lanterns; no characters and no story-critical clues
Lighting/mood: lived-in, calm and slightly mysterious; cool dusk with warm
windows
Color palette: dark timber, clay brown, smoke blue, muted amber
Materials/textures: wattle and daub, worn wood, muddy ruts, rough stone, smoke
```

`settlement-02.webp`

```text
Primary request: an original fortified market settlement in soft overcast
morning, timber palisade, broad square, canvas stalls, carts, well and clustered
slate-roof houses; no characters and no story-critical clues
Lighting/mood: practical, bustling in spirit but momentarily empty, cool diffuse
daylight
Color palette: weathered wood, canvas beige, muted red clay, gray sky, moss green
Materials/textures: timber, rope, canvas, packed earth, slate roofs
```

### Общие варианты

`common-night-road.webp`

```text
Primary request: an original lonely medieval road at night under a clouded
moon, old milestone, sparse birches, wagon ruts and low mist fading into the
distance; no characters and no story-critical clues
Lighting/mood: quiet travel, uncertainty without horror, soft moonlight and
readable silhouettes
Color palette: midnight blue, silver gray, peat brown, black-green
Materials/textures: packed earth, wet grass, birch bark, mist, weathered stone
```

`common-camp.webp`

```text
Primary request: an original quiet travelers' camp at night in a sheltered
clearing, small fire, three bedrolls, simple cooking pot, stacked packs and a
canvas lean-to; no characters and no story-critical clues
Lighting/mood: safe pause during a long journey, intimate firelight under deep
blue night
Color palette: ember orange, midnight blue, dark moss, worn canvas beige
Materials/textures: ash, wool bedrolls, canvas, leather packs, forest floor
```

`common-ruins.webp`

```text
Primary request: an original overgrown medieval ruin at cloudy late afternoon,
collapsed stone hall, broken arches, ivy, shallow puddles and a distant intact
doorway; no characters and no story-critical clues
Lighting/mood: history, silence and possibility, soft diffused light with
readable depth
Color palette: weathered gray, moss green, damp umber, pale cloud silver
Materials/textures: fractured masonry, ivy, mud, old timber, rainwater
```

## Выбор и добавление варианта

`src/scene-art.ts` — единственный владелец сопоставления темы и визуального
набора. Он выбирает одну из двух тематических иллюстраций по стабильному hash
`theme + locationId`; возврат в ту же локацию поэтому не меняет внешний вид.
Тот же resolver отдаёт одну из пяти собственных светлых фактур для подложки
доски. Общие варианты служат только fallback для неизвестной темы.

Чтобы добавить файл:

1. выполнить отдельную генерацию по визуальному контракту;
2. привести результат к 1280×512 WebP и сохранить под `public/assets/scenes/`;
3. записать точный prompt и происхождение в этот документ;
4. добавить файл в `SCENE_ART_LIBRARY`;
5. зарегистрировать идентичность:
   `node tools/register-asset-rights.mjs --all-under scenes`;
6. запустить `node --test test/scene-art.test.mjs` и
   `pnpm content:verify`.
