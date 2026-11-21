import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FACTORY_DIR = path.join(ROOT, 'adapters')
const USER_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
  'dsh-peripheral-battery',
  'adapters',
)

const errors = []
const ids = new Map()
const rows = []

function fail(origin, file, message) {
  errors.push(`[${origin}] ${file}: ${message}`)
}

function asHexList(value, field) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0 || list.some((item) => item === undefined || item === null || item === '')) {
    throw new Error(`match.${field} 不能为空`)
  }
  for (const item of list) {
    if (!/^[0-9a-f]{1,8}$/i.test(String(item))) throw new Error(`match.${field} 不是十六进制：${item}`)
  }
  return list.map((item) => String(item).toUpperCase())
}

function validate(origin, file, adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('defineAdapter 没有拿到对象')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(adapter.id || ''))) throw new Error('id 非法或缺失')
  if (!String(adapter.name || '').trim()) throw new Error('name 缺失')
  if (!String(adapter.kind || '').trim()) throw new Error('kind 缺失')
  if (!String(adapter.transport || '').trim()) throw new Error('transport 缺失')
  if (adapter.tier !== undefined && !['stable', 'beta'].includes(adapter.tier)) {
    throw new Error('tier 只能是 stable 或 beta')
  }
  if (typeof adapter.read !== 'function') throw new Error('read(io) 不是函数')
  if (!adapter.match || typeof adapter.match !== 'object') throw new Error('match 缺失')
  asHexList(adapter.match.vid, 'vid')
  if (adapter.match.pid !== undefined) asHexList(adapter.match.pid, 'pid')
  if (adapter.match.usagePage !== undefined && !/^[0-9a-f]{1,8}$/i.test(String(adapter.match.usagePage))) {
    throw new Error('match.usagePage 不是十六进制')
  }
  if (adapter.match.usage !== undefined && !/^[0-9a-f]{1,8}$/i.test(String(adapter.match.usage))) {
    throw new Error('match.usage 不是十六进制')
  }
  for (const field of ['inLen', 'outLen', 'featureLen']) {
    if (adapter.match[field] === undefined) continue
    const value = Number(adapter.match[field])
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error(`match.${field} 不是 0–65535 的整数`)
    }
  }
  if (ids.has(adapter.id)) {
    throw new Error(`id ${adapter.id} 与 [${ids.get(adapter.id)}] 重复`)
  }
  ids.set(adapter.id, origin)
  return adapter
}

function load(origin, directory) {
  if (!existsSync(directory)) return
  for (const file of readdirSync(directory).sort()) {
    if (!/\.m?js$/i.test(file)) continue
    let defined = null
    let calls = 0
    const sandbox = {
      defineAdapter: (adapter) => {
        calls += 1
        defined = adapter
      },
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
    }
    try {
      const context = vm.createContext(sandbox, {
        name: `adapter-check:${file}`,
        codeGeneration: { strings: false, wasm: false },
      })
      vm.runInContext(readFileSync(path.join(directory, file), 'utf8'), context, {
        filename: file,
        timeout: 2_000,
      })
      if (calls !== 1) throw new Error(`defineAdapter 调用 ${calls} 次，应恰好 1 次`)
      const adapter = validate(origin, file, defined)
      rows.push(`${origin.padEnd(7)} ${String(adapter.id).padEnd(28)} ${adapter.name}`)
    } catch (error) {
      fail(origin, file, String(error?.message ?? error))
    }
  }
}

load('factory', FACTORY_DIR)
if (process.argv.includes('--user')) load('user', USER_DIR)

for (const row of rows) console.log(`ok   ${row}`)
if (errors.length > 0) {
  console.error('')
  for (const error of errors) console.error(`FAIL ${error}`)
  console.error(`\n${errors.length} 个适配器有问题`)
  process.exit(1)
}
console.log(`\n适配器校验通过：${rows.length} 个`)
