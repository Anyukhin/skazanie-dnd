# Production readiness и release gates

> **Статус этапа 8:** legacy/shadow runtime уже удалён. Release gate для
> существующих данных остаётся закрыт до зелёного `pnpm cutover:verify`,
> restore rehearsal и завершённого rollback window.

## Контентный шлюз

Обычная проверка целостности:

```powershell
pnpm content:verify
```

Команда проверяет:

- SHA-256 и размер каждого зарегистрированного content artifact;
- полноту реестра всех файлов `public/assets`;
- Rule Pack, ontology и ссылки `rule.entity_refs → glossary`;
- formalization counts из `coverage.yaml`;
- ссылки spell overrides, spells, classes и character-build catalog;
- runtime-счётчики classes/subclasses/spells/monsters/equipment/glossary;
- наличие обязательного SRD 5.2.1 attribution statement.

Строгий release gate:

```powershell
pnpm release:verify
```

Он выполняет те же проверки и возвращает ненулевой код, пока существует хотя
бы один content, licensing или provenance blocker. Текущий отказ ожидаем:
корпус SRD неполон, лицензия проекта не выбрана, права на dnd.su compatibility
catalog и визуальные assets не подтверждены, fonts/container digests не
зафиксированы. Эти блокеры нельзя закрывать предположением.

Источники истины:

- `data/rules-coverage-matrix.json`;
- `data/content-provenance.json`;
- `data/asset-rights.json`;
- `ATTRIBUTION.md`;
- `THIRD_PARTY_NOTICES.md`.

Изменение зарегистрированного файла требует осознанного обновления его hash,
размера, источника и rights status. Обновлять hash без проверки происхождения
нельзя.

## Зашифрованные backup и restore rehearsal

Ключ передаётся только через environment и должен иметь не менее 32 UTF-8
байт:

```powershell
$env:DND_BACKUP_KEY='<secret from deployment secret manager>'
pnpm backup -- create .\storage D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- verify D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- compare .\storage D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- restore D:\backups\skazanie-2026-07-24.skzbackup D:\restore-rehearsal\empty
```

Формат использует `scrypt` и `AES-256-GCM`, не пишет ключ или открытые данные в
manifest, проверяет authenticated envelope и SHA-256 каждого файла. Backup
создаётся только вне исходного storage и не перезаписывает существующий файл.
Restore разрешён только в отсутствующий или пустой каталог; замена рабочего
storage выполняется отдельно после успешного compare/rehearsal.

Необходимо хранить ключ отдельно от backup, проверять восстановление по
расписанию и применять retention policy средствами deployment. Автоматическое
удаление старых backup намеренно не включено в приложение.

## Quota и cost observability

`DND_AI_DAILY_TOKEN_LIMIT` задаёт дневной предел, по умолчанию `2000000`.
Перед запросом резервируется оценка input + максимального output; после ответа
записываются фактические provider tokens/cost. Ledger находится в
`storage/engine/llm-usage.json`, не содержит prompts и переживает restart.
Зависшие reservations освобождаются через 15 минут, записи старше 31 дня
удаляются при следующей операции.

Администратор читает агрегаты через `GET /api/admin/usage`. Публичный
`/api/health` не раскрывает стоимость и квоту. Fallback client сохраняет
ограничение tool calls/timeouts и circuit-breaker cooldown для проблемных
моделей.

## Незакрытые production gates

- заменить partial compatibility catalogs полным разрешённым SRD 5.2.1
  corpus и deterministic/structured coverage;
- принять лицензию собственного кода и подтвердить права на assets/fonts;
- закрепить container images digest-ами и сформировать полный SBOM;
- выполнить реальный provider E2E, load/chaos/restore soak и multi-process
  coordination;
- провести canary/rollback window до удаления `legacy/shadow`;
- определить deployment-level encryption at rest, backup retention и key
  rotation.
