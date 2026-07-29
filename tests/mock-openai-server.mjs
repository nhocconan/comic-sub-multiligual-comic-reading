import { createServer } from 'node:http'

const port = Number(process.env.BONG_BONG_MOCK_LLM_PORT || 4020)

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`)
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [{ id: 'bong-bong-deterministic', object: 'model' }],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(request)
    const source = body.messages?.at(-1)?.content || ''
    const tags = [...source.matchAll(/^\[(\d+)\]/gm)].map((match) => match[1])
    const content = tags
      .map((tag, index) => `[${tag}]Bản dịch kiểm thử ${index + 1}`)
      .join('\n')
    sendJson(response, 200, {
      id: 'bong-bong-deterministic',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content } }],
    })
    return
  }
  sendJson(response, 404, { error: { message: 'Not found' } })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock OpenAI-compatible server listening on ${port}\n`)
})
