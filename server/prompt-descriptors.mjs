import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Реестр промптов рядом с **реальными** загрузчиками — шаг 8
 * `docs/agent-architecture-plan.md`.
 *
 * До него единственным списком ролей был `covered` в `test/security.test.mjs`, и
 * он дважды расходился с кодом при слиянии веток: ветка поднимала версию
 * промпта, а список оставался прежним, и сторож молча пропускал роль.
 *
 * Здесь список объявлен один раз и сверяется с двумя источниками правды сразу:
 * с тем, что модуль действительно читает с диска, и с тем, что лежит в
 * `prompts/`. Расхождение в любую сторону — падение теста, а не тихое «ну и
 * ладно».
 */

const promptsRoot = new URL('../prompts/', import.meta.url)

/**
 * @typedef {{
 *   role: string,
 *   promptId: string,
 *   module: string,
 *   loads: boolean,
 * }} PromptDescriptor
 */

/**
 * Роли, у которых есть загружаемый промпт. `module` — файл, который читает его с
 * диска; `promptId` — версия, которая попадает в трассу.
 *
 * @type {PromptDescriptor[]}
 */
export const PROMPT_DESCRIPTORS = Object.freeze([
  Object.freeze({ role: 'npc_morale', promptId: 'npc_controller/v1', module: 'npc-controller.mjs', loads: true }),
  Object.freeze({ role: 'npc_social', promptId: 'npc_controller/social_v3', module: 'npc-social-controller.mjs', loads: true }),
  Object.freeze({ role: 'narrator', promptId: 'narrator/v6', module: 'narrator.mjs', loads: true }),
  // Режиссёр — единственная роль с вариантами: промпт выбирается режимом
  // импровизации кампании, поэтому один модуль объявляет два дескриптора.
  Object.freeze({ role: 'director_story', promptId: 'director/v2_story', module: 'director-agent.mjs', loads: true }),
  Object.freeze({ role: 'director_chaos', promptId: 'director/v2_chaos', module: 'director-agent.mjs', loads: true }),
  Object.freeze({ role: 'action_adjudicator', promptId: 'action_adjudicator/v3', module: 'action-adjudicator.mjs', loads: true }),
  Object.freeze({ role: 'campaign_creator', promptId: 'campaign_creator/v3', module: 'campaign-bootstrap.mjs', loads: true }),
  Object.freeze({ role: 'scene_architect', promptId: 'map_architect/v3', module: 'scene-architect.mjs', loads: true }),
])

/**
 * Что модули **на самом деле** читают: путь вытаскивается из исходника, а не
 * из памяти автора. Так реестр нельзя оставить устаревшим, подняв версию в коде.
 *
 * Значение — список: у Режиссёра промпт выбирается режимом импровизации, и
 * модуль читает с диска оба варианта. Раньше здесь стояла одна строка на модуль,
 * и второй промпт молча затирал первый.
 *
 * @returns {Map<string, string[]>} модуль → все `prompt_id`, которые он читает
 */
export function loadedPromptIds() {
  const serverDir = new URL('./', import.meta.url)
  const found = new Map()
  for (const name of readdirSync(fileURLToPath(serverDir))) {
    if (!name.endsWith('.mjs')) continue
    const source = readFileSync(new URL(name, serverDir), 'utf8')
    for (const match of source.matchAll(/\.\.\/prompts\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+)\.txt/g)) {
      const promptId = `${match[1]}/${match[2]}`
      const ids = found.get(name) ?? []
      if (!ids.includes(promptId)) ids.push(promptId)
      found.set(name, ids)
    }
  }
  return found
}

/**
 * Что лежит в `prompts/`. Старые версии остаются на диске намеренно — они
 * нужны для чтения исторических трасс, — поэтому реестр сверяется с фактом
 * загрузки, а не с наличием файла.
 *
 * @returns {string[]} все `prompt_id` на диске
 */
export function availablePromptIds() {
  const root = fileURLToPath(promptsRoot)
  const ids = []
  for (const family of readdirSync(root)) {
    const familyPath = fileURLToPath(new URL(`${family}/`, promptsRoot))
    if (!statSync(familyPath).isDirectory()) continue
    for (const file of readdirSync(familyPath)) {
      if (!file.endsWith('.txt')) continue
      ids.push(`${family}/${file.slice(0, -4)}`)
    }
  }
  return ids.sort()
}

/**
 * @param {string} promptId
 * @returns {PromptDescriptor | null}
 */
export function descriptorForPromptId(promptId) {
  return PROMPT_DESCRIPTORS.find((descriptor) => descriptor.promptId === String(promptId)) ?? null
}
