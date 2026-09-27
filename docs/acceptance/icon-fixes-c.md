# Замена двух неоднозначных spell icons — 2026-09-26

В этой партии заменены только два runtime-ассета:

- `contact-other-plane` — старый рисунок был обычным амулетом с кристаллом;
  новый показывает профиль головы и ухо, телепатический мост и звёздный портал
  другого плана.
- `creation` — старый рисунок был одиночным магическим кристаллом; новый
  показывает обычную деревянную чашу с металлической деталью, формирующуюся из
  фиолетового дыма.

## Provenance

- Генератор: встроенный `image_gen` tool, режим transparent background.
- Дата: 2026-09-26.
- Исходные PNG ImageGen сохранены в `tmp/icon-fixes-c/raw/`.
- Нормализация выполнена существующим
  `tmp/icon-all/normalize_icon.py --target 435`, затем staging 512×512 PNG
  уменьшен LANCZOS до production 256×256 RGBA в `tmp/icon-fixes-c/final-256/`.
- Установленные файлы: `public/assets/ui/action-icons/contact-other-plane.png`
  и `public/assets/ui/action-icons/creation.png`.
- В `data/asset-rights.json` и другие реестры ассетов запись не вносилась;
  это оставлено для последующей визуальной проверки root.

### ImageGen outputs and hashes

| ID | ImageGen output | Raw SHA-256 | Final runtime SHA-256 |
| --- | --- | --- | --- |
| `contact-other-plane` | `C:\Users\anton\.codex\generated_images\01a0ddd9-6c7e-7d82-98ea-d13e6837d6e8\exec-01f51e9b-360f-4252-8240-18bc94251ed0.png` | `D9D502BABEDD0B6D7170615781BFC2FB33B8CE2A623DBB7CC004256E4BBEE0C7` | `D19DB977EE968A604088201C47443AABA862377B0EE8D73EAB6B7A6691CFC904` |
| `creation` | `C:\Users\anton\.codex\generated_images\01a0ddd9-6c7e-7d82-98ea-d13e6837d6e8\exec-207d4776-78af-4884-9557-f474f53e2647.png` | `58EAFC7928509666104E90D150145B1C2521807A9EE0809E82AC8AA693FF7489` | `B9C6982E3B425BC09E881F50BE1738EA4CBF2B6C5EFA52331B15336E59B04DD6` |

The final runtime hashes equal the corresponding files in
`tmp/icon-fixes-c/final-256/`. Both files were inspected after installation and
are 256×256 `RGBA` PNGs with transparent pixels in the corners.

## Prompts

### `contact-other-plane`

```text
Use case: stylized-concept
Asset type: fantasy spell UI icon for a game
Primary request: Create a clear icon for the spell Contact Other Plane, showing mental communication across a cosmic plane.
Scene/backdrop: no background, genuinely transparent background.
Subject: one luminous human head and ear silhouette, shown as a magical mind-to-mind contact, with violet and cobalt telepathic waves reaching toward a small distant starfield portal; the mental connection and other-plane distance must be immediately readable.
Style/medium: polished painted 3D fantasy game icon, sculpted materials, rich rim lighting, crisp silhouette, consistent with a high-quality spell icon atlas.
Composition/framing: centered single focal icon, fills the square without clipping, readable at 256x256, no frame or UI border.
Lighting/mood: mysterious astral violet-blue glow, restrained cyan highlights.
Color palette: deep violet, cobalt blue, cyan, tiny white stars.
Materials/textures: subtle translucent magical energy and dimensional sculpted highlights.
Constraints: transparent alpha background; one compact icon; make the head/ear silhouette and cosmic connection unmistakable.
Avoid: a plain jewelry amulet, a standalone pendant, a solitary crystal or gem, generic potion bottle, unrelated physical object, text, letters, watermark, border, black or colored background, multiple characters.
```

### `creation`

```text
Use case: stylized-concept
Asset type: fantasy spell UI icon for a game
Primary request: Create a clear icon for the spell Creation, showing shadowy magic forming a tangible ordinary nonmagical object.
Scene/backdrop: no background, genuinely transparent background.
Subject: one ordinary wooden chalice or cup being created from smoky violet magic; the lower body is already solid carved wood while the upper rim and a small metal detail coalesce from violet shadowy wisps and motes, making the transformation from magic into a real object obvious.
Style/medium: polished painted 3D fantasy game icon, sculpted materials, rich rim lighting, crisp silhouette, consistent with a high-quality spell icon atlas.
Composition/framing: centered single focal icon, fills the square without clipping, readable at 256x256, no frame or UI border.
Lighting/mood: magical but practical, violet smoke around a warm brown wooden object with a restrained metallic glint.
Color palette: dark violet, smoky purple, warm walnut brown, muted brass or steel.
Materials/textures: visible wood grain and solid constructed surfaces; ephemeral wisps only around the forming top.
Constraints: transparent alpha background; the ordinary created object must be the dominant subject.
Avoid: a solitary magic gem or crystal, abstract energy-only symbol, potion bottle, weapon, character, multiple objects, text, letters, watermark, border, black or colored background.
```

## Visual and technical check

The installed PNGs were opened after copying to the runtime directory. The
alpha-64 bounding boxes are `(19,29)-(237,227)` for `contact-other-plane` and
`(47,19)-(208,237)` for `creation`; both are centered, leave transparent
corners, and remain legible at the production size. No tests were run because
this change is limited to two images and its provenance document.
