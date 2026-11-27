# Rust-сервер в Docker

Образ сервера игры (`Dockerfile.rust`) и его сервис (`compose.rust.yaml`).
**Rust — сервер владельца с 2026-10-31 и единственный сервер с 2026-11-27:**
`START_DND.cmd` поднимает его на 8787 с туннелем. Прежний JS-сервер
(`Dockerfile`, `compose.yaml`) — в архиве, `archive/js-server/README.md`;
`DND_SERVER` в `.env` — только `rust` или пусто, другое значение лаунчер
отвергает. Разовый перенос кампаний прежнего файлового `./storage` —
`tools/rust-cutover.ps1` (ниже).

| | Rust-сервер |
| --- | --- |
| Сборка | `Dockerfile.rust` |
| Compose | `compose.rust.yaml`, проект `skazanie-rust` |
| Порт на хосте | `127.0.0.1:8788` (`SKAZANIE_RUST_PORT`; лаунчер — 8787) |
| Туннель (профиль `public`) | `tunnel` → `skazanie-rust:8787` |
| Хранилище | том `skazanie-rust_storage` |
| Сертификат антивируса | `DND_EXTRA_CA_CERTS` в `.env`, `./local-ca` |

## Что в образе

Три этапа:

1. **client** — `node:22-alpine`, `pnpm install --frozen-lockfile` и
   `pnpm build`; результат — `dist/`.
2. **server** — `rust:1.91.1-slim-bookworm` (версия — `ARG RUST_VERSION`;
   файла `rust-toolchain` в репозитории нет, 1.91.1 — тулчейн ветки),
   `cargo build --release --locked -p sk-server --bin skazanie-server`
   **без** `test-hooks`. Параллельность rustc — `ARG CARGO_BUILD_JOBS=3`.
   Кэш крейтов и `target` — кэш-тома BuildKit: повторная сборка
   перекомпилирует только изменённые крейты.
3. **runtime** — `debian:bookworm-slim`: `/app/skazanie-server`, `/app/data`,
   `/app/prompts`, `/app/dist`, `/app/public → dist` (сервер читает атлас
   реквизита и манифест окружения из `public/`), корневые сертификаты
   из образа сборки. Пользователь `skazanie` (uid 10001), не root.
   `DND_DATA_DIR=/app`, `DND_STORAGE_DIR=/app/storage` (том), порт 8787 внутри.
   `HEALTHCHECK` — `HEAD /api/health` средствами bash (curl в slim-образе нет).

Сборка идёт в `/app/rust` — там же, где крейты лежат относительно `data/` в
репозитории. Поэтому даже бинарь без `DND_DATA_DIR` (пути от
`CARGO_MANIFEST_DIR`, долг С4 в `rust/SERVER-PLAN.md`) находит в итоговом
образе `/app/data`, `/app/prompts`, `/app/public` и `/app/dist`.

Точка входа — `deployment/rust/entrypoint.sh`: собирает пакет корней с
`DND_EXTRA_CA_CERTS` (если задан) и запускает бинарь, передав ему аргументы.
`CMD` нет: `docker run … skazanie-rust:local <подкоманда>` вызывает подкоманду
бинаря.

`.env` в образ не попадает (`.dockerignore`); ключи приходят через
`env_file: .env` при запуске.

## Сборка

```bash
docker build -f Dockerfile.rust -t skazanie-rust:local .
# быстрее, если машина свободна:
docker build -f Dockerfile.rust --build-arg CARGO_BUILD_JOBS=8 -t skazanie-rust:local .
```

Первая сборка качает образы `node`, `rust`, `debian`, пакеты npm и крейты
crates.io и компилирует весь движок — десятки минут. Нужен BuildKit
(в Docker Desktop включён по умолчанию).

## Запуск рядом с игрой

```bash
docker compose -f compose.rust.yaml up -d --build
docker compose -f compose.rust.yaml ps          # STATUS: healthy
docker compose -f compose.rust.yaml logs -f skazanie-rust
```

Сервер — `http://localhost:8788`. Если игра уже идёт на 8787 через лаунчер, это
тот же проект compose и тот же том: для проверки рядом с игрой удобнее
`pnpm rust:play` (свой порт и своё хранилище в `tmp/`).

Разовый запуск без compose (проверка образа, временный том, без модели):

```bash
docker run --rm -d --name skazanie-rust-check -p 127.0.0.1:18788:8787 \
  -v skazanie-rust-check:/app/storage -e ROUTERAI_API_KEY= skazanie-rust:local
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18788/api/health
docker rm -f skazanie-rust-check && docker volume rm skazanie-rust-check
```

