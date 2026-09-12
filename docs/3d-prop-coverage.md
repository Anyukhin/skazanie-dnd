# Покрытие 3D-реквизита

Срез за 12 сентября 2026 зафиксирован в immutable public release
[`bd5c4563074b6e4ef576769c`](../public/assets/models/environment/releases/bd5c4563074b6e4ef576769c/manifest.json).
Источник игровых видов — `server/asset-registry.mjs`; источник моделей и кадров —
manifest выпуска.

В каноническом наборе 105 видов: 90 объёмных `prop` и 15 `decal`.
Девять записей `OPENINGS` (двери и сегменты стен) в этот знаменатель не входят.

Manifest выпуска содержит **177 model records, 112 mapped records и 94 уникальных
assetId с GLB**. Ещё **11 видов намеренно остаются плоскими**: 10 декалей и
`cave_pool`, который сохраняет игровую площадь 2×2, но рисуется водной
поверхностью. Поэтому покрытие составляет **94 + 11 = 105**. В составе выпуска
указаны 42 авторские интерьерные модели: 12 исходных, 18 household и 12
settlement.

Таблица показывает фактические ключи из immutable manifest выпуска. GLB отвечает
только за внешний вид; игровое поведение берётся из реестра ассетов.

## Таблица 105 видов

kind — тип записи реестра. В представлении указано, почему выбран GLB,
переиспользование готового GLB или плоский слой. Gameplay, footprint, anchor,
visibility и scale остаются ответственностью канонического реестра.

