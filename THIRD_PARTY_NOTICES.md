# Сведения о сторонних компонентах

Дата инвентаризации: 11 июля 2026 года.

## Метод

Версии взяты из локального `pnpm-lock.yaml`/установленных package manifests. License identifiers взяты из локального поля `license` соответствующего `node_modules/<package>/package.json`. Внешние URLs и hashes не приводятся: они не были зафиксированы как проверенные release metadata.

Этот список охватывает прямые npm dependencies текущего проекта. Он не является полным SBOM транзитивных packages и не заменяет тексты лицензий.

## Прямые npm dependencies

| Компонент | Версия | License identifier из package manifest | Роль |
|---|---:|---|---|
| `react` | 19.2.7 | MIT | UI runtime |
| `react-dom` | 19.2.7 | MIT | Browser rendering |
| `lucide-react` | 1.24.0 | ISC | UI icons |
| `dotenv` | 17.4.2 | BSD-2-Clause | Server environment loading |
| `vite` | 8.1.4 | MIT | Build/dev server |
| `@vitejs/plugin-react` | 6.0.3 | MIT | React build integration |

## Прямые development dependencies

| Компонент | Версия | License identifier из package manifest | Роль |
|---|---:|---|---|
| `typescript` | 7.0.2 | Apache-2.0 | Type checking |
| `@types/react` | 19.2.17 | MIT | Type declarations |
| `@types/react-dom` | 19.2.3 | MIT | Type declarations |

Локальные package directories содержали следующие notice files:

- React/React DOM: `LICENSE`;
- Lucide React: `LICENSE`;
- dotenv: `LICENSE`;
- Vite: `LICENSE.md`;
- Vite React plugin: `LICENSE`;
- TypeScript: `LICENSE` и `NOTICE.txt`.

Release pipeline должен собрать требуемые license texts из фактически установленного frozen lock, а не копировать их из этого summary вручную.

## Container/runtime components

Dockerfiles используют:

- образ семейства Node 22 Alpine для build/runtime;
- Alpine 3.22.5 для tunnel container;
- OpenSSH client, устанавливаемый package manager Alpine.

Image tags не закреплены content digest-ами, а полный package manifest образа не хранится в репозитории. Поэтому для каждого release необходимо:

1. записать фактические image digests;
2. экспортировать package/SBOM inventory собранных images;
3. сохранить license/notice files, требуемые дистрибуцией и OpenSSH packages;
4. повторить vulnerability scan.

Этот документ не утверждает единый license identifier для всей Alpine/Node/OpenSSH совокупности.

## Шрифты

`src/styles.css` загружает Manrope и Spectral через внешний Google Fonts stylesheet. Файлы шрифтов не vendored и локальная копия их license metadata отсутствует.

Текущая server CSP разрешает styles/fonts только с собственного origin (кроме inline styles), поэтому внешний stylesheet может быть заблокирован и UI перейдёт на fallback fonts. Расширение CSP не решает вопрос provenance: перед разрешением внешней загрузки или vendoring всё равно требуется проверенная запись об источнике и лицензии.

Для online deployment применимы условия внешнего сервиса. Для offline/self-contained release необходимо отдельно получить font files из подтверждённого источника, зафиксировать их license и hashes либо заменить системными шрифтами.

## Внешние сервисы

- RouterAI — внешний API для text/image generation.
- Pinggy — внешний reverse-tunnel service.

Они не являются vendored software components. Их условия, privacy/data-processing rules, quotas и доступность должны проверяться владельцем deployment отдельно. Наличие integration code не означает предоставление лицензии или SLA этими сервисами.

## Project assets с неизвестным provenance

Три PNG в `public/assets` не имеют подтверждённых source/license metadata. Они перечислены в `ATTRIBUTION.md` как `DO NOT DISTRIBUTE` до прояснения прав.

## Rule Pack

Текущий Rule Pack состоит из project-original paraphrases и помечен внутренним `ORIGINAL-PARAPHRASE`. Это не сторонний license identifier и не замена лицензии проекта. Коммерческие rulebook texts не включены.

## Обязанности перед релизом

- выполнить install строго из frozen lock;
- сформировать полный SBOM, включая transitive npm и container packages;
- приложить обязательные LICENSE/NOTICE texts;
- проверить asset/font/rule provenance;
- записать image/package/file digests фактического release;
- не переносить версии или notices из более раннего build без повторной проверки.
