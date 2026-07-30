import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ExplicitTestAdapter } from '../src/adapters.js'
import { TranslationBroker } from '../src/broker.js'
import { JsonRepository } from '../src/repository.js'
import { createBrokerServer } from '../src/server.js'
import { SeriesIntelligenceService } from '../src/series-intelligence.js'
import { PublicSeriesResearch } from '../src/series-research.js'

function consent() {
  return {
    seriesId: 'series-123',
    policyVersion: 'series-research-v1',
    state: 'granted',
    allowedSourceClasses: ['wikidata', 'mediawiki', 'anilist'],
    grantedAt: new Date().toISOString(),
  }
}

function bootstrap(overrides = {}) {
  return {
    seriesId: 'series-123',
    title: '魔尊',
    seriesStatus: 'confirmed',
    chapterBoundary: 'chapter-12',
    targetLanguage: 'vi',
    localContinuity: [{
      sourceTerm: '师父',
      targetTerm: 'Sư phụ',
      confidence: 0.9,
      reference: 'chapter-11',
    }],
    locallyObservedAliases: ['魔尊'],
    researchConsent: consent(),
    ...overrides,
  }
}

async function fixture(fetchImplementation, enabledProviders = ['wikidata', 'mediawiki', 'anilist']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'comic-series-'))
  const repository = new JsonRepository(dataDir)
  const research = new PublicSeriesResearch({
    fetchImplementation,
    timeoutMs: 500,
    userAgent: 'ComicSub-Test/1.0',
    enabledProviders,
  })
  const seriesIntelligence = new SeriesIntelligenceService({ repository, research })
  const broker = await new TranslationBroker({
    repository,
    adapter: new ExplicitTestAdapter(),
    seriesIntelligence,
  }).initialize()
  const server = createBrokerServer(broker)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    broker,
    repository,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  }
}

async function waitForResearch(base, expectedStates = ['complete', 'complete-with-errors', 'unavailable']) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/v1/series/series-123/glossary`)
    const body = await response.json()
    if (expectedStates.includes(body.research?.state)) return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for series research')
}

test('series bootstrap persists local continuity first, researches fixed providers, and quarantines unobserved aliases', async () => {
  const calls = []
  const fakeFetch = async (input, options = {}) => {
    const url = new URL(String(input))
    calls.push({ url: url.href, body: options.body ?? null, headers: options.headers })
    if (url.hostname === 'www.wikidata.org') {
      return Response.json({
        search: [{
          id: 'Q123',
          label: 'Ma Tôn',
          concepturi: 'https://www.wikidata.org/wiki/Q123',
          match: { type: 'label', text: '魔尊' },
        }],
      })
    }
    if (url.hostname === 'vi.wikipedia.org') {
      return Response.json([
        '魔尊',
        ['Ma Tôn'],
        [''],
        ['https://vi.wikipedia.org/wiki/Ma_T%C3%B4n'],
      ])
    }
    if (url.hostname === 'graphql.anilist.co') {
      return Response.json({
        data: {
          Media: {
            id: 7,
            siteUrl: 'https://anilist.co/manga/7',
            title: {
              native: '魔尊',
              romaji: 'Mao Zun',
              english: 'Demon Venerable',
              userPreferred: 'Demon Venerable',
            },
            synonyms: [],
            characters: {
              nodes: [{ name: { native: '师父', full: 'Master', alternative: [] } }],
            },
          },
        },
      })
    }
    throw new Error(`Unexpected host ${url.hostname}`)
  }
  const app = await fixture(fakeFetch)
  try {
    const response = await fetch(`${app.base}/v1/series/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bootstrap()),
    })
    assert.equal(response.status, 202)
    const immediate = await response.json()
    assert.equal(immediate.research.state, 'queued')
    assert.equal(
      immediate.glossarySnapshot.entries.find((entry) => entry.sourceTerm === '师父').status,
      'active',
    )

    const completed = await waitForResearch(app.base)
    assert.equal(completed.research.state, 'complete')
    assert.equal(completed.glossarySnapshot.version, 2)
    assert.equal(completed.glossarySnapshot.hash.length, 64)
    assert.ok(completed.citations.length >= 3)
    const titleTerms = completed.glossarySnapshot.entries.filter(
      (entry) => entry.origin === 'external-research' && entry.sourceTerm === '魔尊',
    )
    assert.ok(titleTerms.length > 0)
    assert.ok(titleTerms.every((entry) => entry.status === 'active'))
    const character = completed.glossarySnapshot.entries.find(
      (entry) => entry.origin === 'external-research' && entry.sourceTerm === '师父',
    )
    assert.equal(character.status, 'quarantined')
    assert.ok(completed.quarantinedTerms.some((entry) => entry.assertionId === character.assertionId))
    assert.ok(
      completed.glossarySnapshot.entries.every((entry) => Number.isFinite(entry.confidence)),
    )

    const serializedCalls = JSON.stringify(calls)
    assert.equal(serializedCalls.includes('chapter-11'), false)
    assert.equal(serializedCalls.includes('Sư phụ'), false)
    assert.equal(serializedCalls.includes('locallyObservedAliases'), false)
    assert.ok(calls.every((call) =>
      ['www.wikidata.org', 'vi.wikipedia.org', 'graphql.anilist.co']
        .includes(new URL(call.url).hostname)))

    const deleted = await fetch(`${app.base}/v1/series/series-123/glossary`, {
      method: 'DELETE',
    })
    assert.equal(deleted.status, 200)
    assert.equal((await deleted.json()).deleted, true)
    assert.equal((await fetch(`${app.base}/v1/series/series-123/glossary`)).status, 404)
  } finally {
    await app.close()
  }
})

