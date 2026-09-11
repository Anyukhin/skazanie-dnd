#!/usr/bin/env node
/** Подготовка и активация целого выпуска окружения без записи промежуточных результатов в сайт. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { importEnvironmentModels, validateCandidateOutputDir } from './import-environment-models.mjs'
import { addInteriorModelsToCandidate } from './build-interior-models.mjs'
import { startPropModelAtlas } from './render-prop-model-atlas.mjs'
import { validateEnvironmentCandidate } from './environment-candidate.mjs'
import { registerAssets } from './register-asset-rights.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const URL_ROOT = '/assets/models/environment/'
const RECEIPT = 'receipt.json'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

function localPath(url) {
  if (typeof url !== 'string' || !url.startsWith(URL_ROOT)) throw new Error('Файл не относится к каталогу окружения')
  const path = url.slice(URL_ROOT.length)
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\%?#:]/u.test(path)) throw new Error('Небезопасный путь ассета')
  return path
}

/** Переносим уже записанный файл в пределах того же каталога. */
export async function replaceFileAtomically(path, bytes) {
  const pending = `${path}.${randomUUID()}.tmp`
  const handle = await open(pending, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await rename(pending, path)
  } finally {
    await handle.close()
    await rm(pending, { force: true })
  }
}

export async function sealEnvironmentCandidate(directory) {
  await validateCandidateOutputDir(directory, { requireExisting: true })
  const checked = await validateEnvironmentCandidate(directory, { checkReceipt: false })
  if (checked.manifest.build?.schema !== 'environment-candidate/v1') throw new Error('Нет метаданных сборки кандидата')
  await replaceFileAtomically(join(directory, RECEIPT), jsonBytes({
    schema: 'environment-candidate-receipt/v1', fingerprint: checked.fingerprint, files: checked.files,
  }))
  return checked
}

