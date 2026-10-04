# Раунд 12 / 46 — контракт кеша NPC-портретов и иллюстраций локаций

Дата проверки: 2026-10-04. Проверен runtime-baseline `cb045a8466f35696ff24abe9020d6f39dee89462`; текущий `HEAD` (`737784b1cc76cf2b2fab15216755617f914bb1d0`) содержит для этого скоупа только docs-only изменения. Проверка ограничена `NpcPortraitService`, `LocationIllustrationService` и их HTTP-маршрутами. Реальных provider image calls, скачивания, LLM-вызовов и секретов не было.

Исходники pinned полными URL на runtime commit:

- NPC cache key, read path, resolve order, in-flight map и atomic rename: [cache key](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L272-L282), [read path](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L338-L359), [resolve/in-flight](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L371-L407), [atomic write](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L432-L475)
- Location cache key, read/hasCached path и atomic rename: [cache key](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/location-illustrations.mjs#L180-L190), [read/hasCached](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/location-illustrations.mjs#L239-L300), [atomic write](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/location-illustrations.mjs#L302-L359)
- HTTP visibility-before-cache and serving: [shared serving](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3395-L3414), [NPC route](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3515-L3550), [location route](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3552-L3585)
- Preparation skips entries whose inventory flag is already ready: [planPreparation](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/asset-preparation.mjs#L102-L142)
- Media format registry: [image-generation](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/image-generation.mjs#L20-L44)

## Что подтверждено

Кеш на диске scoped по кампании и сущности: каталог — 24 hex символа SHA-256 кампании, файл — 40 hex символов SHA-256 ID. Сырые campaign/NPC/location IDs в путях не появляются, traversal не проходит. HTTP сначала проверяет session/room access, строит viewer projection и ищет видимый профиль, и только затем читает кеш. Поэтому подготовленная картинка закрытой локации или NPC не становится способом узнать о закрытой сущности.

Портреты NPC имеют keyed in-flight dedupe: два одновременных `resolve` одного ключа делят один provider call. Запись обоих сервисов делается через уникальный временный файл и `rename`; probe получил целый синтетический payload, принятый проверкой сигнатуры сервиса, и не оставил `.tmp`. Сервис не декодирует изображение, поэтому это не доказательство валидности WebP на уровне codec. Для локаций atomic rename сохраняет целостность записи, а поведение двух одинаковых `prepare` оставлено отдельным policy-вопросом.

Статус доказательства visibility — positive control реального HTTP: `test/npc-portraits-api.test.mjs` проверяет anonymous/outsider/hidden NPC, а `test/location-illustrations-api.test.mjs` проверяет hidden location; оба проходят до cache read и provider fake не вызывается для закрытого объекта. Это не является доказательством утечки секрета: известного secret-containing image fixture в скоупе нет.

## Обновление подготовленного изображения

`npcPortraitCacheLocation` и `locationIllustrationCacheLocation` хешируют только `campaignId + entityId`. Публичные поля, из которых строится prompt (имя, роль/kind, summary, tags), в ключ не входят. В NPC runtime порядок `cached()` идёт до генерации, поэтому изменение публичного описания возвращает старые байты с `cacheHit: true`. В подготовке локаций `hasCached()` проверяет только существующий WebP, а `planPreparation` пропускает готовую запись без `regenerate`.

Probe `46-image-cache-probe.mjs` воспроизводит оба конца контракта на синтетических байтах:

```text
stale_npc.generator_calls = 1
stale_npc.cache_hit_after_public_change = true
stale_npc.served_bytes = old
concurrent_location_prepare.generator_calls = 2
concurrent_location_prepare.final_file_cache_accepted = true
concurrent_location_prepare.changed_location_skipped_without_regenerate = true
```

Это наблюдение о manual freshness contract, а не доказанная секретная утечка и не автоматически дефект: текущая политика намеренно сохраняет картинку до явной перегенерации ведущим. HTTP visibility всё равно проверяется перед чтением. Практическое следствие согласуется с продуктовым выбором «портрет/место живёт по ID, обновляется только кнопкой regenerate».

Варианты: сохранить текущую ручную перегенерацию либо добавить признак изменения визуального описания и предложить ведущему обновить рисунок. Во втором случае сначала определить поля, которые действительно влияют на изображение, затем считать по ним `asset_fingerprint` с версией контракта. Изменение обычной сюжетной сводки или tags не обязано менять внешность NPC. Автоматическое удаление подготовленного изображения или платная генерация из такого сравнения не следуют.

## Параллельная подготовка и повтор запроса

У NPC есть `this.inflight` для `resolve`, но явный `prepare` его не использует. У `LocationIllustrationService` такого состояния нет. Оба `prepare` безусловно вызывают generator; HTTP-обработчик последовательно обходит список только внутри одного POST, а параллельные POST-запросы не имеют показанного request-idempotency/busy контракта. Это само по себе не доказывает двойное списание или ошибку wallet: probe инжектирует fake generator без ledger и не моделирует HTTP retry.

Probe запускает две `prepare` для одной локации с одинаковым ID и одинаковым prompt с барьером внутри fake generator и получает `generator_calls = 2`, синтетический payload, принятый сигнатурной проверкой, и ноль временных файлов. Atomic rename положителен для целостности записи; winner при двух одинаковых explicit preparations определяется последним `rename`.

Если продукту нужен retry-safe режим подготовки, сначала выбрать контракт: request idempotency key, ответ `busy` для уже выполняющегося ID или явный deterministic winner. In-flight dedupe по `(campaign, location, fingerprint)` подходит для повторов одного намерения, но не должен автоматически suppress-ить отдельную `regenerate=true` операцию. При выбранной freshness policy ключ также не должен объединять разные content fingerprints.

## Extension seam для будущего второго media вида

Текущий контракт намеренно узок: оба доменных сервиса жёстко используют WebP (`isWebp`, `contentType: image/webp`, суффикс `.webp`). Это не current finding, пока второго формата не требуется. Если появится такое требование, добавление PNG/AVIF потребует синхронно менять generator options, проверку сигнатуры, cache path, metadata и serving contract; единого `MediaArtifact`/descriptor seam сейчас нет.

Тогда можно вынести формат в небольшой descriptor (`id`, `extension`, `contentType`, `matches`) и передавать его в cache/serving contract. До запроса второго формата отдельный рефакторинг не нужен.

## Тесты и cleanup

Перед probe прочитаны и запущены существующие scoped tests:

- `node --test test/npc-portraits.test.mjs` — 9/9 pass;
- `node --test test/npc-portraits-api.test.mjs` — 1/1 pass;
- `node --test test/location-illustrations.test.mjs` — 12/12 pass;
- `node --test test/location-illustrations-api.test.mjs` — 1/1 pass;
- суммарно: 23/23 pass, 0 fail.

Новый probe: `node docs/reviews/2026-10-04/round-12/46-image-cache-probe.mjs` — pass; использует только `mkdtemp` под системным temp, synthetic RIFF/WEBP-signature payload и injected fake generators. `finally` удаляет временное хранилище рекурсивно. Этим скоупом изменены только два файла `46-*`; runtime, `data/`, `storage/`, `.env` и provider не затронуты. Полный `pnpm verify` намеренно не запускался по инструкции проекта.
