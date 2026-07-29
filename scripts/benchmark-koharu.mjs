const apiBase = process.env.KOHARU_API_BASE || 'http://127.0.0.1:4000/api/v1'
const pageName = process.env.BONG_BONG_BENCHMARK_PAGE || 'page-0004-bb-5.jpg'
const modelId = process.env.BONG_BONG_BENCHMARK_MODEL || 'gemini-3.1-flash-lite'
const providerId = process.env.BONG_BONG_BENCHMARK_PROVIDER || 'gemini'
const timeoutMs = Number(process.env.BONG_BONG_BENCHMARK_TIMEOUT_MS || 5 * 60 * 1000)

const allVariants = [
  {
    name: 'current',
    steps: [
      'comic-text-bubble-detector',
      'comic-text-detector-seg',
      'speech-bubble-segmentation',
      'paddle-ocr-vl-1.6',
      'llm',
    ],
  },
  {
    name: 'fast-paddle',
    steps: ['comic-text-bubble-detector', 'paddle-ocr-vl-1.6', 'llm'],
  },
  {
    name: 'fast-anime',
    steps: ['anime-text', 'paddle-ocr-vl-1.6', 'llm'],
  },
  {
    name: 'fast-comic-detector',
    steps: ['comic-text-detector', 'paddle-ocr-vl-1.6', 'llm'],
  },
  {
    name: 'fast-manga-ocr',
    steps: ['comic-text-bubble-detector', 'manga-ocr', 'llm'],
  },
  {
    name: 'fast-mit48',
    steps: ['comic-text-bubble-detector', 'mit48px-ocr', 'llm'],
  },
]
const wantedVariant = process.env.BONG_BONG_BENCHMARK_VARIANT || ''
const variants = wantedVariant
  ? allVariants.filter((variant) => variant.name === wantedVariant)
  : allVariants
if (variants.length === 0) {
  throw new Error(`Unknown benchmark variant: ${wantedVariant}`)
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  }
  return body
}

async function selectModel() {
  const target = { kind: 'provider', providerId, modelId }
  await api('/llm/current', {
    method: 'PUT',
    body: JSON.stringify({ target }),
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await api('/llm/current')
    if (state.status === 'ready') return state.target
    if (state.status === 'failed') {
      throw new Error(`Model ${providerId}/${modelId} failed: ${state.error || 'unknown error'}`)
    }
    await wait(250)
  }
  throw new Error(`Model ${providerId}/${modelId} did not become ready`)
}

async function pageSnapshot() {
  const payload = await api('/scene.json')
  const scene = payload.scene || payload
  const entry = Object.values(scene.pages || {}).find((page) => page.name === pageName)
  if (!entry) throw new Error(`Page not found: ${pageName}`)
  const textNodes = Object.values(entry.nodes || {}).filter((node) => node?.kind?.text)
  return {
    pageId: entry.id,
    detected: textNodes.length,
    translated: textNodes.filter((node) =>
      String(node.kind.text.translation || '').trim(),
    ).length,
    samples: textNodes
      .map((node) => ({
        source: String(node.kind.text.text || '').trim(),
        translation: String(node.kind.text.translation || '').trim(),
      }))
      .filter((node) => node.source || node.translation)
      .slice(0, 8),
  }
}

async function runVariant(variant, pageId) {
  const startedAt = performance.now()
  const started = await api('/pipelines', {
    method: 'POST',
    body: JSON.stringify({
      steps: variant.steps,
      pages: [pageId],
      targetLanguage: 'vi-VN',
      systemPrompt:
        'Translate Chinese comic dialogue into concise, natural Vietnamese. Return only translations.',
      readingOrder: 'rtl',
    }),
  })
  const deadline = Date.now() + timeoutMs
  let terminal
  while (Date.now() < deadline) {
    const payload = await api('/operations')
    const operation = (payload.operations || []).find(
      (entry) => entry.id === started.operationId,
    )
    if (
      operation &&
      ['completed', 'completed_with_errors', 'cancelled', 'failed'].includes(operation.status)
    ) {
      terminal = operation
      break
    }
    await wait(250)
  }
  if (!terminal) throw new Error(`${variant.name}: operation timeout`)
  const elapsedMs = Math.round(performance.now() - startedAt)
  const snapshot = await pageSnapshot()
  return {
    variant: variant.name,
    steps: variant.steps,
    status: terminal.status,
    error: terminal.error || null,
    elapsedMs,
    elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    detected: snapshot.detected,
    translated: snapshot.translated,
    samples: snapshot.samples,
  }
}

const selectedTarget = await selectModel()
const initial = await pageSnapshot()
const results = []
for (const variant of variants) {
  try {
    const result = await runVariant(variant, initial.pageId)
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const result = {
      variant: variant.name,
      status: 'benchmark_error',
      error: error instanceof Error ? error.message : String(error),
    }
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
}

process.stdout.write(
  `SUMMARY ${JSON.stringify({
    selectedTarget,
    pageName,
    initial,
    results,
  })}\n`,
)
