import { FileEventStore } from '../../server/event-store.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
if (process.env.NODE_ENV !== 'test' || dirname(storageDir) !== resolve(tmpdir())
  || !basename(storageDir).startsWith('skazanie-commands-projection-fault-')) {
  throw new Error('Сбой проекции разрешён только в изолированном тестовом хранилище')
}

const original = FileEventStore.prototype.acknowledgeProjection
let failed = false

FileEventStore.prototype.acknowledgeProjection = async function (campaignId, projectedVersion, options) {
  const targetCampaign = String(process.env.DND_PROJECTION_FAULT_CAMPAIGN ?? '')
  const targetVersion = Number(process.env.DND_PROJECTION_FAULT_VERSION ?? '')
  if (!failed
    && process.env.NODE_ENV === 'test'
    && String(campaignId).toUpperCase() === targetCampaign.toUpperCase()
    && Number(projectedVersion) === targetVersion) {
    failed = true
    throw new Error('synthetic projection acknowledgement failure')
  }
  return original.call(this, campaignId, projectedVersion, options)
}
