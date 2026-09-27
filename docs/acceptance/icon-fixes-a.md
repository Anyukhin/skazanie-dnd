# ImageGen icon fixes A — 2026-09-26

Узкая правка двух runtime-иконок по запросу owner. Использован встроенный
ImageGen edit flow с `transparent_background: true`; сторонние изображения и
новые зависимости не использовались. После генерации оба PNG уменьшены
штатным System.Drawing-проходом до 256×256 RGBA.

Права в `data/asset-rights.json` этим отчётом намеренно не обновляются.

## phantasmal-force

Текущий исходный файл перед edit:
`public/assets/ui/action-icons/phantasmal-force.png`, просмотрен через
`view_image`. Он показывал общий голубой сферический вихрь/чёрную пустоту.

Промпт ImageGen:

> Use case: stylized-concept. Asset type: square fantasy spell inventory icon
> for a D&D game UI. Input image is the current phantasmal-force icon and the
> established hand-painted 3D fantasy icon style reference. Replace the generic
> black-hole orb with Phantasmal Force: one subtle spectral illusory threat
> emerging from translucent purple-blue psychic haze, suggesting a frightening
> humanoid or monstrous head and mind without becoming a literal solid creature.
> The illusion should feel projected and unreal, with faint duplicate contours,
> translucent edges, and a calm ominous expression. Isolated transparent
> cutout, no scene. One spectral illusory threat/head made from purple-blue
> psychic mist. Premium hand-painted fantasy inventory illustration with
> dimensional painterly 3D materials, polished highlights, restrained texture,
> consistent with the existing spell icon set. Centered, readable at 48px,
> generous transparent margin, no crop. Deep indigo, muted violet, cool blue,
> pale lavender highlights. Actual alpha transparency; no text, logo, frame,
> watermark or background. Avoid generic black hole, galaxy, planet, swirling
> void, portal, literal solid monster body, multiple creatures, gore, fire,
> lightning bolt, unrelated objects, borrowed/copyrighted character design.

ImageGen output:

- Source: `C:/Users/anton/.codex/generated_images/01a0ddc1-3ddb-7fc3-8dfb-5d80c5d1ca40/exec-fc5fbcad-5781-42b5-b9af-efc91a5dce3d.png`
- Dimensions: 1254×1254 RGBA.
- SHA-256: `d870b14f646feb2e27f48f4da5bd5f00c83e9ac1ef74f4bafbb1fce0122a8e61`.
- Preserved copy: `tmp/icon-all/phantasmal-force-imagegen-2026-09-26.png`.

Runtime result:

- `public/assets/ui/action-icons/phantasmal-force.png`
- 256×256 RGBA, all four corner alpha values 0.
- SHA-256: `e485213eb8a4c7cc6349395b4371de9d33c69715d4fbd8149fffe5f93d560c29`.
- Visual result: a single translucent purple-blue spectral threat/head with
  luminous eyes; no generic black-hole reading.

## skywrite

Текущий исходный файл перед edit:
`public/assets/ui/action-icons/skywrite.png`, просмотрен через
`view_image`. Он показывал рог, из которого выходило облако.

Промпт ImageGen:

> Use case: stylized-concept. Asset type: square fantasy spell inventory icon
> for a D&D game UI. Input image is the current skywrite icon and the
> established hand-painted 3D fantasy icon style reference. Replace the horn
> with one compact cloud formation shaped into readable skywriting glyph
> strokes. The cloud should form a short elegant arc of fantasy script-like
> symbols, clearly made from white and pale blue cloud vapor, with a few soft
> wisps. It must read as writing in the sky at 48px, even though the symbols
> are fictional and contain no literal text. Isolated transparent cutout; no
> sky background, ground or scene. One shaped cloud ribbon with deliberate
> glyph-like strokes. Premium hand-painted fantasy inventory illustration with
> dimensional painterly 3D cloud volume, polished highlights, consistent with
> the existing spell icon set. Centered compact cloud-script ribbon, readable at
> 48px, generous transparent margin, no crop. Warm white cloud, pale blue,
> cool gray-blue shadows. Remove the horn completely; exactly one cloud-written
> glyph ribbon; actual alpha transparency; no text, real-language letters,
> logo, frame, border, watermark or background. Avoid horn, trumpet, boot,
> weapon, musical instrument, random smoke puff, generic cloud blob, sky scene,
> multiple objects, borrowed/copyrighted design.

ImageGen output:

- Source: `C:/Users/anton/.codex/generated_images/01a0ddc1-3ddb-7fc3-8dfb-5d80c5d1ca40/exec-22b62e12-a44e-4764-8ad1-195bf75c21bf.png`
- Dimensions: 1254×1254 RGBA.
- SHA-256: `2ab85b34c8b88a3005d42b82983f6f9e7d4d4befe9361cb7a18be5218d0a88e6`.
- Preserved copy: `tmp/icon-all/skywrite-imagegen-2026-09-26.png`.

Runtime result:

- `public/assets/ui/action-icons/skywrite.png`
- 256×256 RGBA, all four corner alpha values 0.
- SHA-256: `124f2de851625617901d1b8bbe77e51fd1b0095a8db4ab449efb1a01db421f10`.
- Visual result: one pale white-blue cloud ribbon with intentional glyph-like
  strokes; the horn is removed and the symbol remains readable at icon scale.
