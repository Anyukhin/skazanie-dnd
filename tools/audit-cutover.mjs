import { auditLegacyCutover } from '../server/cutover-audit.mjs'

const strict = process.argv.includes('--strict')
const storageFlag = process.argv.indexOf('--storage')
const storageRoot = storageFlag >= 0 ? process.argv[storageFlag + 1] : undefined

const report = await auditLegacyCutover({ storageRoot })
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (strict && !report.ready) process.exitCode = 2
