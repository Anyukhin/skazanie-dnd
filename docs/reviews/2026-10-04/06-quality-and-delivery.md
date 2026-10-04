# Ревью качества поставки и эксплуатации

Срез сделан на коммите `c7efdca614cc33f706258d036e86f01c1f189404`. Область —
тестовый harness, TypeScript-проверка, CI, toolchain, eval, контейнерная
поставка и provenance контента. Это не вывод о бесполезности корпуса: в дереве
592 файла `test/*.test.mjs`, отдельные HTTP-сценарии, replay-проверки,
изоляция сети и performance budget уже закрывают большую часть доменных
регрессий. Baseline, который запустил root для этого ревью: 13 budget-, 5643
functional- и 5 MVP-проверок прошли, 6 были пропущены. Ниже перечислены места,
где следующий расширяющий PR может обойти существующий gate или получить
нестабильный результат.

## QA-01 — CI не проверяет CLI-границы release-контрактов

**Тип:** limitation / delivery gap. **Приоритет:** P2. **Оценка:** S–M.

Основные проверки уже входят в `pnpm test`: реальный репозиторий проходит
`verifyContentIntegrity` и проверку намеренно закрытого release-gate в
[`test/content-integrity.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/content-integrity.test.mjs#L61-L126);
loader и локальные SHA compendium проверяются в
[`test/dndsu-2014-content.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/dndsu-2014-content.test.mjs#L20-L39),
override и acceptance — в
[`test/spell-override-audit.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/spell-override-audit.test.mjs#L6-L30)
и [`test/spell-acceptance-audit.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/spell-acceptance-audit.test.mjs#L22-L40),
а replay/projection cutover — в
[`test/cutover-audit.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/cutover-audit.test.mjs#L42-L131).
Поэтому утверждение «content-аудита в CI нет» было бы неверным.

Фактическая разница остаётся в CLI-обвязке и строгом режиме: workflow
[`verify.yml`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/.github/workflows/verify.yml#L42-L49) запускает только
`pnpm test`, `pnpm typecheck:server` и `pnpm build`, хотя scripts в
[`package.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/package.json#L19-L30) отдельно объявляют
`content:verify`, `compendium:verify`, `spells:verify`, `cutover:verify` и
`release:verify`. Тесты вызывают функции напрямую; они не проверяют parsing
argv, формат CLI-отчёта и ненулевой exit code строгих wrapper-ов
[`verify-content-integrity.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/verify-content-integrity.mjs#L3-L15),
[`verify-spell-overrides.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/verify-spell-overrides.mjs#L4-L18)
и [`audit-cutover.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/audit-cutover.mjs#L1-L10), а путь
`compendium:verify --repository-loader` не запускается как отдельный CLI.
Особенно
важен `release:verify`: его red status ожидаем из-за открытых правовых и
coverage blockers, но сейчас нет отдельного release job, который бы проверял
саму границу выпуска.

Предлагается добавить короткий CLI-smoke job, который не дублирует весь
content suite: на временной копии проверяет exit code/JSON для
`content:verify`, `compendium:verify --repository-loader`, `spells:verify`,
`cutover:verify --strict` и
`release:verify`; полный functional gate остаётся единственным запуском
`pnpm test`. Path-aware job для `data/**` и `public/assets/**` может сохранять
JSON artifacts с commit SHA, но должен использовать уже существующие функции.
Критерий: изменение wrapper-а, argv или exit code ломает CLI-smoke; обычный
UI-only PR не ждёт повторного полного content-аудита.

## QA-02 — Серверная проверка типов имеет незакрытую поверхность

**Тип:** defect in verification surface. **Приоритет:** P1. **Оценка:** S–M.

[`tsconfig.server.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tsconfig.server.json#L19-L43) содержит явный
список из 24 файлов. Фактически
в сервере 36 файлов начинаются с `// @ts-check`. Список файлов программы,
полученный через `tsc --listFilesOnly`, не содержит пять таких модулей:
[`party-exit-intent.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/party-exit-intent.mjs),
[`reveal-transport.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/reveal-transport.mjs),
[`map-import-routes.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/routes/map-import-routes.mjs),
[`world-ontology.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/world-ontology.mjs) и
[`world-template-catalog.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/world-template-catalog.mjs). Это
особенно неприятно для route и
catalog-кода: JSDoc-ошибка в одном из этих файлов не обязана влиять на текущие
включённые импорты и поэтому может остаться незамеченной. Комментарий в
[`AGENTS.md`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/AGENTS.md#L17-L24) уже говорит о другом количестве
файлов, так что документация добавляет ещё один источник рассинхронизации.

Безопаснее сохранить явный include как локальный контракт и добавить сторож,
который строит список `@ts-check` и проверяет его присутствие в
`tsc --listFilesOnly`; так случайное расширение `server/**/*.mjs` не включит
новую поведенческую ветку только потому, что в ней появился комментарий.
Генерируемый explicit include допустим, если результат виден в diff. Критерий:
отчёт показывает `36/36`, а намеренная JSDoc-ошибка в любом из пяти сейчас
пропущенных модулей ломает `typecheck:server`.

## QA-03 — Runtime и package-manager не закреплены одним контрактом

**Тип:** reproducibility limitation. **Приоритет:** P2. **Оценка:** S.

[`package.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/package.json#L6-L7) фиксирует только нижнюю границу
Node `>=20.19.0`,
`packageManager` отсутствует. CI использует `node-version: 22` и
`pnpm/action-setup` с `version: 10`
([`verify.yml`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/.github/workflows/verify.yml#L25-L35)), а
[`Dockerfile`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/Dockerfile#L1-L11) берёт подвижный тег `node:22-alpine`.
Локальный baseline этого
среза — Node 24.19 и pnpm 11.19. `--frozen-lockfile` защищает версии пакетов,
но не поведение TypeScript/Vite/Node или сам pnpm между этими окружениями.

Нужно выбрать поддерживаемый toolchain, добавить точный `packageManager`,
`.node-version` и использовать тот же patch-level в CI и Docker; базовый образ
лучше закрепить digest. Отдельный min-version job может проверять заявленные
20.19, а основной — один воспроизводимый образ. Критерии: новая машина и CI
печатают одинаковые версии pnpm, `pnpm install --frozen-lockfile` не меняет
lockfile, а Docker и CI дают одинаковый результат `build`.

## QA-04 — HTTP-тесты частично используют случайные фиксированные порты

**Тип:** flaky-test risk. **Приоритет:** P2. **Оценка:** M.

В большинстве API-тестов уже есть [`free-port.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/free-port.mjs#L12-L21),
но четыре сценария обходят его и выбирают диапазон арифметикой:
[`api-integration.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/api-integration.test.mjs#L22),
[`ruleset-selection-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/ruleset-selection-api.test.mjs#L30),
[`solo-party-exit-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/solo-party-exit-api.test.mjs#L26) и
[`world-template-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/world-template-api.test.mjs#L38).
При `--test-concurrency=4` и повторном
запуске такой порт может быть занят другим тестом или сторонним процессом.
Даже helper `freePort` освобождает порт до запуска дочернего Node-процесса,
поэтому он уменьшает, но не устраняет race. Одинаковая логика
`spawn`/health/stop также размножена по HTTP-файлам.

Следует свести запуск к одному fixture-helper: временное storage, собственный
env, запуск с портом 0 и handshake с фактически назначенным портом (или хотя бы
сначала мигрировать четыре фиксированных случая на общий helper). Cleanup
должен ждать завершения дочернего процесса и удалять storage. Проверка — 100
стартов/остановок focused harness и несколько targeted concurrent API-тестов с
concurrency 8 на чистой машине: ноль `EADDRINUSE`, ноль оставшихся дочерних
`server/index.mjs`, нулевая зависимость от занятого пользовательского порта.
Полный `pnpm test` для этого критерия достаточно прогнать один раз.

## QA-05 — Сетевой сторож тестов основан на хрупком regex

**Тип:** security / test-isolation limitation. **Приоритет:** P1. **Оценка:** M.

[`run-test-suite.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/run-test-suite.mjs#L18-L22) и
[`run-test-suite.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/run-test-suite.mjs#L35-L37) передают
дочерним test-процессам `process.env` целиком.
[`test-network-isolation.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/test-network-isolation.test.mjs#L32)
распознаёт
только буквально записанный вызов `spawn(process.execPath,
['server/index.mjs'])`. В дереве уже есть безопасные, но невидимые для этого
regex формы: [`mvp-player-cycle-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/mvp-player-cycle-api.test.mjs#L156)
и [`shillelagh-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/shillelagh-api.test.mjs#L17) добавляют
`--import`, [`projection-postcommit-error-api.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/projection-postcommit-error-api.test.mjs#L14)
использует многострочный массив, а [`store-regression.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/store-regression.test.mjs#L71)
запускает inline Node-код. Сейчас эти места
явно сбрасывают ключ там, где поднимают сервер, но следующий тест с другой
формой запуска может унаследовать настоящий `ROUTERAI_API_KEY` из `.env`.
Комментарии самого сторожа (`test/test-network-isolation.test.mjs:9-18`)
подтверждают, что отсутствие ключа в env — опасный случай, а не формальность.

Основной барьер должен быть runtime: общий `spawnTestServer` формирует env с
пустым LLM-ключом по умолчанию и принимает локальный endpoint только явным
параметром. Regex оставить как дополнительный lint, но заменить его проверкой
AST или тестировать единый helper. Критерий: запуск suite с sentinel-ключом в
родительском env не делает ни одного внешнего LLM-запроса; локальная заглушка
работает только после явной передачи адреса; новый spawn без безопасного env
ломает тест до CI.

## QA-06 — Provenance покрывает перечисленные артефакты, но не весь `data/`

**Тип:** data-integrity / rights limitation. **Приоритет:** P1. **Оценка:** M–L.

[`content-integrity.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/content-integrity.mjs#L290-L317) проверяет
каждый artifact из `data/content-provenance.json` и весь `public/assets`, но не требует, чтобы
каждый отслеживаемый файл в `data/` был объявлен. На срезе 24 файла остаются
вне root-списка artifacts, включая `data/compendia/dnd_5e_2014/**`,
`data/rules-coverage-matrix.json`, `data/character-rules-manifest.json` и
`data/talespire-assets-v1.json`. У compendium есть собственный manifest с
хешами, и loader проверяет его содержимое через
[`dndsu-2014-content.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/dndsu-2014-content.mjs#L213-L234),
поэтому это не утверждение о непроверенном текущем compendium. Разрыв в
едином inventory остаётся для лишних файлов и каталогов вне этих nested
manifests. JSON Schema в `data/compendia/dnd_5e_2014/schemas/` не ссылается ни
один runtime/tool-файл (`git grep` по этим именам пуст); текущий loader
использует handwritten-проверки.

Это не означает, что текущие catalogs невалидны; означает, что новый лишний
файл или изменение schema может попасть в PR без root-level provenance и без
проверки именно этой schema. Нужен один авторитетный inventory: либо root-manifest с явными
`generated/excluded` группами и проверкой отсутствующих файлов, либо отдельные
полные manifests, автоматически сверяемые с root. Schema files следует либо
выполнять на каждом catalog, либо удалить как неисполняемый контракт и
описать handwritten validator. Критерии: добавленный файл без записи делает
`content:verify` красным; изменение schema и нарушение required field ловятся
тем же job; source, rights и hash присутствуют для каждой поставляемой записи.

## QA-07 — Production-образ не содержит maintenance-инструменты

**Тип:** limitation slim runtime (defect только если image обещан как
maintenance shell). **Приоритет:** P2. **Оценка:** S–M.

[`.dockerignore`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/.dockerignore#L27-L30) исключает `eval/*` (кроме
combat lab), `tools` и `test`. [`Dockerfile`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/Dockerfile#L14-L20) в
runtime копирует `package.json`, `node_modules`, `dist`, `server`, один
eval-файл, `data` и `prompts`, но не `tools`. При этом
[`package.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/package.json#L19-L29) публикует команды
`content:verify`, `compendium:verify`, `cutover:audit`, `backup` и другие
maintenance-команды. В таком образе эти команды действительно недоступны, но
README описывает их как host-команды в разделе production-readiness
([`README.md`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/README.md#L722-L731)), а Docker-раздел обещает запуск
приложения, а не maintenance shell ([`README.md`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/README.md#L873-L882)).
Это не доказанный runtime defect: проблема в том, что граница образа не
закреплена отдельным runbook-ом. Дополнительный release blocker
[`content-provenance.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/data/content-provenance.json#L207-L213)
отмечает `CONTAINER_DIGESTS_UNPINNED`.

Нужно явно разделить runtime и maintenance: либо добавить отдельный target
образа с `tools` и documented `docker run`, либо оставить slim runtime, но
дать host-side runbook и проверять его в CI. В staging нужен smoke: health,
restart, миграция dry-run, backup/restore rehearsal и запись результата; для
публичного Sites/tunnel путь пока документирован как требующий групповой
приёмки ([`sites-local-hosting.md`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/sites-local-hosting.md#L75-L82)).
Критерий: оператор одной задокументированной host-side командой проверяет
backup и восстановление, а runtime image проходит health/restart без доступа к
секретам и без writable root filesystem.

## QA-08 — Eval-стенды есть, но результат не является воспроизводимым gate

**Тип:** evaluation / delivery limitation. **Приоритет:** P2. **Оценка:** M.

В `eval/` уже есть детерминированные retrieval, autonomy, campaign и
performance harnesses, а также live RouterAI-прогоны. Но в
[`package.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/package.json#L15) как discoverable command опубликован
только `combat:lab`; остальные скрипты запускаются длинными вручную
записанными командами. JSON-отчёты вроде
[`graph-retrieval-after-2026-10-01.json`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/eval/graph-retrieval-after-2026-10-01.json#L1-L20)
содержат `generated_at` и метрики, но не commit SHA, hash набора, версию
prompt/code или lockfile. Live-скрипты
([`structured-outputs-probe-2026-10-01.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/eval/structured-outputs-probe-2026-10-01.mjs#L16-L25))
читают `.env` и
расходуют внешний бюджет, поэтому их нельзя безопасно включить в обычный CI.

Полезен не новый стенд, а каталог существующих eval: `id`, `deterministic` или
`live`, command, seed, dataset/prompt hashes, budget и threshold. Для offline
профиля нужен один package command и PR gate на отсутствие утечек, replay
расхождений и регресс latency; live profile — ручной или nightly с отдельным
credential и сохранённым artifact. Каждый отчёт должен записывать commit,
Node/pnpm, ОС, model profile и input hashes. Критерий: повтор offline eval на
том же commit даёт тот же summary, а изменение prompt/data без обновления
baseline делает отчёт несопоставимым и останавливает job.

## Измеримые SLO и benchmarks

Следующие числа — предложения для калибровки после нескольких замеров на
стандартизированном runner, а не текущие требования проекта и не результаты
этого единственного среза:

- **Изоляция:** внешний LLM/embedding egress из `pnpm test` — 0; flake rate
  suite — не более 1% в серии из 100 focused повторов; `EADDRINUSE` и orphan
  server — 0.
- **Поставка:** fast PR gate p95 ≤ 15 минут, полный verify p95 ≤ 25 минут на
  стандартизированном runner; timeout не должен маскировать разброс. Текущий
  [`workflow`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/.github/workflows/verify.yml#L17-L20) допускает 50 минут,
  это полезная аварийная граница, но не SLO.
- **Типы и provenance:** 36/36 `@ts-check` файлов в программе TypeScript;
  100% отслеживаемых `data/` и `public/assets` либо имеют запись manifest,
  либо явно перечислены как generated/excluded.
- **Sites/runtime:** сохранить текущие целевые 3 секунды для main script и
  5 секунд для scene resources из [`sites-load-check.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/tools/sites-load-check.mjs#L40-L43), плюс
  успешный restart/backup rehearsal.
- **Eval:** leaks и replay mismatches — 0; для каждого набора публиковать
  recall/top-1, p50/p95 latency, cost и commit/input hashes. Baseline retrieval
  `recall@5=0.789`, `hop=0.578` из отчёта нужно считать точкой сравнения, а не
  универсальным продуктовым порогом без решения владельца.

## Самое маленькое улучшение

Самый дешёвый полезный шаг — добавить в CI job явный безопасный env
`ROUTERAI_API_KEY: ''` и сделать в `tools/run-test-suite.mjs` такой же deny-by-
default env для дочерних процессов. Это не требует зависимости или изменения
данных, сразу закрывает класс дорогостоящих сетевых случайностей и создаёт
понятный контракт для всех новых HTTP-тестов. Следом стоит одной правкой
расширить server typecheck surface и добавить его числовой сторож; эти две
маленькие меры дадут наибольшую отдачу до более дорогого staging и provenance
рефакторинга.
