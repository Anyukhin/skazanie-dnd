# Rust-сервер в Docker

Образ Rust-сервера (`Dockerfile.rust`) и его сервис (`compose.rust.yaml`)
живут рядом с JS-сервером (`Dockerfile`, `compose.yaml`) и его не заменяют.
Переключение — отдельный осознанный шаг владельца (ниже), откат — один
`docker compose up`.

| | JS-сервер | Rust-сервер |
| --- | --- | --- |
| Сборка | `Dockerfile` | `Dockerfile.rust` |
| Compose | `compose.yaml`, проект по каталогу | `compose.rust.yaml`, проект `skazanie-rust` |
| Порт на хосте | `127.0.0.1:8787` | `127.0.0.1:8788` (`SKAZANIE_RUST_PORT`) |
| Хранилище | `./storage` (bind) | том `skazanie-rust_storage` |
| Сертификат антивируса | `compose.override.yaml`, `NODE_EXTRA_CA_CERTS` | `DND_EXTRA_CA_CERTS` в `.env`, `./local-ca` |

## Что в образе

Три этапа:

1. **client** — `node:22-alpine`, `pnpm install --frozen-lockfile` и
   `pnpm build`, как в JS-образе; результат — `dist/`.
2. **server** — `rust:1.91.1-slim-bookworm` (версия — `ARG RUST_VERSION`;
   файла `rust-toolchain` в репозитории нет, 1.91.1 — тулчейн ветки),
   `cargo build --release --locked -p sk-server --bin skazanie-server`
   **без** `test-hooks`. Параллельность rustc — `ARG CARGO_BUILD_JOBS=3`.
   Кэш крейтов и `target` — кэш-тома BuildKit: повторная сборка
   перекомпилирует только изменённые крейты.
3. **runtime** — `debian:bookworm-slim`: `/app/skazanie-server`, `/app/data`,
   `/app/prompts`, `/app/dist`, `/app/public → dist` (сервер читает атлас
   реквизита и манифест окружения из `public/`, как JS), корневые сертификаты
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

## Запуск рядом с JS

```bash
docker compose -f compose.rust.yaml up -d --build
docker compose -f compose.rust.yaml ps          # STATUS: healthy
docker compose -f compose.rust.yaml logs -f skazanie-rust
```

Игра — `http://localhost:8788`. JS-сервис на 8787 продолжает работать: у
Rust-сервиса свой проект compose, своя сеть и свой том, `./storage` он не видит.
Хранилище нового тома пустое — первый вход через setup, как на новой машине.

Разовый запуск без compose (проверка образа, временный том, без модели):

```bash
docker run --rm -d --name skazanie-rust-check -p 127.0.0.1:18788:8787 \
  -v skazanie-rust-check:/app/storage -e ROUTERAI_API_KEY= skazanie-rust:local
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18788/api/health
docker rm -f skazanie-rust-check && docker volume rm skazanie-rust-check
```

### Kaspersky и другие антивирусы с подменой HTTPS

`compose.override.yaml` подхватывается только с `compose.yaml`, к
`compose.rust.yaml` он не относится. Rust-сервер (rustls) доверяет системному
хранилищу корней; дополнительный корень задаётся в `.env`:

```
DND_EXTRA_CA_CERTS=/app/local-ca/kaspersky-root.pem
```

`./local-ca` монтируется в `/app/local-ca` только для чтения (каталог в
`.gitignore`). Точка входа склеивает системные корни с этим файлом во
временный пакет и задаёт `SSL_CERT_FILE`. Если файл не читается, контейнер не
стартует с сообщением в логе — без тихих ошибок TLS при первом ходе.

## Переключение на 8787

1. Остановить JS-сервис: `docker compose stop skazanie` (с туннелем —
   `docker compose --profile public stop`).
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
5. Аудит импортированного хранилища — `audit-storage` (аналог
   `pnpm cutover:audit`): журнал против replay, подтверждение проекции и
   комнаты (накладки `room_overlays`) против головы журнала. Только читает;
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

Туннель (`tunnel`, профиль `public`) смотрит на `skazanie:8787` в сети
JS-проекта; для Rust-сервиса его нужно перенастроить отдельно — в этот шаг не
входит.

## Откат

```bash
docker compose -f compose.rust.yaml down     # том Rust-сервиса остаётся
docker compose up -d                         # JS-сервер на 8787, ./storage как был
```

Если после переключения в Rust-сервере шли игры, их события есть только в
томе `skazanie-rust_storage`; обратного импорта в JS-формат нет.

## Резервная копия тома

`pnpm backup` работает с `./storage`, том Rust-сервиса он не видит. Снять
архив тома (сервис остановлен, чтобы не копировать файлы на ходу):

```bash
docker compose -f compose.rust.yaml stop
docker run --rm -v skazanie-rust_storage:/data:ro -v ./backups:/backup debian:bookworm-slim \
  tar czf /backup/rust-storage.tgz -C /data .
docker compose -f compose.rust.yaml start
```

Архив не зашифрован — в нём данные игроков, хранить как `./backups`.
