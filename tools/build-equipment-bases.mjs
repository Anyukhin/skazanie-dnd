#!/usr/bin/env node
// @ts-check
/** Собирает нейтральные human GLB для rig-совместимой экипировки. */
import { parseArgs } from 'node:util'

import { importQuaterniusEquipmentBases } from './import-quaternius-actors.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'base-dir': { type: 'string' },
    'outfit-dir': { type: 'string' },
    'ual-file': { type: 'string' },
    'base-archive': { type: 'string' },
    'outfit-archive': { type: 'string' },
    'animation-archive': { type: 'string' },
  },
  allowPositionals: true,
})

const options = {
  ...(values.out ? { out: values.out } : {}),
  ...(values['base-dir'] ? { baseDir: values['base-dir'] } : {}),
  ...(values['outfit-dir'] ? { outfitDir: values['outfit-dir'] } : {}),
  ...(values['ual-file'] ? { ualFile: values['ual-file'] } : {}),
  ...(values['base-archive'] ? { baseArchive: values['base-archive'] } : {}),
  ...(values['outfit-archive'] ? { outfitArchive: values['outfit-archive'] } : {}),
  ...(values['animation-archive'] ? { animationArchive: values['animation-archive'] } : {}),
}

importQuaterniusEquipmentBases(options)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
