# Авторские планы стартовых городов

## Назначение

План города — промежуточный презентационный масштаб между глобальной картой и
тактической сценой. Он показывает шесть районов и десять важных мест, позволяет
читать их историю и сюжетные зацепки, но не перемещает отряд, не расходует ход и
не создаёт событий. Авторитетная смена сцены остаётся в Rules Engine.

| Мир | Город | Фон | Состав |
| --- | --- | --- | --- |
| Лига Девяти Отливов | Вельдбург | `public/assets/maps/city/skazanie/veld-burg-v1.webp` | 6 районов, 10 мест |
| Пояс Непогашенной Звезды | Нур-Кеш | `public/assets/maps/city/skazanie/nur-kesh-v1.webp` | 6 районов, 10 мест |
| Чаша Пепельного Сада | Лимнара | `public/assets/maps/city/skazanie/limnara-v1.webp` | 6 районов, 10 мест |

Районы, координаты, описания и зацепки находятся в
`data/campaign-worlds-v1.json`. Растр не содержит текста или игровых маркеров:
их накладывает интерфейс из server-owned данных.

## Генерация и происхождение

Три изображения созданы встроенным `imagegen` 1 сентября 2026 года отдельными
вызовами. Внешние изображения не использовались: для единства набора Image 1 в
каждом вызове был соответствующей глобальной картой `v2` проекта и служил только
стилевым референсом. Исходные PNG 1536×1024 механически приведены к 1600×1024
WebP через Pillow 12.3.0: Lanczos, quality 90, без crop, чтобы сохранить раму.

### Вельдбург — точный prompt

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D city overview
Input images: Image 1 is a style reference only, the atlas map of the League of Nine Tides; do not edit or reproduce its geography
Primary request: create an original strict top-down illustrated city plan of Veldburg, a fortified northern tidal merchant port built after a catastrophic flood
Scene/backdrop: a dense medieval harbor city inside a wide 25:16 frame; northwest contains brick cargo quays, ships, counting houses and wet warehouses; north-center is a raised dry ridge with a large ceremonial salt square and narrow council hall; northeast is an old bell ward with several distinct towers and chapels; southwest is a low salt market threaded by narrow canals and floating stalls; south-center is a long fortified dike with workshops, stairs, two sluice gates and a watchtower; southeast is a stilt-house district of boatyards and branching lower channels, including a concealed nine-part stone sluice mechanism
Style/medium: match Image 1's original hand-painted fantasy atlas language—ink and watercolor, illustrated roofs, masonry, waves and canals, deep slate-blue water, warm ochre brick, crisp readable city blocks, polished tabletop-RPG cartography
Composition/framing: strict top-down orthographic plan, wide landscape about 25:16, city fills the canvas while the six district zones remain visually distinct; original restrained carved-gold maritime frame only within the outer 3 percent; one small original tidal compass in an empty water corner; leave clean spaces for later UI labels
Lighting/mood: cold northern daylight, salt mist, wealthy but uneasy port
Constraints: no words, no letters, no numbers, no district labels, no city names, no banners, no shields, no title cartouche, no map pins, no route overlays, no legend, no grid, no watermark, no logos, no people large enough to become focal points
Avoid: no isometric or perspective camera; no copied symbols, border ornament, labels or exact composition from the reference; no ruined city beneath this city plan
~~~

### Нур-Кеш — точный prompt

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D city overview
Input images: Image 1 is a style reference only, the atlas map of the Belt of the Unfading Star; do not edit or reproduce its geography
Primary request: create an original strict top-down illustrated city plan of Nur-Kesh, a fortified oasis capital of caravans, water scribes and forbidden astronomy
Scene/backdrop: a wide 25:16 walled desert city; north-center contains the elevated Eclipse Citadel, palace courtyards and a sealed circular astrarium; the center is a large civic square with a vivid blue fountain and exactly seven irrigation channels radiating through the city; east contains monumental caravan gates, camel yards and a four-well caravanserai; west is lush with gardens, palms, water-scribe pavilions and stepped canals; south-center is an older scholars' quarter of narrow lanes, astrolabe workshops and shadowed archives; southeast is a dense red-awning night-market and dye-house quarter with concealed underpasses
Style/medium: match Image 1's original hand-painted fantasy atlas language—ink and watercolor, ochre walls, turquoise water, green gardens, flat roofs, domes and caravan courts, crisp readable urban blocks, polished tabletop-RPG cartography
Composition/framing: strict top-down orthographic plan, wide landscape about 25:16, city fills the canvas while six district zones remain visually distinct; original restrained bronze geometric frame only within the outer 3 percent; one small original celestial compass in an empty desert corner; leave clear spaces for later UI labels
Lighting/mood: bright dry daylight with a cool uncanny blue-star undertone
Constraints: no words, no letters, no numbers, no district labels, no city names, no title cartouche, no banners, no shields, no map pins, no route overlays, no legend, no grid, no watermark, no logos, no people large enough to become focal points
Avoid: no isometric or perspective camera; no copied symbols, border ornament, labels or exact composition from the reference; no giant observatory ruin outside the city
~~~

### Лимнара — точный prompt

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D city overview
Input images: Image 1 is a style reference only, the atlas map of the Bowl of the Ashen Garden; do not edit or reproduce its geography
Primary request: create an original strict top-down illustrated city plan of Limnara, a radiant Mediterranean port built on terraced volcanic slopes above a caldera
Scene/backdrop: a wide 25:16 coastal city; northeast contains an amber crescent harbor, fishing quays, floating markets and a long evacuation pier; north-center is a raised civic terrace with the council house, archives and a signal-fire tower; northwest contains stepped grain fields, olive groves, seed houses and stone water channels; southwest is an old white-limestone residential and shrine quarter of broad ceremonial stairs and small courtyards; south-center contains black obsidian workshops, kilns, pumice yards and a dark warm-water cistern; southeast is a fortified sealed basalt gate and military road leading toward an ash-covered slope outside the city
Style/medium: match Image 1's original hand-painted fantasy atlas language—ink and watercolor, deep Aegean-blue water, white limestone, terracotta roofs, olive green terraces, black basalt and a thin veil of ash, crisp readable city blocks, polished tabletop-RPG cartography
Composition/framing: strict top-down orthographic plan, wide landscape about 25:16, city fills the canvas while six district zones remain visually distinct; original restrained copper-and-laurel frame only within the outer 3 percent; one small original volcanic compass in an empty sea corner; leave clean spaces for later UI labels
Lighting/mood: brilliant late-summer Mediterranean sun with quiet volcanic unease
Constraints: no words, no letters, no numbers, no district labels, no city names, no title cartouche, no banners, no shields, no map pins, no route overlays, no legend, no grid, no watermark, no logos, no people large enough to become focal points
Avoid: no isometric or perspective camera; no copied symbols, border ornament, labels or exact composition from the reference; do not show the entire caldera island, only the city and immediate volcanic coast
~~~

## Права

SHA-256 и размеры файлов записаны в `data/asset-rights.json`, подробная
атрибуция — в `ATTRIBUTION.md`. Общий статус дерева assets остаётся
`review_required` / `distribution: blocked`; эта документация фиксирует
происхождение, но не отменяет общий release gate.
