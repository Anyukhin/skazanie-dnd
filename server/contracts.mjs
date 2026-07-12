/** Infrastructure contracts used by the domain layer. Concrete adapters may be file based today and SQL/remote later. */
export class LLMClient {
  async complete() { throw new Error('LLMClient.complete не реализован') }
}

export class EmbeddingClient {
  async embed() { throw new Error('EmbeddingClient.embed не реализован') }
}

export class RuleRepository {
  async list() { throw new Error('RuleRepository.list не реализован') }
}

export class CampaignRepository {
  async get() { throw new Error('CampaignRepository.get не реализован') }
  async save() { throw new Error('CampaignRepository.save не реализован') }
}

export class EventRepository {
  async append() { throw new Error('EventRepository.append не реализован') }
  async list() { throw new Error('EventRepository.list не реализован') }
}

export class StateSnapshotRepository {
  async latest() { throw new Error('StateSnapshotRepository.latest не реализован') }
  async save() { throw new Error('StateSnapshotRepository.save не реализован') }
}