### Локальный резерв текста через Ollama

Запустите Ollama на хосте и укажите в `.env` имя установленной модели,
например `DND_AI_OLLAMA_MODEL=qwen3:14b`. Для Docker Desktop адрес по умолчанию
— `http://host.docker.internal:11434/v1`, для запуска без контейнера
— `http://127.0.0.1:11434/v1`. Явный адрес задаёт
`DND_AI_OLLAMA_BASE_URL`.

При HTTP 401 или 402 текстовые роли переходят на Ollama. При работе без
ключа облачного провайдера используется только локальная модель. Летописец
и остальные текстовые роли учитывают её токены в общем журнале. Генерация
изображений по-прежнему использует ключ облачного провайдера.

### Бесплатный OpenRouter

Положите `OPENROUTER_API_KEY` в локальный `.env`. С этим ключом текстовые роли,
включая летописца, используют `openrouter/free`. Вместо маршрутизатора можно
выбрать до пяти бесплатных моделей с суффиксом `:free` через
`DND_AI_OPENROUTER_MODELS` (через запятую). При отказе или исчерпании квоты
текст может обслужить настроенный Ollama. Генерация изображений продолжает
использовать исходный ключ RouterAI.

В `turn-traces/<код кампании>/` поле `model_attempts` показывает роль, провайдера,
модель, время каждой попытки, код ошибки и наличие запрошенной JSON-схемы.
Причину перехода к Ollama видно в `fallback_reason`. `LLM_ATTEMPT_INTERRUPTED`
означает, что попытка ещё шла, когда ход завершил ожидание. В этих полях хранятся
только метаданные.

Роли в одном запросе игрока делят 12 секунд. При настроенной Ollama облаку
доступны первые 7 секунд, после чего следующие попытки идут в локальный
резерв. Ручной бросок создаёт отдельный запрос. Для однозначного осмотра
авторской улики движок обходится без вызова арбитра.

### Kaspersky и другие антивирусы с подменой HTTPS

`compose.override.yaml` прежнего JS-сервера к `compose.rust.yaml` не
относится. Rust-сервер (rustls) доверяет системному хранилищу корней;
дополнительный корень задаётся в `.env`:

```
DND_EXTRA_CA_CERTS=/app/local-ca/kaspersky-root.pem
```

`./local-ca` монтируется в `/app/local-ca` только для чтения (каталог в
`.gitignore`). Точка входа склеивает системные корни с этим файлом во
временный пакет и задаёт `SSL_CERT_FILE`. Если файл не читается, контейнер не
стартует с сообщением в логе — без тихих ошибок TLS при первом ходе.

## Перенос кампаний прежнего JS-сервера

