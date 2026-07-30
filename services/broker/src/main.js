import { resolve } from 'node:path'

import { ExplicitTestAdapter, KoharuAdapter } from './adapters.js'
import { TranslationBroker } from './broker.js'
import { JsonRepository } from './repository.js'
import { createBrokerServer } from './server.js'
import { SeriesIntelligenceService } from './series-intelligence.js'
import { PublicSeriesResearch } from './series-research.js'

const host = process.env.BROKER_HOST ?? '127.0.0.1'
const port = Number(process.env.BROKER_PORT ?? 4100)
const dataDir = resolve(process.env.BROKER_DATA_DIR ?? '.broker-data')
const explicitTestMode = process.env.BROKER_TEST_MODE === '1'
const adapter = explicitTestMode
  ? new ExplicitTestAdapter()
  : new KoharuAdapter({
      endpoint: process.env.KOHARU_ENDPOINT ?? 'http://127.0.0.1:4000/api/v1',
      authKey: process.env.KOHARU_AUTH_KEY ?? '',
    })
const repository = new JsonRepository(dataDir)
const researchEnabled = process.env.SERIES_RESEARCH_ENABLED !== '0'
const enabledProviders = researchEnabled
  ? (process.env.SERIES_RESEARCH_PROVIDERS ?? 'wikidata,mediawiki,anilist')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  : []
const research = new PublicSeriesResearch({
  timeoutMs: Number(process.env.SERIES_RESEARCH_TIMEOUT_MS ?? 5_000),
  userAgent:
    process.env.SERIES_RESEARCH_USER_AGENT ??
    'ComicSub-SeriesIntelligence/0.1 (local-reader)',
  enabledProviders,
})
const seriesIntelligence = new SeriesIntelligenceService({ repository, research })
const broker = await new TranslationBroker({
  repository,
  adapter,
  seriesIntelligence,
}).initialize()
const server = createBrokerServer(broker)

server.listen(port, host, () => {
  console.log(`Comic translation broker listening on http://${host}:${port} (${adapter.name})`)
})
