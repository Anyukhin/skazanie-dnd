// Хук загрузчика для записи вызовов из тестов JS (`gen-t2.mjs`, часть «тесты»):
// любой импорт `server/party-tactics.mjs` или `server/adjudicator.mjs`, кроме
// импорта самой обёртки (`?orig`), подменяется записывающей обёрткой.
const WRAPPERS = {
  'party-tactics.mjs': new URL('./party-tactics.mjs', import.meta.url).href,
  'adjudicator.mjs': new URL('./adjudicator.mjs', import.meta.url).href,
}

// Пакеты npm (`dotenv` у `server/store.mjs`) в worktree без `node_modules`
// берутся из соседней установки: `SK_NODE_MODULES_FROM` — каталог проекта с
// `node_modules`.
const FALLBACK = process.env.SK_NODE_MODULES_FROM
  ? new URL(`file:///${process.env.SK_NODE_MODULES_FROM.replace(/\\/g, '/').replace(/\/?$/, '/')}package.json`).href
  : null

export async function resolve(specifier, context, nextResolve) {
  let resolved
  try {
    resolved = await nextResolve(specifier, context)
  } catch (error) {
    const bare = !specifier.startsWith('.') && !specifier.includes(':') && !specifier.startsWith('/')
    if (!FALLBACK || !bare || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    resolved = await nextResolve(specifier, { ...context, parentURL: FALLBACK })
  }
  const url = resolved.url
  if (url.includes('?orig')) return resolved
  for (const [file, wrapper] of Object.entries(WRAPPERS)) {
    if (url.endsWith(`/server/${file}`) && context.parentURL !== wrapper) return { ...resolved, url: wrapper, shortCircuit: true }
  }
  return resolved
}
