import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EMPTY_STATE = Object.freeze({
  snapshots: {},
  batches: {},
  jobs: {},
  idempotency: {},
  telemetry: [],
  seriesGlossaries: {},
})

export class JsonRepository {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.stateFile = join(dataDir, 'broker-state.json')
    this.assetsDir = join(dataDir, 'assets')
    this.state = structuredClone(EMPTY_STATE)
    this.tail = Promise.resolve()
  }

  async initialize() {
    await mkdir(this.assetsDir, { recursive: true })
    try {
      const loaded = JSON.parse(await readFile(this.stateFile, 'utf8'))
      this.state = { ...structuredClone(EMPTY_STATE), ...loaded }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.#persist()
    }
    return this
  }

  read(work) {
    return work(structuredClone(this.state))
  }

  mutate(work) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state)
      const result = await work(next)
      this.state = next
      await this.#persist()
      return structuredClone(result)
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  assetPath(jobId, kind = 'source') {
    if (!/^[A-Za-z0-9._:-]+$/.test(jobId)) throw new TypeError('Invalid job id')
    if (!['source', 'rendered'].includes(kind)) throw new TypeError('Invalid asset kind')
    return join(this.assetsDir, `${jobId}.${kind}.bin`)
  }

  async writeAsset(jobId, bytes, kind = 'source') {
    const target = this.assetPath(jobId, kind)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, target)
    return target
  }

  readAsset(jobId, kind = 'source') {
    return readFile(this.assetPath(jobId, kind))
  }

  async #persist() {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.stateFile)
  }
}
