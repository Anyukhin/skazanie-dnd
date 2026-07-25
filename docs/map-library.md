# Библиотека тактических карт

## Назначение

Карта кампании остаётся серверной структурированной моделью: клетки, стены,
проходы, видимость и коллизии определяются состоянием сцены. Библиотечная
иллюстрация является согласованной визуальной проекцией и не меняет механику.

В режиме атмосферного фона одна иллюстрация нарезается на все существующие
клетки общей системой координат. Поэтому рисунок не повторяется отдельно в
каждой клетке и сохраняет цельную композицию даже у неровной карты.

## Текущий набор

Используется единый public-domain / CC0 art pack
[South-East Asian-inspired maps by Dyson Logos — Scarlet Heroes](https://lpc.opengameart.org/content/south-east-asian-inspired-maps-by-dyson-logos-scarlet-heroes).
Исходный архив содержит пять работ одного художника:

| Категория проекта | Исходная работа | Путь |
| --- | --- | --- |
| `cave` | `DysonLogos_CAVERN.tif` | `public/assets/maps/library/dyson-logos/cave/dyson-logos-cavern.webp` |
| `dungeon` | `DysonLogos_DUNGEON.tif` | `public/assets/maps/library/dyson-logos/dungeon/dyson-logos-dungeon.webp` |
| `tavern` / интерьер | `DysonLogos_ESTATE.tif` | `public/assets/maps/library/dyson-logos/tavern/dyson-logos-estate.webp` |
| `temple` | `DysonLogos_TEMPLE.tif` | `public/assets/maps/library/dyson-logos/temple/dyson-logos-temple.webp` |
| `village` | `DysonLogos_VILLAGE.tif` | `public/assets/maps/library/dyson-logos/village/dyson-logos-village.webp` |

Маршрутизация сначала анализирует название и тему сцены, затем использует
визуальный тип доски. Таверны и дома получают `tavern`, храмы — `temple`,
пещеры — `cave`, поселения и лесные открытые сцены — `village`, остальные
руины и подземелья — `dungeon`.

## Лицензия и происхождение

Набор создан Dyson Logos для Scarlet Heroes. Sine Nomine Publishing сообщает,
что приобрела полные права и выпустила art pack в общественное достояние для
личного и коммерческого использования. Атрибуция не обязательна, но имя автора
сохранено по просьбе издателя. Файлы загружены с OpenGameArt и преобразованы из
TIFF в WebP 25 июля 2026 года; их hashes зарегистрированы в
`data/asset-rights.json`.

При добавлении нового набора нельзя смешивать случайные стили внутри одной
кампании. Сначала фиксируются источник, лицензия, автор, набор категорий и
hashes, затем весь набор подключается отдельным versioned каталогом.