| assetId / название | kind | Представление и причина | model key в выпуске | Ограничения |
| --- | --- | --- | --- | --- |
| table_round / Круглый стол | prop | GLB / выпущенная модель — есть в immutable release | sk-table-round | канон 2×2; blocksMove, interactive, cover=half, scale=0.65–0.75; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| table_long / Длинный стол | prop | GLB / выпущенная модель — есть в immutable release | q-table_large | канон 3×1; blocksMove, interactive, cover=half, scale=0.9–1; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| table_royal / Королевский стол | prop | GLB / авторская модель — household/settlement | sk-household-table-royal | канон 5×2; blocksMove, interactive, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| royal_throne / Королевский трон | prop | GLB / авторская модель — household/settlement | sk-household-royal-throne | канон 2×2; blocksMove, interactive, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| table_small / Малый стол | prop | GLB / выпущенная модель — есть в immutable release | sk-table-small | канон 1×1; blocksMove, interactive, cover=half, scale=0.75–0.85; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bench / Скамья | prop | GLB / выпущенная модель — есть в immutable release | q-bench | канон 2×1; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| chair / Стул | prop | GLB / выпущенная модель — есть в immutable release | q-chair_1 | канон 1×1; scale=0.42–0.5; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| stool / Табурет | prop | GLB / выпущенная модель — есть в immutable release | q-stool | канон 1×1; scale=0.33–0.42; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bar_counter / Барная стойка | prop | GLB / выпущенная модель — есть в immutable release | sk-bar-counter | канон 4×1; anchor=wall, blocksMove, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bar_shelf / Полка с бутылками | prop | GLB / выпущенная модель — есть в immutable release | sk-bar-shelf | канон 3×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| fireplace / Камин | prop | GLB / выпущенная модель — есть в immutable release | sk-fireplace | канон 2×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| hearth_fire / Очаг | prop | GLB / выпущенная модель — есть в immutable release | sk-hearth-fire | канон 1×1; anchor=wall, interactive, scale=0.8–1.2; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| cauldron / Котёл | prop | GLB / выпущенная модель — есть в immutable release | q-cauldron | канон 1×1; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| firewood_stack / Стопка дров | prop | reuse / GLB выпуска — существующая модель переиспользована по близкой семантике | k-log_stack<br>k-log_stack_large | канон 1×1; anchor=wall, blocksMove, interactive, cover=half; assetId остаётся авторитетным, ключ — alias существующего GLB; вариация не добавляет отдельной семантики. |
| barrel / Бочка | prop | GLB / выпущенная модель — есть в immutable release | q-barrel<br>q-barrel_apples | канон 1×1; anchor=wall, blocksMove, interactive, cover=half, scale=0.85–1.15; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| barrel_stack / Штабель бочек | prop | GLB / авторская составная модель — один GLB собирает составной объект | sk-household-barrel-stack | канон 2×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; состав/детали визуальны, состояния и правила не выводятся из GLB. |
| keg / Кег | prop | GLB / выпущенная модель — есть в immutable release | q-barrel | канон 1×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| crate / Ящик | prop | GLB / выпущенная модель — есть в immutable release | q-crate_wooden | канон 1×1; anchor=wall, blocksMove, interactive, cover=half, scale=0.85–1.15; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| crate_stack / Штабель ящиков | prop | GLB / авторская составная модель — один GLB собирает составной объект | sk-household-crate-stack | канон 2×1; anchor=corner, blocksMove, blocksSight, interactive, cover=three_quarters; состав/детали визуальны, состояния и правила не выводятся из GLB. |
| sack / Мешок | prop | GLB / выпущенная модель — есть в immutable release | q-bag | канон 1×1; anchor=wall, scale=0.8–1.2; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| basket / Корзина | prop | GLB / авторская модель — household/settlement | sk-household-basket | канон 1×1; anchor=wall, interactive, scale=0.8–1.2; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| bucket / Ведро | prop | GLB / выпущенная модель — есть в immutable release | q-bucket_metal | канон 1×1; scale=0.8–1.1; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| chest / Сундук | prop | GLB / выпущенная модель — есть в immutable release | q-chest_wood | канон 1×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| cupboard / Буфет | prop | GLB / выпущенная модель — есть в immutable release | q-cabinet | канон 1×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| wardrobe / Шкаф | prop | GLB / авторская модель — household/settlement | sk-household-wardrobe | канон 2×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| bookshelf / Книжный шкаф | prop | GLB / выпущенная модель — есть в immutable release | q-bookcase_2 | канон 2×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| shelf_wall / Настенная полка | prop | GLB / выпущенная модель — есть в immutable release | q-shelf_simple | канон 2×1; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| broom / Метла | prop | GLB / авторская модель — household/settlement | sk-household-broom | канон 1×1; anchor=corner, interactive, scale=0.9–1.05; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| mug / Кружка | prop | GLB / выпущенная модель — есть в immutable release | q-mug | канон 0×0; scale=0.35–0.48; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| plate / Тарелка | prop | GLB / выпущенная модель — есть в immutable release | q-table_plate | канон 0×0; scale=0.65–0.85; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bowl_stew / Миска с похлёбкой | prop | GLB / авторская модель — household/settlement | sk-household-bowl-stew | канон 0×0; scale=0.8–1.1; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| bottle / Бутылка | prop | GLB / выпущенная модель — есть в immutable release | q-bottle_1 | канон 0×0; scale=0.24–0.34; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| jug / Кувшин | prop | GLB / авторская модель — household/settlement | sk-household-jug | канон 0×0; scale=0.8–1.15; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| bread_loaf / Буханка хлеба | prop | GLB / авторская модель — household/settlement | sk-household-bread-loaf | канон 0×0; scale=0.8–1.2; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| cheese_wheel / Головка сыра | prop | GLB / авторская модель — household/settlement | sk-household-cheese-wheel | канон 0×0; scale=0.8–1.15; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| candle / Свеча | prop | GLB / выпущенная модель — есть в immutable release | q-candle_1 | канон 0×0; scale=0.8–1.1; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| dice_cup / Кубковая кружка | prop | GLB / авторская модель — household/settlement | sk-household-dice-cup | канон 0×0; scale=0.85–1.05; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| coin_pile / Кучка монет | prop | GLB / выпущенная модель — есть в immutable release | q-coin_pile | канон 0×0; interactive, scale=0.8–1.2; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| lute / Лютня | prop | GLB / авторская модель — household/settlement | sk-household-lute | канон 0×0; interactive; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| cutting_board / Разделочная доска | prop | GLB / авторская модель — household/settlement | sk-household-cutting-board | канон 0×0; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| pot / Горшок | prop | GLB / выпущенная модель — есть в immutable release | q-pot_1 | канон 0×0; scale=0.8–1.15; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bed / Кровать | prop | GLB / выпущенная модель — есть в immutable release | q-bed_twin1<br>q-bed_twin2 | канон 2×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bunk_bed / Двухъярусная кровать | prop | GLB / авторская модель — household/settlement | sk-household-bunk-bed | канон 2×1; anchor=wall, blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| night_table / Ночная тумба | prop | reuse / GLB выпуска — существующая модель переиспользована по близкой семантике | q-nightstand_shelf | канон 1×1; anchor=wall; assetId остаётся авторитетным, ключ — alias существующего GLB; вариация не добавляет отдельной семантики. |
| washbasin / Умывальник | prop | GLB / авторская модель — household/settlement | sk-household-washbasin | канон 1×1; anchor=wall; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| torch_wall / Настенный факел | decal | GLB / выпущенная модель — есть в immutable release | q-torch_metal | канон 0×0; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| lantern_wall / Настенный фонарь | decal | GLB / выпущенная модель — есть в immutable release | q-lantern_wall | канон 0×0; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| candelabra / Канделябр | prop | GLB / выпущенная модель — есть в immutable release | q-candle_stick_triple | канон 1×1; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| chandelier / Люстра | prop | GLB / выпущенная модель — есть в immutable release | q-chandelier | канон 0×0; interactive, scale=0.9–1.15; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| banner / Знамя | decal | GLB / выпущенная модель — есть в immutable release | q-banner_1 | канон 0×0; anchor=wall, interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| sign_board / Настенная вывеска | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; anchor=wall; только плоский слой, высота/обзор GLB отсутствуют. |
| rug / Ковёр | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; interactive, scale=0.9–1.3; только плоский слой, высота/обзор GLB отсутствуют. |
| floor_stain / Пятно на полу | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; scale=0.7–1.4; только плоский слой, высота/обзор GLB отсутствуют. |
| stairs_up / Лестница вверх | prop | GLB / выпущенный GLB — источник Kenney Modular Dungeon | kd-stairs | канон 2×1; anchor=wall, interactive; provenance выпуска сохранён; направление задаёт transition. |
| stairs_down / Лестница вниз | prop | GLB / выпущенный GLB — источник Kenney Modular Dungeon | kd-stairs | канон 2×1; anchor=wall, interactive; provenance выпуска сохранён; направление задаёт transition. |
| trapdoor / Люк | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; interactive; только плоский слой, высота/обзор GLB отсутствуют. |
| tree_oak / Дуб | prop | GLB / выпущенная модель — есть в immutable release | k-tree_oak | канон 2×2; blocksMove, blocksSight, cover=three_quarters, scale=0.8–1.4; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| tree_pine / Сосна | prop | GLB / выпущенная модель — есть в immutable release | k-tree_pine_default_a<br>k-tree_pine_tall_a_detailed | канон 2×2; blocksMove, blocksSight, cover=three_quarters, scale=0.8–1.5; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| tree_birch / Берёза | prop | GLB / выпущенная модель — есть в immutable release | k-tree_default<br>k-tree_simple | канон 1×1; blocksMove, blocksSight, cover=half, scale=0.85–1.35; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| tree_dead / Мёртвое дерево | prop | GLB / авторская модель — household/settlement | sk-tree-dead | канон 1×1; blocksMove, cover=half, scale=0.8–1.3; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| tree_stump / Пень | prop | GLB / выпущенная модель — есть в immutable release | k-stump_old<br>k-stump_round_detailed<br>k-stump_square_detailed_wide | канон 1×1; cover=half, scale=0.8–1.2; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| bush / Куст | prop | GLB / выпущенная модель — есть в immutable release | k-plant_bush<br>k-plant_bush_detailed<br>k-plant_bush_large | канон 1×1; blocksSight, cover=half, scale=0.75–1.35; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| shrub / Небольшой куст | prop | GLB / выпущенная модель — есть в immutable release | k-plant_bush_small | канон 1×1; cover=half, scale=0.75–1.3; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| grass_tuft / Пучок травы | decal | GLB / выпущенная модель — есть в immutable release | k-grass<br>k-grass_large | канон 0×0; scale=0.7–1.4; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| flowers / Цветы | decal | GLB / выпущенная модель — есть в immutable release | k-flower_red_a<br>k-flower_yellow_a | канон 0×0; scale=0.7–1.3; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| rock_small / Небольшой камень | prop | GLB / выпущенная модель — есть в immutable release | k-rock_small_a<br>k-rock_small_b<br>k-rock_small_flat_a | канон 1×1; cover=half, scale=0.7–1.3; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| boulder / Валун | prop | GLB / выпущенная модель — есть в immutable release | k-rock_large_a<br>k-rock_tall_a | канон 1×1; blocksMove, blocksSight, cover=three_quarters, scale=0.85–1.4; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| woodpile / Поленница | prop | GLB / выпущенная модель — есть в immutable release | k-log_stack<br>k-log_stack_large | канон 2×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| cart / Телега | prop | GLB / выпущенная модель — есть в immutable release | q-stall_cart_empty | канон 2×1; blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| wagon_wheel / Колесо телеги | prop | GLB / авторская модель — household/settlement | sk-wagon-wheel | канон 1×1; anchor=wall, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| hitching_post / Коновязь | prop | GLB / авторская модель — household/settlement | sk-hitching-post | канон 1×1; interactive; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| water_trough / Поилка | prop | GLB / авторская модель — household/settlement | sk-water-trough | канон 2×1; blocksMove, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| well / Колодец | prop | GLB / авторская модель — household/settlement | sk-well | канон 2×2; blocksMove, interactive, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| lamp_post / Фонарь на столбе | prop | GLB / авторская модель — household/settlement | sk-lamp-post | канон 1×1; interactive; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| signpost / Указатель | prop | GLB / выпущенный GLB — источник Nature Kit | k-sign | канон 1×1; interactive; provenance выпуска сохранён; gameplay остаётся в реестре. |
| haystack / Стог сена | prop | GLB / авторская модель — household/settlement | sk-haystack | канон 2×2; blocksMove, blocksSight, interactive, cover=three_quarters, scale=0.85–1.25; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| path_stone / Камень дорожки | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; scale=0.7–1.3; только плоский слой, высота/обзор GLB отсутствуют. |
| campfire / Костёр | prop | GLB / выпущенная модель — есть в immutable release | k-campfire_logs | канон 1×1; interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| pillar / Колонна | prop | GLB / выпущенная модель — есть в immutable release | sk-pillar | канон 1×1; blocksMove, blocksSight, interactive, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| altar / Алтарь | prop | GLB / выпущенная модель — есть в immutable release | sk-altar | канон 2×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| statue / Статуя | prop | GLB / выпущенный GLB — источник Nature Kit | k-statue_head<br>k-statue_obelisk<br>k-statue_column | канон 1×1; blocksMove, blocksSight, interactive, cover=three_quarters; provenance выпуска сохранён; gameplay остаётся в реестре. |
| brazier / Жаровня | prop | GLB / выпущенная модель — есть в immutable release | sk-brazier | канон 1×1; interactive; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| offering_bowl / Чаша для подношений | prop | GLB / авторская модель — household/settlement | sk-household-offering-bowl | канон 0×0; scale=0.8–1.1; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| prayer_bench / Молитвенная скамья | prop | reuse / GLB выпуска — существующая модель переиспользована по близкой семантике | q-bench | канон 2×1; anchor=wall, interactive; assetId остаётся авторитетным, ключ — alias существующего GLB; вариация не добавляет отдельной семантики. |
| temple_banner / Храмовое знамя | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; anchor=wall, interactive; только плоский слой, высота/обзор GLB отсутствуют. |
| reliquary / Реликварий | prop | GLB / выпущенная модель — есть в immutable release | sk-reliquary | канон 1×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| mosaic / Мозаика | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; scale=0.9–1.4; только плоский слой, высота/обзор GLB отсутствуют. |
| sarcophagus / Саркофаг | prop | GLB / выпущенная модель — есть в immutable release | sk-sarcophagus | канон 2×1; blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| grave / Могила | prop | GLB / авторская модель — household/settlement | sk-grave | канон 2×1; anchor=wall, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| bone_pile / Куча костей | prop | GLB / авторская модель — household/settlement | sk-bone-pile | канон 0×0; scale=0.7–1.3; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| urn / Погребальная урна | prop | GLB / авторская модель — household/settlement | sk-household-urn | канон 1×1; anchor=wall; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| crypt_niche / Ниша склепа | prop | GLB / выпущенная модель — есть в immutable release | sk-crypt-niche | канон 1×1; anchor=wall, blocksMove, blocksSight, cover=three_quarters; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| cobweb / Паутина | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; anchor=corner, interactive; только плоский слой, высота/обзор GLB отсутствуют. |
| stalagmite / Сталагмит | prop | GLB / выпущенный GLB — источник Nature Kit | k-rock_tall_c<br>k-rock_tall_d<br>k-rock_tall_j | канон 1×1; blocksMove, cover=half, scale=0.7–1.5; provenance выпуска сохранён; gameplay остаётся в реестре. |
| cave_pool / Пещерный водоём | prop | flat / terrain — water surface уже рисует площадь; отдельный GLB не нужен | — | канон 2×2; blocksMove; blocksMove и 2×2 остаются серверными, визуально только water overlay. |
| mushroom_cluster / Группа грибов | prop | GLB / выпущенная модель — есть в immutable release | k-mushroom_red<br>k-mushroom_red_group<br>k-mushroom_tan_group | канон 0×0; scale=0.7–1.4; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| ore_vein / Жила руды | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; anchor=wall, interactive; только плоский слой, высота/обзор GLB отсутствуют. |
| rubble_heap / Куча обломков | prop | GLB / авторская составная модель — один GLB собирает составной объект | sk-rubble-heap | канон 1×1; cover=half, scale=0.8–1.3; состав/детали визуальны, состояния и правила не выводятся из GLB. |
| tree_spruce / Ель | prop | GLB / выпущенная модель — есть в immutable release | k-tree_pine_round_a | канон 2×2; blocksMove, blocksSight, cover=three_quarters, scale=0.8–1.4; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| fallen_log / Поваленное бревно | prop | GLB / выпущенная модель — есть в immutable release | k-log<br>k-log_large | канон 2×1; cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| fern / Папоротник | decal | flat / decal — текущий wall/ground painter и prop-atlas frame | — | канон 0×0; scale=0.7–1.3; только плоский слой, высота/обзор GLB отсутствуют. |
| milestone / Придорожный камень | prop | GLB / авторская модель — household/settlement | sk-milestone | канон 1×1; anchor=wall, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| roadside_shrine / Придорожная часовня | prop | GLB / авторская модель — household/settlement | sk-roadside-shrine | канон 1×1; anchor=wall, blocksMove, interactive, cover=half; GLB визуален; gameplay/scale/visibility остаются в реестре. |
| market_stall / Торговая стойка | prop | GLB / выпущенная модель — есть в immutable release | q-stall_empty | канон 2×2; blocksMove, interactive, cover=half; GLB визуален, gameplay/scale/visibility остаются в реестре. |
| village_fence / Деревенская изгородь | prop | GLB / выпущенный GLB — источник Nature Kit | k-fence_simple<br>k-fence_planks | канон 2×1; anchor=wall, cover=half; provenance выпуска сохранён; gameplay остаётся в реестре. |

## Граница визуальной метаинформации

Для механики авторитетен только `server/asset-registry.mjs`: там определены
`assetId`, footprint, anchor, blocksMove, blocksSight, cover, interactive,
destructible и scaleRange. Manifest, GLB и atlas не добавляют новых действий,
клеток, укрытий или прав видимости.

У zero-footprint реквизита GLB остаётся визуальной деталью на разрешённой опоре.
Поворот, состояние, раскрытие и серверные последствия предмета не выводятся из
его геометрии. Immutable release сохраняет provenance и готовые URL моделей;
изменение механики требует правки реестра и соответствующих серверных правил.