test('job resolves the exact active glossary snapshot and rejects stale references', async () => {
  const app = await fixture(async () => {
    throw new Error('research should not run')
  }, [])
  const principal = { tenantId: 'local', deviceId: 'local-device' }
  try {
    const series = await app.broker.bootstrapSeries(principal, bootstrap({
      researchConsent: null,
      locallyObservedAliases: [],
    }))
    await app.broker.registerSnapshot(principal, {
      snapshotId: 'snapshot-glossary',
      navigationId: 'navigation-glossary',
      topFrameOrigin: 'https://reader.example/',
      createdAt: new Date().toISOString(),
      candidates: [{
        candidateId: 'candidate-glossary',
        frameId: 'top',
        domOrdinal: 0,
        sourceUrl: 'https://cdn.example/page.png',
        sourceOrigin: 'https://cdn.example/',
        renderedRect: { x: 0, y: 0, width: 800, height: 1200 },
        intrinsicWidth: 800,
        intrinsicHeight: 1200,
        acquisitionCapabilities: ['source-blob'],
      }],
    })
    const batch = await app.broker.createBatch(principal, {
      snapshotId: 'snapshot-glossary',
      candidateIds: ['candidate-glossary'],
      glossarySnapshot: {
        id: series.glossarySnapshot.id,
        version: series.glossarySnapshot.version,
        hash: series.glossarySnapshot.hash,
      },
    }, 'glossary-exact')
    const stored = app.repository.read((state) => state.jobs[batch.jobIds[0]])
    assert.deepEqual(stored.glossaryEntries, [{
      sourceTerm: '师父',
      targetTerm: 'Sư phụ',
      confidence: 0.9,
    }])

    await assert.rejects(
      app.broker.createBatch(principal, {
        snapshotId: 'snapshot-glossary',
        candidateIds: ['candidate-glossary'],
        glossarySnapshot: {
          id: series.glossarySnapshot.id,
          version: series.glossarySnapshot.version,
          hash: 'f'.repeat(64),
        },
      }, 'glossary-stale'),
      (error) => error.code === 'GLOSSARY_SNAPSHOT_STALE',
    )
  } finally {
    await app.close()
  }
})

test('private mode never calls research providers even with consent', async () => {
  let calls = 0
  const app = await fixture(async () => {
    calls += 1
    throw new Error('must not be called')
  })
  try {
    const response = await fetch(`${app.base}/v1/series/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bootstrap({ privateMode: true })),
    })
    const body = await response.json()
    assert.equal(body.research.state, 'disabled-private')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(calls, 0)
  } finally {
    await app.close()
  }
})

test('provider outage does not block local bootstrap or erase continuity', async () => {
  const app = await fixture(async () => {
    throw new Error('offline')
  })
  try {
    const response = await fetch(`${app.base}/v1/series/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bootstrap()),
    })
    assert.equal(response.status, 202)
    const immediate = await response.json()
    assert.equal(immediate.research.state, 'queued')
    assert.ok(immediate.glossarySnapshot.entries.some((entry) => entry.sourceTerm === '师父'))
    const completed = await waitForResearch(app.base, ['unavailable'])
    assert.equal(completed.research.state, 'unavailable')
    assert.ok(completed.glossarySnapshot.entries.some((entry) => entry.sourceTerm === '师父'))
  } finally {
    await app.close()
  }
})