export async function prepareEnvironmentAssets(options, {
  importModels = importEnvironmentModels, addInteriors = addInteriorModelsToCandidate, startAtlas = startPropModelAtlas,
} = {}) {
  if (!options.outputDir) throw new Error('Укажите --out для каталога кандидата')
  if (options.port != null && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Порт должен быть целым числом от 0 до 65535')
  const imported = await importModels(options)
  const directory = resolve(imported.directory ?? options.outputDir)
  await addInteriors(directory)
  let resolveDone, rejectDone
  const done = new Promise((resolveValue, rejectValue) => { resolveDone = resolveValue; rejectDone = rejectValue })
  const server = await startAtlas({
    directory, port: options.port ?? 0,
    async onSaved() {
      try { resolveDone(await sealEnvironmentCandidate(directory)) }
      catch (error) { rejectDone(error); throw error }
    },
  })
  process.stdout.write(`Модели подготовлены. Откройте ${server.url} и нажмите «Создать 2D-виды».\n`)
  try { return await done } finally { await server.close() }
}

async function readOptional(path) {
  try { return await readFile(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function ensureSame(path, expected) {
  const current = await readOptional(path)
  if (expected === null ? current !== null : !current?.equals(expected)) throw new Error(`Файл изменился во время подготовки: ${path}`)
}

function below(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

async function removeOwnedDirectory(directory, parent) {
  const actual = await realpath(directory)
  const actualParent = await realpath(parent)
  if (!samePath(actual, directory) || samePath(actualParent, actual) || !below(actualParent, actual)) throw new Error('Небезопасный путь очистки каталога')
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** Каталоги публикации не должны вести через symlink в чужие данные. */
async function assertRealTarget(root, directory) {
  const resolvedRoot = await realpath(root)
  let existing = directory
  while (true) {
    try {
      const actual = await realpath(existing)
      if (!below(resolvedRoot, actual) || !samePath(actual, existing)) throw new Error('Каталог публикации выходит за пределы проекта или является ссылкой')
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
}

/**
 * Сначала сохраняются все файлы неизменяемого выпуска, затем реестр и каталог.
 * Каталог — точка активации: старые вкладки продолжают читать прежние URL.
 * При обработанной ошибке записи возвращается предыдущий реестр.
 */
export async function publishEnvironmentCandidate(directory, {
  rootDir = ROOT, dryRun = false, replaceFile = replaceFileAtomically,
} = {}) {
  const root = await realpath(resolve(rootDir))
  await validateCandidateOutputDir(directory, { requireExisting: true })
  const candidate = await realpath(resolve(directory))
  const publicAssets = join(root, 'public', 'assets')
  const activeDirectory = join(publicAssets, 'models', 'environment')
  if ([publicAssets, ...['data', 'storage', '.git', 'node_modules'].map((path) => join(root, path))].some((path) => below(path, candidate))) throw new Error('Кандидат должен находиться вне рабочих ассетов и данных')
  await assertRealTarget(root, activeDirectory)
  await assertRealTarget(root, join(root, 'data'))
  await assertRealTarget(root, join(activeDirectory, 'manifest.json'))
  await assertRealTarget(root, join(root, 'data', 'asset-rights.json'))
  await assertRealTarget(root, join(activeDirectory, 'releases'))
  const checked = await validateEnvironmentCandidate(candidate)
  if (checked.manifest.build?.schema !== 'environment-candidate/v1') throw new Error('Нет метаданных сборки кандидата')
  const receiptBytes = await readOptional(join(candidate, RECEIPT))
  if (!receiptBytes) throw new Error('Кандидат ещё не принят: выполните models:check --dir <кандидат>')
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  if (receipt.schema !== 'environment-candidate-receipt/v1' || receipt.fingerprint !== checked.fingerprint) throw new Error('Кандидат изменился после проверки: повторите models:prepare или проверку атласа')
  const releaseId = checked.fingerprint.slice(0, 24)
  const releaseUrl = `${URL_ROOT}releases/${releaseId}/`
  const manifest = structuredClone(checked.manifest)
  manifest.models = manifest.models.map((entry) => ({ ...entry, url: releaseUrl + localPath(entry.url) }))
  manifest.atlas = { ...manifest.atlas, image: releaseUrl + localPath(manifest.atlas.image) }
  manifest.release = { schema: 'environment-release/v1', id: releaseId, fingerprint: checked.fingerprint,
    files: checked.files.filter((file) => file.path !== 'manifest.json' && file.path !== RECEIPT) }
  const manifestBytes = jsonBytes(manifest)
  const summary = { releaseId, models: manifest.models.length, files: checked.files.length, fingerprint: checked.fingerprint }
  if (dryRun) return { ...summary, activated: false }

  const temporaryRoot = join(root, 'tmp')
  await assertRealTarget(root, temporaryRoot)
  await mkdir(temporaryRoot, { recursive: true })
  const lockPath = join(temporaryRoot, 'environment-publication.lock')
  let lock
  try { lock = await open(lockPath, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Публикация окружения уже выполняется; проверьте environment-publication.lock после прерванного процесса')
    throw error
  }
  let stage
  const activeManifest = join(activeDirectory, 'manifest.json')
  const registryPath = join(root, 'data', 'asset-rights.json')
  const releaseDirectory = join(activeDirectory, 'releases', releaseId)
  let addedRelease = false
  let metadataTouched = false
  let retainStage = false
  let activated = false
  const cleanupWarnings = []
  let oldManifest
  let oldRegistry
  let newRegistry
  try {
    await lock.writeFile(jsonBytes({ pid: process.pid, releaseId }))
    oldManifest = await readFile(activeManifest)
    oldRegistry = await readFile(registryPath)
    stage = await mkdtemp(join(temporaryRoot, 'environment-publication-'))
    await writeFile(join(stage, 'previous-asset-rights.json'), oldRegistry)
    await writeFile(join(stage, 'previous-manifest.json'), oldManifest)
    const stagedAssets = join(stage, 'assets')
    const stagedRelease = join(stagedAssets, 'models', 'environment', 'releases', releaseId)
    const relativePaths = []
    for (const file of checked.files) {
      if (file.path === RECEIPT) continue
      const path = file.path
      if (path.split('/').some((part) => part === '..' || !part) || /[\\:]/u.test(path)) throw new Error('Небезопасный файл кандидата')
      const bytes = await readFile(join(candidate, path))
      if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error(`Кандидат изменился: ${path}`)
      const destination = join(stagedRelease, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, path === 'manifest.json' ? manifestBytes : bytes)
      relativePaths.push(`models/environment/releases/${releaseId}/${path}`)
    }
    const stagedManifest = join(stagedAssets, 'models', 'environment', 'manifest.json')
    await writeFile(stagedManifest, manifestBytes)
    const stagedRegistry = join(stage, 'asset-rights.json')
    await writeFile(stagedRegistry, oldRegistry)
    registerAssets([...relativePaths, 'models/environment/manifest.json'], stagedRegistry, { assetsRoot: stagedAssets })
    newRegistry = await readFile(stagedRegistry)
    await assertRealTarget(root, releaseDirectory)
    await assertRealTarget(root, join(releaseDirectory, 'manifest.json'))
    const existingManifest = await readOptional(join(releaseDirectory, 'manifest.json'))
    if (existingManifest) {
      if (!existingManifest.equals(manifestBytes)) throw new Error('Неизменяемый выпуск с таким ID уже имеет другое содержимое')
      for (const path of relativePaths) {
        await assertRealTarget(root, join(publicAssets, path))
        const expected = await readFile(join(stagedAssets, path))
        await ensureSame(join(publicAssets, path), expected)
      }
    } else {
      try { await stat(releaseDirectory); throw new Error('Каталог выпуска уже существует без корректного manifest') } catch (error) { if (error.code !== 'ENOENT') throw error }
      await mkdir(dirname(releaseDirectory), { recursive: true })
      await rename(stagedRelease, releaseDirectory)
      addedRelease = true
    }
    await ensureSame(registryPath, oldRegistry)
    await ensureSame(activeManifest, oldManifest)
    metadataTouched = true
    await replaceFile(registryPath, newRegistry)
    await replaceFile(activeManifest, manifestBytes)
    activated = true
    return { ...summary, activated: true, cleanupWarnings }
  } catch (error) {
    if (metadataTouched) {
      try {
        const currentManifest = await readFile(activeManifest)
        const currentRegistry = await readFile(registryPath)
        if ((!currentManifest.equals(oldManifest) && !currentManifest.equals(manifestBytes))
          || (!currentRegistry.equals(oldRegistry) && !currentRegistry.equals(newRegistry))) throw new Error('Метаданные изменены другим процессом')
        if (!currentManifest.equals(oldManifest)) await replaceFileAtomically(activeManifest, oldManifest)
        if (!currentRegistry.equals(oldRegistry)) await replaceFileAtomically(registryPath, oldRegistry)
        metadataTouched = false
      } catch (rollbackError) {
        retainStage = true
        throw new AggregateError([error, rollbackError], `Не удалось восстановить метаданные. Резервные копии сохранены: ${stage}`)
      }
    }
    if (addedRelease && !metadataTouched) {
      // Проверка исключает удаление выпуска, который успел использовать другой процесс.
      await ensureSame(activeManifest, oldManifest)
      await ensureSame(registryPath, oldRegistry)
      await removeOwnedDirectory(releaseDirectory, join(activeDirectory, 'releases'))
    }
    throw error
  } finally {
    try {
      if (stage && !retainStage) {
        if (!below(temporaryRoot, resolve(stage)) || !stage.startsWith(join(temporaryRoot, 'environment-publication-'))) throw new Error('Небезопасный путь временного каталога')
        try { await removeOwnedDirectory(stage, temporaryRoot) } catch (error) {
          if (!activated) throw error
          cleanupWarnings.push(`Выпуск активирован, временный каталог остался: ${stage}: ${error.message}`)
        }
      }
    } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    out: { type: 'string' }, dir: { type: 'string' }, port: { type: 'string' }, 'dry-run': { type: 'boolean' },
    'quaternius-dir': { type: 'string' }, 'kenney-dir': { type: 'string' },
    'quaternius-archive': { type: 'string' }, 'kenney-archive': { type: 'string' },
  }, allowPositionals: true })
  const command = positionals[0]
  if (positionals.length !== 1) throw new Error('Нужна одна команда: prepare, check или publish')
  let result
  if (command === 'prepare') {
    result = await prepareEnvironmentAssets({ outputDir: values.out, port: values.port ? Number(values.port) : 0,
      quaterniusDir: values['quaternius-dir'], kenneyDir: values['kenney-dir'],
      quaterniusArchive: values['quaternius-archive'], kenneyArchive: values['kenney-archive'],
    })
    result = { ready: true, directory: resolve(values.out), fingerprint: result.fingerprint, models: result.manifest.models.length }
  } else if ((command === 'publish' || command === 'check') && values.dir) {
    result = command === 'publish'
      ? await publishEnvironmentCandidate(values.dir, { dryRun: values['dry-run'] })
      : await sealEnvironmentCandidate(values.dir).then((value) => ({ valid: true, fingerprint: value.fingerprint, models: value.manifest.models.length, files: value.files.length }))
  } else throw new Error('Используйте prepare --out <кандидат>, check --dir <кандидат> или publish --dir <кандидат> [--dry-run]')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
