# Замены иконок `gentle-repose` и `commune`

Дата: 2026-09-26.

По согласованной приёмке заменены только два runtime-ассета:

- `public/assets/ui/action-icons/gentle-repose.png` — вместо книги на ларце
  изображено сохранённое тело в светлом саване, ровно две монеты на глазах и
  белые охранные руны. Кровь, открытые раны, череп и контейнеры исключены.
- `public/assets/ui/action-icons/commune.png` — золотой солнечный holy symbol
  с лицом и лучами соединён световыми дугами с молящимися руками. Это активная
  божественная связь, а не отдельный медальон или подвеска.

Изображения сгенерированы встроенным `image_gen` с прозрачным фоном. Текущие
PNG до замены были предварительно просмотрены через `view_image` и использованы
только как стилевые референсы. Сторонние BG3-ассеты не использовались.

## Provenance

Исходные ответы ImageGen сохранены в `$CODEX_HOME/generated_images` и скопированы
в рабочие промежуточные файлы:

| ID | Built-in output | Raw output | Raw SHA-256 |
|---|---|---|---|
| `gentle-repose` | `$CODEX_HOME/generated_images/01a0ddd9-3f31-7950-b2ba-dd8c76d530fb/exec-a3955605-c863-4d2b-948d-441227c83052.png` | `tmp/icon-fixes-b/raw/gentle-repose.png` | `148D1681670BC5E8FF0F198844F787A7EA310E623BC03CA1D26DD39ACE7422EE` |
| `commune` | `$CODEX_HOME/generated_images/01a0ddd9-3f31-7950-b2ba-dd8c76d530fb/exec-dfbc4c29-0709-4a38-ad62-a81270dbd4df.png` | `tmp/icon-fixes-b/raw/commune.png` | `2D2749EBD12ED5F298FABED5BFD891C7C993634FAA2B11F3AEB74CC06B495547` |

Для обоих файлов применена существующая нормализация
`tmp/icon-all/normalize_icon.py --target 435` в `tmp/icon-fixes-b/normalized-512/`,
затем RGBA PNG уменьшен LANCZOS до 256×256 в
`tmp/icon-fixes-b/final-256/`. В runtime скопированы именно эти финальные файлы;
`data/asset-rights.json` и другие реестры не менялись.

| ID | Runtime bytes | Runtime SHA-256 |
|---|---:|---|
| `gentle-repose` | 77879 | `6B9899C10DF43C486F725F20FB74D24C3AE34257EBFDE5CD06DC2BF52702ACF8` |
| `commune` | 60256 | `940CC0309D30B0E3BC2D87B9B4B9A7EF35EABF69F9E79BEB76AB0835B8AB1430` |

Техническая проверка обоих runtime-файлов: 256×256, RGBA, alpha range 0–255,
угловая альфа ниже порога 64, alpha≥64 bounding box не касается границы и
центрирован. `gentle-repose`: bbox `(19,22)-(236,234)`, longest 217 px;
`commune`: bbox `(62,19)-(194,237)`, longest 218 px.

## Сохранённые prompt specs

### `gentle-repose`

```text
Use case: stylized-concept. Asset type: square transparent fantasy-game UI
spell icon. Use the supplied current gentle-repose PNG only as style reference.
Replace its subject entirely with one compact human-shaped body wrapped in a
pale ivory burial shroud, exactly two antique coins over the eye area, and clean
white protective ward sigils and bands around the shroud. Polished painted 3D
fantasy icon, centered floating cutout, readable at 256x256, cool blue-white
preservation aura, no gore. Avoid book, chest, box, coffin, jar, potion,
jewelry-only amulet, wounds, blood, skull, skeleton, extra figures, extra
coins, text, watermark, UI frame, and opaque background.
```

### `commune`

```text
Use case: stylized-concept. Asset type: square transparent fantasy-game UI
spell icon. Use the supplied current commune PNG only as style reference.
Replace its subject entirely with a radiant three-dimensional golden sun holy
symbol with unmistakable rays and a sacred center above clearly formed praying
hands. Warm golden divine light and concentric signal-like rays visibly travel
from the symbol to the hands; a calm luminous face may remain in the symbol.
Polished painted 3D fantasy icon, centered connected composition, readable at
256x256, no text or watermark. Avoid plain medallion, pendant, necklace loop,
isolated amulet, shield, coin, book, chest, potion, sword, extra hands, fused
or malformed fingers, and opaque background.
```