Нужен один раз — на машине, где игра ещё шла на JS. Одной командой из папки
с `.env` и `storage`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\rust-cutover.ps1 -DryRun   # только пробный перенос
powershell -ExecutionPolicy Bypass -File tools\rust-cutover.ps1
```

Скрипт выполняет шаги ниже: останавливает прежний JS-контейнер (если жив), собирает образ, делает
пробный перенос (код 3 — остановка), копирует `./storage` в
`backups/storage-before-rust-<время>`, переносит, запускает `audit-storage`
(не 0 — остановка, прежний контейнер возвращается), пишет в `.env` `DND_SERVER=rust`,
`SKAZANIE_RUST_PORT=8787` и, если есть `local-ca/kaspersky-root.pem`,
`DND_EXTRA_CA_CERTS`, поднимает Rust-сервис с туннелем и ждёт `/api/health`.
Если в основной папке другая ветка, образ и `compose.rust.yaml` берутся из
копии main: `-File <копия>\tools\rust-cutover.ps1 -SourceRoot <копия>`,
запуск — из основной папки (`.env`, `storage`, `local-ca` — её).

Вручную:

1. Остановить прежний JS-контейнер, если жив:
   `docker compose -f archive/js-server/compose.yaml --project-directory . --profile public stop`.
2. Снимок старого хранилища: `pnpm backup` или копия `./storage`.
3. Пробный импорт — ничего не пишет, только сводка (перенос идёт в базу в
   памяти):

   ```bash
   docker compose -f compose.rust.yaml run --rm --no-deps      -v ./storage:/legacy-storage:ro skazanie-rust      import-legacy --from /legacy-storage --dry-run
   ```

   Код 3 — часть кампаний или комнат будет пропущена (причины в сводке):
   разобраться до настоящего импорта.
4. Импорт в том Rust-сервиса (`--to` по умолчанию — `DND_STORAGE_DIR`,
   `/app/storage`; пишет только в пустое хранилище):

   ```bash
   docker compose -f compose.rust.yaml run --rm --no-deps      -v ./storage:/legacy-storage:ro skazanie-rust      import-legacy --from /legacy-storage
   ```

   `./storage` монтируется только для чтения — импорт его не меняет.
5. Аудит импортированного хранилища — `audit-storage`: журнал против replay,
   подтверждение проекции и комнаты (накладки `room_overlays`) против головы
   журнала. Аудит читает временную копию базы и её WAL. Для неё требуется
   свободное место в каталоге временных файлов контейнера. Проверяются
   существующие таблицы; файл без схемы журнала даёт отказ. Исходное хранилище только читается;
   на хранилище работающего сервера — отказ, поэтому сервис ещё не запущен:

   ```bash
   docker compose -f compose.rust.yaml run --rm --no-deps skazanie-rust audit-storage
   ```

   Коды выхода: 0 — блокеров нет; 1 — есть блокеры (`REPLAY_DIVERGENCE`,
   `PROJECTION_DIVERGENCE`, `PROJECTION_VERSION_DIVERGENCE`,
   `ROOM_PROJECTION_MISSING`, `EVENT_STREAM_MISSING`, …; полный отчёт —
   `--json`); 2 — неверные аргументы; 3 — отказ (нет базы, работает сервер,
   база не читается). При коде 1 не запускать: расхождение комнаты сверка при
   старте приведёт к журналу, а причину расхождения лучше увидеть до этого.
6. Порт: `SKAZANIE_RUST_PORT=8787` в `.env` (или в окружении) и
   `docker compose -f compose.rust.yaml up -d`.
7. Проверить `docker compose -f compose.rust.yaml ps` (healthy), войти,
   открыть кампанию.

Туннель — свой сервис `tunnel` в `compose.rust.yaml` (профиль `public`,
`skazanie-rust:8787`); каталог состояния тот же, `storage/generated/.tunnel`,
и `STATUS_DND.cmd` показывает ссылку оттуда. Лаунчер перед запуском гасит
прежний JS-контейнер, если он жив: оба слушают 8787. `START_SITES_DND.cmd`
подключается к уже запущенному Rust-серверу или отказывает с подсказкой.

## Отката на JS нет

JS-сервер в архиве (`archive/js-server/README.md`). Игры, сыгранные на Rust,
есть только в томе `skazanie-rust_storage`; обратного импорта в JS-формат нет.
Возврат JS-сервера — решение владельца (`AGENTS.md` §9).

## Резервная копия тома

Копию снимает сам бинарь, подкоманда `backup`: тот же зашифрованный формат,
что у `pnpm backup` (архив одного проверяется и восстанавливается другим),
ключ — `DND_BACKUP_KEY` из `.env` не короче 32 байт. Без того же ключа
восстановить копию нельзя. Том с хоста не виден, поэтому подкоманда
запускается в том же образе. Сервис на это время остановлен. Пока сервер
пишет, копия отказывает (`BACKUP_WRITER_ACTIVE`):

```bash
docker compose -f compose.rust.yaml stop skazanie-rust
docker compose -f compose.rust.yaml run --rm --no-deps -v ./backups:/app/backups skazanie-rust backup
docker compose -f compose.rust.yaml start skazanie-rust
```

Файл — `./backups/skazanie-<дата>.skzbackup`. Проверка и восстановление:

```bash
docker compose -f compose.rust.yaml run --rm --no-deps -v ./backups:/app/backups skazanie-rust backup verify /app/backups/<файл>
skazanie-server backup restore <файл> <пустой-каталог>      # или pnpm backup -- restore …
```

`verify` проверяет шифрование и SHA-256 каждого файла, а не целостность
кампаний; после восстановления — `skazanie-server audit-storage --storage
<каталог>`. Справка — `skazanie-server backup --help`.

Незашифрованный архив тома без ключа (на случай, когда ключа нет):

```bash
docker compose -f compose.rust.yaml stop
docker run --rm -v skazanie-rust_storage:/data:ro -v ./backups:/backup debian:bookworm-slim \
  tar czf /backup/rust-storage.tgz -C /data .
docker compose -f compose.rust.yaml start
```

В нём данные игроков открытым текстом, хранить как `./backups`.
