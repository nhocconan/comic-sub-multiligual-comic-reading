const PROVIDERS = Object.freeze(['wikidata', 'mediawiki', 'anilist'])
const WIKIDATA_ENDPOINT = 'https://www.wikidata.org/w/api.php'
const ANILIST_ENDPOINT = 'https://graphql.anilist.co'

function normalizedLanguage(value) {
  const primary = String(value).split('-')[0].toLowerCase()
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'en'
}

function cleanText(value, max = 512) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max)
}

function unique(values) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))]
}

function safeSourceUrl(value, allowedOrigins) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !allowedOrigins.includes(url.origin)) return null
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

export class PublicSeriesResearch {
  constructor({
    fetchImplementation = fetch,
    timeoutMs = 5_000,
    userAgent = 'ComicSub-SeriesIntelligence/0.1 (local-reader)',
    enabledProviders = PROVIDERS,
  } = {}) {
    this.fetch = fetchImplementation
    this.timeoutMs = Math.min(30_000, Math.max(500, Number(timeoutMs) || 5_000))
    this.userAgent = String(userAgent).replace(/[\r\n]/g, ' ').slice(0, 256)
    this.enabledProviders = new Set(
      enabledProviders.filter((provider) => PROVIDERS.includes(provider)),
    )
    this.enabled = this.enabledProviders.size > 0
  }

  allowedSourceClasses() {
    return [...this.enabledProviders]
  }

  allowedOriginsFor(targetLanguage) {
    const language = normalizedLanguage(targetLanguage)
    return [
      'https://www.wikidata.org',
      `https://${language}.wikipedia.org`,
      'https://anilist.co',
    ]
  }

  async research({
    normalizedTitle,
    chapterBoundary,
    targetLanguage,
    allowedSourceClasses = PROVIDERS,
  }) {
    // chapterBoundary is accepted so callers have one minimal, auditable
    // outbound context. Current public providers have no matching field, so it
    // is intentionally not serialized into a request.
    void chapterBoundary
    const context = {
      normalizedTitle: cleanText(normalizedTitle),
      targetLanguage: normalizedLanguage(targetLanguage),
    }
    const consented = new Set(allowedSourceClasses)
    const tasks = []
    if (this.enabledProviders.has('wikidata') && consented.has('wikidata')) {
      tasks.push(this.#capture('wikidata', () => this.#wikidata(context)))
    }
    if (this.enabledProviders.has('mediawiki') && consented.has('mediawiki')) {
      tasks.push(this.#capture('mediawiki', () => this.#mediawiki(context)))
    }
    if (this.enabledProviders.has('anilist') && consented.has('anilist')) {
      tasks.push(this.#capture('anilist', () => this.#anilist(context)))
    }
    return Promise.all(tasks)
  }

  async #capture(provider, work) {
    try {
      return { provider, state: 'complete', assertions: await work() }
    } catch (error) {
      return {
        provider,
        state: 'failed',
        assertions: [],
        error: {
          code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
          message: `${provider} research unavailable`,
        },
      }
    }
  }

  async #json(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        'user-agent': this.userAgent,
        ...options.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  async #wikidata({ normalizedTitle, targetLanguage }) {
    const url = new URL(WIKIDATA_ENDPOINT)
    url.search = new URLSearchParams({
      action: 'wbsearchentities',
      search: normalizedTitle,
      language: targetLanguage,
      uselang: targetLanguage,
      type: 'item',
      limit: '5',
      format: 'json',
      origin: '*',
    })
    const body = await this.#json(url)
    const assertions = []
    for (const entry of body?.search ?? []) {
      const sourceUrl = safeSourceUrl(
        entry.concepturi ?? `https://www.wikidata.org/wiki/${entry.id}`,
        ['https://www.wikidata.org'],
      )
      const targetTerm = cleanText(entry.label)
      if (!sourceUrl || !targetTerm) continue
      for (const sourceTerm of unique([
        normalizedTitle,
        entry.match?.text,
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ])) {
        assertions.push({
          sourceTerm,
          targetTerm,
          confidence: entry.match?.type === 'label' ? 0.78 : 0.62,
          sourceClass: 'wikidata',
          sourceUrl,
        })
      }
    }
    return assertions.slice(0, 50)
  }

  async #mediawiki({ normalizedTitle, targetLanguage }) {
    const origin = `https://${targetLanguage}.wikipedia.org`
    const url = new URL('/w/api.php', origin)
    url.search = new URLSearchParams({
      action: 'opensearch',
      search: normalizedTitle,
      namespace: '0',
      limit: '5',
      redirects: 'resolve',
      format: 'json',
      origin: '*',
    })
    const body = await this.#json(url)
    const titles = Array.isArray(body?.[1]) ? body[1] : []
    const urls = Array.isArray(body?.[3]) ? body[3] : []
    return titles.flatMap((title, index) => {
      const sourceUrl = safeSourceUrl(urls[index], [origin])
      const targetTerm = cleanText(title)
      if (!sourceUrl || !targetTerm) return []
      return [{
        sourceTerm: normalizedTitle,
        targetTerm,
        confidence: index === 0 ? 0.7 : 0.55,
        sourceClass: 'mediawiki',
        sourceUrl,
      }]
    })
  }

  async #anilist({ normalizedTitle }) {
    const query = `
      query SeriesResearch($search: String!) {
        Media(search: $search, type: MANGA) {
          id
          siteUrl
          title { native romaji english userPreferred }
          synonyms
          characters(page: 1, perPage: 10) {
            nodes { name { native full alternative } }
          }
        }
      }`
    const body = await this.#json(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { search: normalizedTitle } }),
    })
    const media = body?.data?.Media
    const sourceUrl = safeSourceUrl(media?.siteUrl, ['https://anilist.co'])
    if (!media || !sourceUrl) return []
    const targetTitle = cleanText(
      media.title?.userPreferred ?? media.title?.english ?? media.title?.romaji,
    )
    const assertions = []
    for (const sourceTerm of unique([
      normalizedTitle,
      media.title?.native,
      media.title?.romaji,
      ...(media.synonyms ?? []),
    ])) {
      if (targetTitle) {
        assertions.push({
          sourceTerm,
          targetTerm: targetTitle,
          confidence: sourceTerm === normalizedTitle ? 0.74 : 0.66,
          sourceClass: 'anilist',
          sourceUrl,
        })
      }
    }
    for (const character of media.characters?.nodes ?? []) {
      const sourceTerm = cleanText(character?.name?.native)
      const targetTerm = cleanText(character?.name?.full)
      if (!sourceTerm || !targetTerm || sourceTerm === targetTerm) continue
      assertions.push({
        sourceTerm,
        targetTerm,
        confidence: 0.68,
        sourceClass: 'anilist',
        sourceUrl,
      })
    }
    return assertions.slice(0, 100)
  }
}
