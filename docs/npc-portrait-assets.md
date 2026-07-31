# Портреты NPC: контракт и происхождение

Backlog #69 разделён на две независимые части. Этот документ описывает
реализованный backend/static foundation. Подключение портретов к карточкам NPC
в основном интерфейсе остаётся отдельным шагом, поэтому пункт backlog пока не
закрыт.

## Lazy endpoint

`GET /api/campaigns/:campaignId/npcs/:npcId/portrait` предназначен для прямого
использования как `img src`.

Маршрут:

1. требует действующую session cookie и доступ к кампании;
2. ищет NPC только в уже готовой viewer projection `social.npcs`;
3. для второстепенного NPC отвечает redirect на локальную роль-заготовку;
4. для важного NPC сначала читает persistent cache, а при cache miss применяет
   per-user generation rate limit и вызывает модель `DND_IMAGE_MODEL`;
5. отдаёт generated WebP только через тот же authenticated endpoint.

Сырые `campaignId` и `npcId` не используются как части файлового пути. Cache
лежит в
`<DND_STORAGE_DIR>/generated/npcs/<campaign-sha256>/<npc-sha256>.webp`.
Traversal-строка поэтому не может выйти из configured storage.

## Что считается важным NPC

Достаточно одного server-owned признака в доступной конкретному viewer
проекции:

- NPC является merchant;
- есть видимый committed разговор;
- есть видимое открытое обещание;
- видимое отношение к герою ненулевое;
- профиль несёт явный тег `important`, `major`, `key_npc`, `story_critical`,
  `quest_giver`, `companion`, `patron` или `rival`.

Все остальные NPC получают одну из детерминированных локальных заготовок:
`merchant`, `guard`, `noble`, `scholar`, `priest`, `artisan`, `traveler`,
`commoner`.

## Prompt и граница приватности

Prompt собирается сервером и bounded по длине. Из профиля копируются только:

- `name`;
- `role`;
- `public_summary`.

Эти поля помечаются как недоверенные данные. `goals`, `beliefs`, schedule,
inventory, private conversations и GM-only заметки в генератор не передаются.
Модель получает фиксированные требования: один взрослый NPC, поясной книжный
портрет, спокойный фон, без текста, логотипов, рамок, UI и других персонажей.

## Локальный role set

Восемь роль-заготовок созданы встроенным OpenAI ImageGen специально для
«Сказания». Они не копируют существующих персонажей или сторонние игровые
ассеты. Проверенные квадратные исходники 1254×1254 уменьшены Lanczos-фильтром
до production PNG 320×320 без метаданных; 16+ МБ исходников в Git не входят.

| Роль | Production asset | ImageGen source id |
| --- | --- | --- |
| merchant | `npcs/roles/merchant.png` | `call_9VoHIxwDCAVf17aT2VsdTh5w.png` |
| guard | `npcs/roles/guard.png` | `call_1AonmI1JSqHlMzz1M3NCHRN9.png` |
| noble | `npcs/roles/noble.png` | `call_2HuVWL0CqomG5beG3Wp9WZE8.png` |
| scholar | `npcs/roles/scholar.png` | `call_7XbTBLhBFeVzYmUtwKJIptt4.png` |
| priest | `npcs/roles/priest.png` | `call_eDcMGRKJiKjXv04fDyZMNxHk.png` |
| artisan | `npcs/roles/artisan.png` | `call_zXmwxHPqqpywLKQlqHqDEEji.png` |
| traveler | `npcs/roles/traveler.png` | `call_JCvYbkRG8yNv6JFS6R5OiQod.png` |
| commoner | `npcs/roles/commoner.png` | `call_9n5D2kAVRGM1RjVBqGZOFyRu.png` |

SHA-256 и фактический размер каждого production-файла зарегистрированы в
`data/asset-rights.json` и проверяются `test/npc-portrait-assets.test.mjs`.
