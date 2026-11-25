/**
 * Host 半：轮询侧车、缓存快照、检测低电量、暴露 tools 与 HTTP 路由。
 *
 * 不 import 任何 `@deepseek-ai/*` 包：第三方插件按 profile 作用域解析裸模块，
 * 这些包不在 profile 的 node_modules 里。tool 定义直接写成 registry 接受的
 * 原始 JSON Schema 形状。
 */

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { DaemonClient } from './daemon-client.js'
import { matchEntries, searchEntries } from './adapter-catalog.js'
import { buildDeviceView, listDeviceRegistry, normalizeDeviceName } from './device-view.js'
import { createSourceLedger, sourceSummaryLines } from './source-ledger.js'
import { PROTOCOLS, protocolsForDevice } from './protocols/catalog.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'bin', 'peripheral-battery-cli.exe')
const DAEMON_EXE = path.join(HERE, 'bin', 'peripheral-battery-daemon.exe')
const TOAST_SCRIPT = path.join(HERE, 'scripts', 'toast.ps1')
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** Windows 已知电量变化慢；Rust 侧 BLE 扫描约 1–3 秒，缓存 10 分钟。 */
const BLE_TTL_MS = 10 * 60 * 1000
/** DSH 桌面安装器已在开始菜单注册的 AUMID；借用它发 toast 无需自注册。 */
const DSH_APP_ID = 'com.deepseek.dsh'

const SETTINGS_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
  'dsh-peripheral-battery',
)
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')
const DEVICES_FILE = path.join(SETTINGS_DIR, 'devices.json')
const ADAPTER_DIR = path.join(SETTINGS_DIR, 'adapters')
const FACTORY_ADAPTER_DIR = path.join(HERE, 'adapters')

const DEFAULTS = {
  intervalMinutes: 30,
  thresholdPercent: 20,
  notify: true,
  scheduled: false,
  betaEnabled: true,
  onboardingDone: false,
  marketUrl: 'https://wbx1217.github.io/dsh-peripheral-battery-adapters/index.json',
}

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 常驻 daemon 的单例；第一次适配器 I/O 时按需拉起，插件卸载时释放。 */
let daemonClient = null
function getDaemon() {
  if (!daemonClient) daemonClient = new DaemonClient({ exePath: DAEMON_EXE })
  return daemonClient
}

/** Cordis 注入声明：缺任一服务时插件保持不激活，而不是抛错。 */
export const inject = ['tools', 'timer', 'webServer']

function clamp(value, low, high, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, Math.round(number)))
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && raw[key] !== null) merged[key] = raw[key]
    }
  }
  return {
    intervalMinutes: clamp(merged.intervalMinutes, 1, 1440, DEFAULTS.intervalMinutes),
    thresholdPercent: clamp(merged.thresholdPercent, 1, 99, DEFAULTS.thresholdPercent),
    notify: Boolean(merged.notify),
    scheduled: merged.scheduled === true,
    betaEnabled: merged.betaEnabled !== false,
    onboardingDone: merged.onboardingDone === true,
    marketUrl:
      typeof merged.marketUrl === 'string'
        ? merged.marketUrl.trim().slice(0, 500)
        : '',
  }
}

function loadSettings(rowConfig) {
  const fromRow = {}
  if (rowConfig && typeof rowConfig === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (rowConfig[key] !== undefined) fromRow[key] = rowConfig[key]
    }
  }
  let stored = {}
  let hasStored = false
  try {
    stored = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    hasStored = true
  } catch {
    // 没有设置文件或内容损坏：用行配置 + 默认值。
  }
  const settings = normalizeSettings({ ...fromRow, ...stored })
  // 升级迁移：老用户已经有设置文件但没有 onboardingDone，不重新弹首次引导。
  if (hasStored && stored.onboardingDone === undefined && fromRow.onboardingDone === undefined) {
    settings.onboardingDone = true
  }
  return settings
}

function saveSettings(next) {
  const normalized = normalizeSettings(next)
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

// ---- 设备注册表 ----------------------------------------------------------
// 持久化元数据（名称/可见性/顺序/自定义名），不持久化读数；「已拔出」的
// 占位行靠这里的记录 + 内存里的最后一次读数。

const deviceRegistry = new Map()
let deviceOrderSeq = 0
const lastReadings = new Map()

function loadDeviceRegistry() {
  try {
    const data = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'))
    for (const item of data.devices || []) {
      if (!item || typeof item.key !== 'string' || !item.key) continue
      const order = Number(item.order)
      deviceRegistry.set(item.key, {
        key: item.key,
        name: typeof item.name === 'string' ? item.name : item.key,
        kind: typeof item.kind === 'string' ? item.kind : 'keyboard',
        transport: typeof item.transport === 'string' ? item.transport : '',
        visible: item.visible !== false,
        order: Number.isFinite(order) ? order : 0,
        customName:
          typeof item.customName === 'string' && item.customName.trim() ? item.customName.trim() : null,
      })
      deviceOrderSeq = Math.max(deviceOrderSeq, Number.isFinite(order) ? order : 0)
    }
  } catch {
    // 首次运行或文件损坏：从空注册表开始。
  }
}

function saveDeviceRegistry() {
  const devices = [...deviceRegistry.values()].sort((left, right) => left.order - right.order)
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(DEVICES_FILE, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, 'utf8')
}

function displayNameOf(entry, device) {
  if (entry && entry.customName) return entry.customName
  return (device && device.name) || (entry && entry.name) || (entry && entry.key) || '未知设备'
}

function upsertDevice(device) {
  let entry = deviceRegistry.get(device.key)
  let changed = false
  if (!entry) {
    entry = {
      key: device.key,
      name: device.name || device.key,
      kind: device.kind || 'keyboard',
      transport: device.transport || '',
      visible: true,
      order: ++deviceOrderSeq,
      customName: null,
    }
    deviceRegistry.set(device.key, entry)
    changed = true
  } else {
    if (device.name && device.name !== entry.name) {
      entry.name = device.name
      changed = true
    }
    if (device.kind && device.kind !== entry.kind) {
      entry.kind = device.kind
      changed = true
    }
    if (device.transport && device.transport !== entry.transport) {
      entry.transport = device.transport
      changed = true
    }
  }

  if (device.status === 'online' && Number.isFinite(Number(device.percent))) {
    lastReadings.set(device.key, {
      percent: Number(device.percent),
      charging: device.charging ?? null,
      at: Date.now(),
    })
  }
  if (changed) saveDeviceRegistry()
  return entry
}

function buildSnapshot(rawDevices, base = {}) {
  for (const device of rawDevices) upsertDevice(device)
  return buildDeviceView(rawDevices, {
    registry: deviceRegistry,
    lastReadings,
    displayNameOf,
    base,
  })
}

function registryList(currentDevices) {
  return listDeviceRegistry(currentDevices, {
    registry: deviceRegistry,
    lastReadings,
    displayNameOf,
  })
}

function normalizeCustomName(value) {
  return normalizeDeviceName(value)
}

/**
 * 用户适配器：目录里的每个 `.js` / `.mjs` 都是一个脚本，运行在 `node:vm`
 * 的独立上下文里，只能调用 `defineAdapter(...)` 和 `console`。
 *
 * vm 隔离的是全局对象，**不是安全边界**：适配器本质上仍是用户自己安装的
 * 代码，和安装插件同级。这里做的是防止误用（没有 require/fs/net/process），
 * 不是防恶意代码。
 */
const adapterState = {
  adapters: [],
  errors: [],
  loadedAt: 0,
  includeBeta: true,
  factoryIds: new Set(),
}

function extractAdapterId(source) {
  const match = /\bid\s*:\s*['"]([^'"]+)['"]/.exec(source)
  return match ? match[1] : null
}

/**
 * 旧版本会把出厂适配器复制到用户目录（只补缺失，插件更新不会覆盖旧副本）。
 * 现在出厂适配器直接从插件包内加载；这里把旧副本移到备份目录，避免重复加载。
 * 只处理「文件名与 id 都与出厂一致」的文件；用户自己改过 id 的文件保持不动。
 */
function migrateLegacySeededAdapters() {
  const marker = path.join(SETTINGS_DIR, 'adapters-migrated-v2')
  if (existsSync(marker)) return
  let names = []
  try {
    names = readdirSync(FACTORY_ADAPTER_DIR).filter(
      (name) => name.endsWith('.js') || name.endsWith('.mjs'),
    )
  } catch {
    return
  }
  const backupDir = path.join(SETTINGS_DIR, 'adapters-legacy-backup')
  for (const name of names) {
    const userPath = path.join(ADAPTER_DIR, name)
    if (!existsSync(userPath)) continue
    try {
      const factoryId = extractAdapterId(readFileSync(path.join(FACTORY_ADAPTER_DIR, name), 'utf8'))
      const userId = extractAdapterId(readFileSync(userPath, 'utf8'))
      if (!factoryId || !userId || factoryId !== userId) continue
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(userPath, path.join(backupDir, name))
      unlinkSync(userPath)
    } catch {
      // 迁移失败不阻塞：加载器会按 id 去重并给出错误。
    }
  }
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8')
}

function hexId(value, label = 'hex') {
  const text = (typeof value === 'number' ? value.toString(16) : String(value ?? ''))
    .trim()
    .replace(/^0x/i, '')
    .replace(/\s+/g, '')
  if (!/^[0-9A-Fa-f]{1,4}$/.test(text)) {
    throw new Error(`${label} 必须是 1–4 位十六进制`)
  }
  return text.toUpperCase().padStart(4, '0')
}

/** match 允许单值或数组：一个协议族常常横跨多个 VID/PID。 */
function hexList(value, label) {
  const list = (Array.isArray(value) ? value : [value])
    .filter((item) => item !== undefined && item !== null && item !== '')
    .map((item) => hexId(item, label))
  if (list.length === 0) throw new Error(`match.${label} 不能为空`)
  return list
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('适配器缺少 match: { vid, pid }')
  const match = {
    vids: hexList(raw.vid, 'vid'),
    pids: raw.pid === undefined || raw.pid === null ? [] : hexList(raw.pid, 'pid'),
  }
  if (raw.usagePage) match.usagePage = hexId(raw.usagePage, 'usagePage')
  if (raw.usage) match.usage = hexId(raw.usage, 'usage')
  for (const key of ['inLen', 'outLen', 'featureLen']) {
    if (raw[key] !== undefined) match[key] = Number(raw[key])
  }
  return match
}

function adapterMatches(adapter, device) {
  const match = adapter.match
  return (
    match.vids.includes(device.vid) &&
    (match.pids.length === 0 || match.pids.includes(device.pid)) &&
    (!match.usagePage || match.usagePage === device.usagePage) &&
    (!match.usage || match.usage === device.usage) &&
    (match.inLen === undefined || match.inLen === device.inputLen) &&
    (match.outLen === undefined || match.outLen === device.outputLen) &&
    (match.featureLen === undefined || match.featureLen === device.featureLen)
  )
}

const ADAPTER_IO_FACTORY_SOURCE = `
  globalThis.__makeIo = function (host) {
    const call = async (method, args) => {
      try {
        const text = await host.call(method, args || []);
        return text == null ? null : JSON.parse(text);
      } catch (error) {
        throw new Error(String(error && error.message ? error.message : error));
      }
    };
    const makeSession = (info) => {
      if (!info || info.id === undefined || info.id === null) {
        throw new Error('io session 初始化失败：' + JSON.stringify(info));
      }
      return Object.freeze({
        id: info.id,
        read: (opts = {}) => call('read', [info.id, opts]),
        write: (hex, opts = {}) => call('write', [info.id, hex, opts]),
        setFeature: (hex) => call('setFeature', [info.id, hex]),
        getFeature: (hex) => call('getFeature', [info.id, hex]),
        flush: (idleMs) => call('flush', [info.id, idleMs]),
        close: () => call('close', [info.id]),
      });
    };
    const device = JSON.parse(host.deviceJson || '{}');
    const open = async (options = {}) => makeSession(await call('open', [options]));
    return Object.freeze({
      device,
      open,
      withSession: async (options, fn) => {
        const session = await open(options);
        try {
          return await fn(session);
        } finally {
          await session.close();
        }
      },
      listDevices: () => call('listDevices', []),
      sleep: (ms) => call('sleep', [ms]),
      listen: (options = {}) => call('listen', [options]),
      exchange: (options = {}) => call('exchange', [options]),
    });
  };
`

function loadAdapters() {
  adapterState.adapters = []
  adapterState.errors = []
  adapterState.factoryIds = new Set()
  const usedIds = new Map()

  const loadDirectory = (directory, origin) => {
    let entries = []
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = entry.name
      if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue
      try {
        const source = readFileSync(path.join(directory, file), 'utf8')
        const context = vm.createContext(Object.create(null), {
          name: `peripheral-battery-adapter:${file}`,
          codeGeneration: { strings: false, wasm: false },
        })
        // 只在沙箱内部创建 defineAdapter/console，避免把宿主函数交给适配器。
        vm.runInContext(
          `
            globalThis.__adapter = null;
            globalThis.console = Object.freeze({
              log() {},
              warn() {},
              error() {},
            });
            globalThis.defineAdapter = function (adapter) {
              globalThis.__adapter = adapter;
            };
          `,
          context,
          { filename: 'adapter-bootstrap.js', timeout: 1_000 },
        )
        vm.runInContext(ADAPTER_IO_FACTORY_SOURCE, context, {
          filename: 'adapter-io-factory.js',
          timeout: 1_000,
        })
        const ioFactory = context.__makeIo
        vm.runInContext(source, context, { filename: file, timeout: 2_000 })
        const defined = context.__adapter
        if (!defined || typeof defined !== 'object') {
          throw new Error('脚本没有调用 defineAdapter({...})')
        }
        if (!defined.read || typeof defined.read !== 'function') throw new Error('适配器缺少 read(io) 函数')
        const tier =
          origin === 'factory' ? (defined.tier === 'stable' ? 'stable' : 'beta') : 'user'
        const adapterId = String(defined.id || file.replace(/\.m?js$/i, ''))
        // factory 全量 id 不随 beta 开关变化，供市场 builtIn/安装前置判断。
        if (origin === 'factory') adapterState.factoryIds.add(adapterId)
        if (origin === 'factory' && tier === 'beta' && adapterState.includeBeta === false) {
          continue
        }
        const adapter = {
          file,
          origin,
          tier,
          id: adapterId,
          name: String(defined.name || defined.id || file),
          kind: String(defined.kind || 'keyboard'),
          transport: String(defined.transport || '2.4G · adapter'),
          match: normalizeMatch(defined.match),
          showWhenMissing: Boolean(defined.showWhenMissing),
          read: defined.read,
          ioFactory,
        }
        if (usedIds.has(adapter.id)) {
          const existing = usedIds.get(adapter.id)
          adapterState.errors.push({
            file,
            origin,
            message: `适配器 id ${adapter.id} 与${existing === 'factory' ? '出厂' : '用户'}适配器重复，已跳过`,
          })
          continue
        }
        usedIds.set(adapter.id, origin)
        adapterState.adapters.push(adapter)
      } catch (error) {
        adapterState.errors.push({ file, origin, message: String(error?.message ?? error) })
      }
    }
  }

  loadDirectory(FACTORY_ADAPTER_DIR, 'factory')
  loadDirectory(ADAPTER_DIR, 'user')
  adapterState.loadedAt = Date.now()
}

function adapterPublicList() {
  return adapterState.adapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    kind: adapter.kind,
    tier: adapter.tier,
    match: adapter.match,
    file: adapter.file,
    origin: adapter.origin,
  }))
}

// ---- 适配器市场（策展索引） -----------------------------------------------
// 索引是一个静态 JSON；插件按设备搜索、预览源码、校验 SHA-256 后写入用户
// 适配器目录。出厂适配器永远不会被覆盖。

const MARKET_INSTALLED_FILE = path.join(SETTINGS_DIR, 'market-installed.json')
const MARKET_CACHE_MS = 5 * 60 * 1000
const MARKET_FALLBACKS = [
  'https://gitee.com/yfrm/dsh-peripheral-battery-adapters/raw/main/index.json',
  'https://cdn.jsdelivr.net/gh/wbx1217/dsh-peripheral-battery-adapters@main/index.json',
  'https://fastly.jsdelivr.net/gh/wbx1217/dsh-peripheral-battery-adapters@main/index.json',
  'https://raw.githubusercontent.com/wbx1217/dsh-peripheral-battery-adapters/main/index.json',
]
const MARKET_INDEX_LIMIT = 512 * 1024
const MARKET_CODE_LIMIT = 64 * 1024
const marketState = { url: '', index: null, fetchedAt: 0 }

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readMarketInstalled() {
  try {
    const data = JSON.parse(readFileSync(MARKET_INSTALLED_FILE, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeMarketInstalled(map) {
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(MARKET_INSTALLED_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}

async function fetchTextLimited(url, maxBytes, timeoutMs = 8_000) {
  if (url.startsWith('file:')) {
    const buffer = readFileSync(fileURLToPath(url))
    if (buffer.length > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024)} KiB`)
    return buffer.toString('utf8')
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('适配器源只支持 http(s) 或 file: 地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain, */*' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) return response.text()
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        controller.abort()
        throw new Error(`响应超过 ${Math.round(maxBytes / 1024)} KiB`)
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

function normalizeMarketEntry(raw, indexUrl) {
  if (!raw || typeof raw !== 'object') throw new Error('条目不是对象')
  const id = String(raw.id || '').trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`id 非法：${id}`)
  const file = String(raw.file || '').trim()
  if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(file) || file.split('/').includes('..')) {
    throw new Error(`file 非法：${file}`)
  }
  const sha256Value = String(raw.sha256 || '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256Value)) throw new Error('sha256 必须是 64 位十六进制')
  const match = normalizeMatch(raw.match)
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 80),
    model: String(raw.model || '').trim().slice(0, 80),
    connection: Array.isArray(raw.connection)
      ? raw.connection
          .map((value) => String(value).trim())
          .filter(Boolean)
          .slice(0, 4)
      : [],
    kind: String(raw.kind || 'mouse').slice(0, 32),
    transport: String(raw.transport || '2.4G · adapter').slice(0, 64),
    match,
    file,
    targetFile: `${id}.js`,
    sha256: sha256Value,
    author: String(raw.author || '').slice(0, 80),
    status: String(raw.status || 'community').slice(0, 32),
    notes: String(raw.notes || '').slice(0, 300),
    minPlugin: String(raw.minPlugin || '').slice(0, 32),
    url: new URL(file, indexUrl).toString(),
  }
}

async function loadMarketIndex(url, force = false) {
  if (!url) throw new Error('未配置适配器源，请先在设置页填写索引 URL')
  if (
    !force &&
    marketState.url === url &&
    marketState.index &&
    Date.now() - marketState.fetchedAt < MARKET_CACHE_MS
  ) {
    return marketState.index
  }
  const candidates = [url]
  if (url === DEFAULTS.marketUrl) candidates.push(...MARKET_FALLBACKS)

  let lastError = null
  for (const candidate of candidates) {
    try {
      const text = await fetchTextLimited(candidate, MARKET_INDEX_LIMIT, 4_000)
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('索引不是合法 JSON')
      }
      if (!data || !Array.isArray(data.adapters)) throw new Error('索引缺少 adapters 数组')
      const entries = []
      const warnings = []
      const seen = new Set()
      for (const [index, raw] of data.adapters.entries()) {
        try {
          const entry = normalizeMarketEntry(raw, candidate)
          if (seen.has(entry.id)) {
            warnings.push(`#${index} id 重复：${entry.id}`)
            continue
          }
          seen.add(entry.id)
          entries.push(entry)
        } catch (error) {
          warnings.push(`#${index} 无效：${String(error?.message ?? error)}`)
        }
      }
      marketState.url = url
      marketState.index = {
        entries,
        warnings,
        sourceUrl: candidate,
        fetchedAt: Date.now(),
      }
      marketState.fetchedAt = Date.now()
      return marketState.index
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('适配器索引加载失败')
}

function validateMarketSource(source, entry) {
  let defined = null
  const sandbox = {
    defineAdapter: (adapter) => {
      defined = adapter
    },
    console: { log() {}, warn() {}, error() {} },
  }
  const context = vm.createContext(sandbox, {
    name: `market-adapter:${entry.id}`,
    codeGeneration: { strings: false, wasm: false },
  })
  vm.runInContext(source, context, { filename: entry.file, timeout: 2_000 })
  if (!defined || typeof defined !== 'object') throw new Error('源码没有调用 defineAdapter(...)')
  if (!defined.read || typeof defined.read !== 'function') throw new Error('源码缺少 read(io)')
  if (String(defined.id) !== entry.id) throw new Error('源码 id 与索引不一致')
  const match = normalizeMatch(defined.match)
  if (JSON.stringify(match) !== JSON.stringify(entry.match)) {
    throw new Error('源码 match 与索引不一致')
  }
}

async function loadMarketSource(entry, url) {
  const candidates = [entry.url]
  if (url === DEFAULTS.marketUrl) {
    for (const base of [DEFAULTS.marketUrl, ...MARKET_FALLBACKS]) {
      try {
        const candidate = new URL(entry.file, base).toString()
        if (!candidates.includes(candidate)) candidates.push(candidate)
      } catch {
        // 忽略非法 base，继续尝试其他镜像。
      }
    }
  }

  let lastError = null
  for (const candidate of candidates) {
    try {
      const source = await fetchTextLimited(candidate, MARKET_CODE_LIMIT)
      const hash = sha256(source)
      if (hash !== entry.sha256) throw new Error('源码哈希与索引不一致，已拒绝')
      validateMarketSource(source, entry)
      return { source, hash, fileUrl: candidate }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('适配器源码下载失败')
}

function versionAtLeast(actual, required) {
  const parse = (value) =>
    String(value || '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(actual)
  const right = parse(required)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0
    const b = right[index] || 0
    if (a !== b) return a > b
  }
  return true
}

async function marketPreview(id, url) {
  const index = await loadMarketIndex(url)
  const entry = index.entries.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`索引里没有 ${id}`)
  if (entry.minPlugin && !versionAtLeast(PLUGIN_VERSION, entry.minPlugin)) {
    throw new Error(`该适配器需要插件 ${entry.minPlugin}+，当前 ${PLUGIN_VERSION}`)
  }
  const resolved = await loadMarketSource(entry, url)
  return { entry, source: resolved.source, hash: resolved.hash, fileUrl: resolved.fileUrl }
}

async function marketInstall(id, url, { confirm = false, overwrite = false } = {}) {
  const preview = await marketPreview(id, url)
  if (!confirm) return { requiresConfirmation: true, ...preview }

  const entry = preview.entry
  if (
    adapterState.factoryIds.has(entry.id)
  ) {
    throw new Error('该设备已内置，无需安装')
  }
  const targetFile = entry.targetFile
  if (existsSync(path.join(FACTORY_ADAPTER_DIR, targetFile))) {
    throw new Error(`${targetFile} 与出厂适配器同名`)
  }
  const target = path.join(ADAPTER_DIR, targetFile)
  const installed = readMarketInstalled()
  const previous = installed[entry.id]
  const targetExists = existsSync(target)
  if (targetExists && !overwrite && previous?.file !== targetFile) {
    throw new Error(`${targetFile} 已存在；覆盖请传 overwrite: true`)
  }

  mkdirSync(ADAPTER_DIR, { recursive: true })
  writeFileSync(target, preview.source, 'utf8')
  if (previous?.file && previous.file !== targetFile) {
    try {
      const oldTarget = path.join(ADAPTER_DIR, previous.file)
      if (existsSync(oldTarget)) unlinkSync(oldTarget)
    } catch {
      // 旧文件删除失败不影响新版本。
    }
  }
  installed[entry.id] = {
    file: targetFile,
    sha256: preview.hash,
    name: entry.name,
    status: entry.status,
    source: url,
    installedAt: Date.now(),
  }
  writeMarketInstalled(installed)
  loadAdapters()
  return { installed: installed[entry.id], adapters: adapterPublicList() }
}

function marketRemove(id) {
  const installed = readMarketInstalled()
  const record = installed[id]
  if (!record) throw new Error(`没有通过市场安装的适配器：${id}`)
  const target = path.join(ADAPTER_DIR, record.file)
  try {
    if (existsSync(target)) unlinkSync(target)
  } catch {
    // 删除失败也移除记录，避免状态卡死。
  }
  delete installed[id]
  writeMarketInstalled(installed)
  loadAdapters()
  return { removed: id, file: record.file }
}

function marketSearch(index, query) {
  return searchEntries(index.entries, query, {
    installed: readMarketInstalled(),
    builtIn: adapterState.factoryIds,
  })
}

function marketMatch(index, device) {
  return matchEntries(index.entries, device, {
    installed: readMarketInstalled(),
    builtIn: adapterState.factoryIds,
  })
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function normalizeHex(value) {
  const text = String(value ?? '').trim().replace(/0x/gi, '')
  if (!text) throw new Error('hex 不能为空')
  const tokens = /\s/.test(text) ? text.split(/\s+/) : text.match(/../g) || []
  for (const token of tokens) {
    if (!/^[0-9a-f]{1,2}$/i.test(token)) throw new Error(`非法字节 \`${token}\``)
  }
  return tokens.join(' ')
}

function mapExchangeMode(mode) {
  const text = String(mode || 'setout').toLowerCase()
  if (text === 'write') return 'write'
  if (text === 'setfeature') return 'setFeature'
  if (text === 'getfeature') return 'getFeature'
  return 'setOut'
}

function createAdapterIo(device, hooks = {}) {
  const snapshot = Object.freeze({
    vid: device.vid,
    pid: device.pid,
    usagePage: device.usagePage,
    usage: device.usage,
    inputLen: device.inputLen,
    outputLen: device.outputLen,
    featureLen: device.featureLen,
    inLen: device.inputLen,
    outLen: device.outputLen,
    product: device.product,
  })
  const call = (cmd, payload, timeoutMs) => getDaemon().request(cmd, payload, timeoutMs)

  async function open(options = {}) {
    const explicitLength = ['inLen', 'outLen', 'featureLen'].some(
      (key) => options[key] !== undefined,
    )
    const opened = await call('open', {
      vid: options.vid || snapshot.vid,
      pid: options.pid || snapshot.pid,
      usagePage: options.usagePage || snapshot.usagePage,
      usage: options.usage || snapshot.usage,
      // 显式长度表示适配器在挑选集合；只使用它指定的过滤，不再混入快照长度。
      inLen: options.inLen ?? (explicitLength ? undefined : snapshot.inLen),
      outLen: options.outLen ?? (explicitLength ? undefined : snapshot.outLen),
      featureLen: options.featureLen ?? (explicitLength ? undefined : snapshot.featureLen),
      writable: options.writable !== false,
    })
    const sessionId = opened.session
    hooks.onOpen?.(sessionId)
    return Object.freeze({
      id: sessionId,
      device: opened.device,
      read: (opts = {}) =>
        call('read', {
          session: sessionId,
          timeoutMs: Math.min(Number(opts.timeoutMs) || 300, 5_000),
        }),
      write: (hex, opts = {}) =>
        call('write', {
          session: sessionId,
          hex: normalizeHex(hex),
          mode: mapExchangeMode(opts.mode),
          timeoutMs: Math.min(Number(opts.timeoutMs) || 400, 5_000),
        }),
      setFeature: (hex) => call('write', { session: sessionId, hex: normalizeHex(hex), mode: 'setFeature' }),
      getFeature: (hex) => call('getFeature', { session: sessionId, hex: normalizeHex(hex) }),
      flush: (idleMs = 20) => call('flush', { session: sessionId, idleMs }),
      close: () => {
        hooks.onClose?.(sessionId)
        return call('close', { session: sessionId }).catch(() => {})
      },
    })
  }

  const api = Object.freeze({
    device: snapshot,
    deviceJson: JSON.stringify(snapshot),
    open,
    withSession: async (options, fn) => {
      const session = await open(options)
      try {
        return await fn(session)
      } finally {
        await session.close()
      }
    },
    listDevices: async () => (await call('list', {})).devices,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Number(ms) || 0, 5_000))),
    // 只读被动监听：给“设备自己上报”的协议用（雷柏、DualSense 等）。
    // daemon 的 listen 上限是 30s，必须比默认 RPC 超时更长。
    listen: async (options = {}) =>
      call(
        'listen',
        {
          vid: String(options.vid || snapshot.vid),
          pid: String(options.pid || snapshot.pid),
          usagePage: options.usagePage || snapshot.usagePage,
          seconds: Math.min(Math.max(Math.round(Number(options.seconds) || 3), 1), 30),
        },
        32_000,
      ),
    exchange: async (options) => {
      const spec = options && typeof options === 'object' ? options : {}
      const session = await open({ ...spec, writable: spec.writable !== false })
      try {
        const mode = String(spec.mode || 'setout')
        const hexText = normalizeHex(spec.hex)
        const wait = Math.min(Number(spec.wait) || 800, 10_000)
        const lowered = mode.toLowerCase()
        if (lowered === 'getfeat' || lowered === 'getfeature') {
          const result = await session.getFeature(hexText)
          return {
            device: session.device,
            mode: 'getfeat',
            sent: hexText,
            reports: result.report ? [result.report] : [],
          }
        }
        await session.write(hexText, { mode: mapExchangeMode(mode), timeoutMs: wait })
        const reads = Math.min(Number(spec.reads) || 4, 32)
        const reports = []
        const deadline = Date.now() + wait
        while (reports.length < reads && Date.now() < deadline) {
          const result = await session.read({ timeoutMs: 120 })
          if (!result.report) break
          reports.push(result.report)
        }
        return { device: session.device, mode, sent: hexText, reports }
      } finally {
        await session.close()
      }
    },
  })

  // adapter 只拿到这个 JSON 桥；不把宿主对象/函数交给 vm。
  const bridgeCall = async (method, args = []) => {
    const json = (value) => JSON.stringify(value ?? null)
    const [first, second] = args
    switch (method) {
      case 'open': {
        const session = await api.open(first || {})
        return json({ id: session.id })
      }
      case 'read':
        return json(
          await getDaemon().request('read', {
            session: first,
            timeoutMs: Math.min(Number(second?.timeoutMs) || 300, 5_000),
          }),
        )
      case 'write':
        return json(
          await getDaemon().request('write', {
            session: first,
            hex: normalizeHex(second),
            mode: mapExchangeMode(args[2]?.mode),
            timeoutMs: Math.min(Number(args[2]?.timeoutMs) || 400, 5_000),
          }),
        )
      case 'setFeature':
        return json(
          await getDaemon().request('write', {
            session: first,
            hex: normalizeHex(second),
            mode: 'setFeature',
          }),
        )
      case 'getFeature':
        return json(
          await getDaemon().request('getFeature', {
            session: first,
            hex: normalizeHex(second),
          }),
        )
      case 'flush':
        return json(
          await getDaemon().request('flush', { session: first, idleMs: args[1] ?? 20 }),
        )
      case 'close':
        hooks.onClose?.(first)
        await getDaemon().request('close', { session: first }).catch(() => {})
        return json(null)
      case 'exchange': {
        const result = await api.exchange(first || {})
        return json({ reports: result.reports || [], sent: result.sent, mode: result.mode })
      }
      case 'listen':
        return json(await api.listen(first || {}))
      case 'listDevices':
        return json(await api.listDevices())
      case 'sleep':
        await api.sleep(first)
        return json(null)
      default:
        throw new Error(`未知 adapter io 方法：${method}`)
    }
  }

  return Object.freeze({ ...api, call: bridgeCall })
}

function nowHHMM() {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function adapterDevice(adapter, status, extra = {}) {
  return {
    key: adapter.id,
    name: adapter.name,
    kind: adapter.kind,
    transport: adapter.transport,
    status,
    percent: null,
    charging: null,
    updatedAt: null,
    source: 'adapter',
    ...extra,
  }
}

async function readAdapterDevices(onDevice) {
  const emit = (device) => {
    if (typeof onDevice === 'function') {
      try {
        onDevice(device)
      } catch {
        // 渐进发布失败不影响读数。
      }
    }
  }
  if (adapterState.adapters.length === 0) return []
  let devices
  try {
    const result = await getDaemon().request('list', {})
    devices = Array.isArray(result.devices) ? result.devices : []
  } catch (error) {
    const message = String(error?.message ?? error)
    return adapterState.adapters.map((adapter) => {
      const device = adapterDevice(adapter, 'error', { error: message })
      emit(device)
      return device
    })
  }
  const results = []
  for (const adapter of adapterState.adapters) {
    const device = devices.find(
      (candidate) => adapterMatches(adapter, candidate),
    )
    if (!device) {
      // 宽匹配的协议族适配器不代表用户真的拥有这台设备；只在显式声明时显示占位。
      if (adapter.showWhenMissing) {
        const missing = adapterDevice(adapter, 'missing')
        results.push(missing)
        emit(missing)
      }
      continue
    }
    const sessions = new Set()
    let stopped = false
    const hostIo = createAdapterIo(device, {
      onOpen: (id) => {
        if (stopped) {
          void getDaemon().request('close', { session: id }, 2_000).catch(() => {})
          return
        }
        sessions.add(id)
      },
      onClose: (id) => sessions.delete(id),
    })
    const io = typeof adapter.ioFactory === 'function' ? adapter.ioFactory(hostIo) : hostIo
    try {
      const reading = await withTimeout(adapter.read(io), 8_000, `适配器 ${adapter.id}`)
      const percent = Math.round(Number(reading?.percent))
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error('read() 必须返回 0–100 的 percent')
      }
      const charging = typeof reading?.charging === 'boolean' ? reading.charging : null
      const displayName =
        typeof reading?.name === 'string' && reading.name.trim() ? reading.name.trim() : adapter.name
      const online = adapterDevice(adapter, 'online', {
        name: displayName,
        percent,
        charging,
        updatedAt: nowHHMM(),
      })
      results.push(online)
      emit(online)
    } catch (error) {
      const message = String(error?.message ?? error)
      const failed = adapterDevice(
        adapter,
        /超时|无应答|NoResponse|timeout|休眠/i.test(message) ? 'asleep' : 'error',
        { error: message },
      )
      results.push(failed)
      emit(failed)
    } finally {
      // adapter 超时/抛错时可能仍持有 session；主动关闭，避免 HID 句柄泄漏。
      stopped = true
      for (const sessionId of sessions) {
        await getDaemon().request('close', { session: sessionId }, 2_000).catch(() => {})
      }
      sessions.clear()
    }
  }
  return results
}

// ---- Bluetooth（BLE）数据源 ------------------------------------------------
// Windows 的蓝牙电量有两个来源：GATT Battery Service（主动读）和蓝牙栈已知
// 的电量属性（Settings 显示的就是它）。脚本把两者都收进同一个列表。

const bleState = { devices: [], raw: [], scannedAt: 0, error: null, diagnostics: null }
let bleInflight = null

function bleDeviceEntry(device) {
  return {
    key: `ble:${device.id || device.name || 'unknown'}`,
    name: device.name || 'Bluetooth 设备',
    kind: 'bluetooth',
    transport: device.source === 'windows'
      ? '蓝牙 · Windows 已知'
      : device.source === 'fastpair'
        ? '蓝牙 · Fast Pair'
        : 'BLE · GATT',
    status: 'online',
    percent: Number(device.percent),
    charging: typeof device.charging === 'boolean' ? device.charging : null,
    detail: typeof device.detail === 'string' && device.detail ? device.detail : null,
    components: Array.isArray(device.components)
      ? device.components
          .filter(
            (component) =>
              component &&
              typeof component.label === 'string' &&
              Number.isFinite(Number(component.percent)),
          )
          .map((component) => ({
            label: component.label,
            percent: Number(component.percent),
            charging: component.charging === true,
          }))
      : [],
    updatedAt: nowHHMM(),
    source: 'ble',
  }
}

async function scanBle() {
  if (bleInflight) return bleInflight
  bleInflight = (async () => {
    try {
      const data = await getDaemon().request('ble', {})
      bleState.raw = Array.isArray(data.devices) ? data.devices : []
      bleState.devices = bleState.raw
        .filter((device) => device.percent != null && Number.isFinite(Number(device.percent)))
        .map(bleDeviceEntry)
      bleState.scannedAt = Date.now()
      bleState.diagnostics = data.diagnostics || null
      bleState.error = null
    } catch (error) {
      bleState.error = String(error?.message ?? error)
    } finally {
      bleInflight = null
    }
    return bleState.devices
  })()
  return bleInflight
}

async function ensureBle(force) {
  const age = Date.now() - bleState.scannedAt
  // Rust 侧扫描约 1 秒，强制刷新时用更短阈值，关机/断连能更快反映出来。
  const stale = bleState.scannedAt === 0 || age > (force ? 30_000 : BLE_TTL_MS)
  if (stale) await scanBle()
  return bleState.devices
}

// ---- 新设备发现 -------------------------------------------------------------
// 用户不该被要求报 VID/PID。按产品名分组列出「尚未适配的厂商 HID 设备」，
// watch 模式则在用户插 dongle / 打开设备的窗口期内反复枚举。

function deviceSignature(device) {
  return `${device.vid}:${device.pid}:${device.usagePage}:${device.inputLen}:${device.outputLen}:${device.featureLen}`
}

function isSystemHidName(product) {
  const name = String(product || '').trim()
  if (!name || name === '(无产品名)') return true
  return /^(HIDI2C|HID-compliant|Microsoft|System)/i.test(name)
}

function detectCandidates(devices) {
  const covered = new Set()
  for (const device of devices) {
    if (device.supported) covered.add(`${device.vid}:${device.pid}`)
  }
  for (const adapter of adapterState.adapters) {
    for (const vid of adapter.match.vids) {
      if (adapter.match.pids.length === 0) {
        for (const device of devices) {
          if (device.vid === vid) covered.add(`${device.vid}:${device.pid}`)
        }
        continue
      }
      for (const pid of adapter.match.pids) covered.add(`${vid}:${pid}`)
    }
  }

  const groups = new Map()
  for (const device of devices) {
    if (!device.vendorPage) continue
    if (isSystemHidName(device.product || device.manufacturer)) continue
    const id = `${device.vid}:${device.pid}`
    if (covered.has(id)) continue
    let group = groups.get(id)
    if (!group) {
      group = {
        vid: device.vid,
        pid: device.pid,
        product: device.product || device.manufacturer || '(无产品名)',
        collections: [],
      }
      groups.set(id, group)
    }
    group.collections.push({
      usagePage: device.usagePage,
      usage: device.usage,
      inLen: device.inputLen,
      outLen: device.outputLen,
      featureLen: device.featureLen,
    })
  }
  return [...groups.values()]
}

async function detectDevices(mode, seconds) {
  let baseline = null
  if (mode === 'watch') {
    // 先记下当前枚举，再等用户插上/打开设备，最后只报新出现的——过滤掉系统内置设备。
    baseline = new Set(
      parseCliJson(await runCli(['probe', 'list', '--json'])).devices.map(deviceSignature),
    )
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
  const devices = parseCliJson(await runCli(['probe', 'list', '--json'])).devices
  const appeared = baseline
    ? devices.filter((device) => !baseline.has(deviceSignature(device)))
    : []
  const source = appeared.length > 0 ? appeared : devices
  return {
    mode,
    waitedSeconds: mode === 'watch' ? seconds : 0,
    appearedCount: appeared.length,
    candidates: detectCandidates(source),
    adapterDirectory: ADAPTER_DIR,
  }
}

function renderDetectText(value) {
  if (!value.candidates || value.candidates.length === 0) {
    return value.mode === 'watch'
      ? '监听结束，没有发现新设备，也没有未适配的厂商 HID 设备。请确认接收器已插好、设备已开机。'
      : '当前没有未适配的厂商 HID 设备（内置协议和用户适配器已经覆盖了它们）。'
  }
  const lines = []
  if (value.mode === 'watch' && value.appearedCount > 0) {
    lines.push(`监听期间新出现了 ${value.appearedCount} 个 HID 集合：`)
  } else if (value.mode === 'watch') {
    lines.push('监听期间没有新设备出现；当前未适配的厂商设备如下（可能是系统内置设备）：')
  } else {
    lines.push('当前未适配的厂商 HID 设备：')
  }
  for (const candidate of value.candidates) {
    lines.push(`- ${candidate.product}（${candidate.vid}:${candidate.pid}）`)
    for (const collection of candidate.collections) {
      lines.push(
        `  · usagePage=${collection.usagePage} usage=${collection.usage} IN=${collection.inLen} OUT=${collection.outLen} FEA=${collection.featureLen}`,
      )
    }
  }
  lines.push('', '确认这是目标设备后，就用这些集合逐个试探协议；不需要用户知道 VID/PID。')
  return lines.join('\n')
}

function renderProtocolsText(value) {
  const lines = [`协议目录：${value.catalog.length} 条`]
  if (!value.matches || value.matches.length === 0) {
    lines.push('', '当前设备没有命中任何已知协议。可以先用 probe listen / exchange 抓包，再写新适配器。')
    return lines.join('\n')
  }
  lines.push('', '当前设备命中的已知协议：')
  for (const row of value.matches) {
    const device = row.device
    lines.push(`- ${device.product || '(无产品名)'}（${device.vid}:${device.pid} UP=${device.usagePage}）`)
    for (const protocol of row.protocols) {
      lines.push(`  · ${protocol.name}（${protocol.status}，${protocol.transport}）`)
      if (protocol.frame) lines.push(`    帧：${protocol.frame}`)
      if (protocol.parse) lines.push(`    解析：${protocol.parse}`)
      if (protocol.notes) lines.push(`    注意：${protocol.notes}`)
      if (protocol.adapter) lines.push(`    适配器：已加载 ${protocol.adapter}`)
      else lines.push('    适配器：未提供（按此协议生成后 battery_save_adapter 热加载）')
      if (protocol.source) lines.push(`    来源：${protocol.source}`)
    }
  }
  return lines.join('\n')
}

function renderSaveAdapterText(value) {
  const lines = [`已写入用户适配器：${value.file}`]
  lines.push(`当前加载 ${value.adapters.length} 个适配器：`)
  for (const adapter of value.adapters) {
    const origin = adapter.origin === 'factory' ? '出厂' : '用户'
    lines.push(`- [${origin}] ${adapter.name}（${adapter.id}）← ${adapter.file}`)
  }
  if (value.errors.length > 0) {
    lines.push('', '加载失败：')
    for (const error of value.errors) lines.push(`- ${error.file}: ${error.message}`)
  }
  return lines.join('\n')
}

function marketStatusText(status) {
  if (status === 'verified') return '真机验证'
  if (status === 'community') return '社区验证'
  if (status === 'experimental') return '实验性'
  return status
}

function renderMarketText(value) {
  if (value.requiresConfirmation || value.action === 'preview') {
    const entry = value.entry
    const match = entry.match
    const code =
      value.source.length > 8_000
        ? `${value.source.slice(0, 8_000)}\n…（已截断；安装时会校验完整源码）`
        : value.source
    return [
      `准备安装：${entry.name}（${entry.id}）`,
      `匹配：${match.vids.join('/')}:${match.pids.length > 0 ? match.pids.join('/') : '*'}${
        match.usagePage ? ` UP=${match.usagePage}` : ''
      }`,
      ...(entry.connection?.length ? [`连接：${entry.connection.join(' · ')}`] : []),
      `作者：${entry.author || '未知'} · 状态：${marketStatusText(entry.status)}`,
      `SHA-256：${value.sha256}`,
      '',
      '源码（请先审阅；适配器拥有 HID 读写能力）：',
      '```js',
      code,
      '```',
      '',
      `确认安装请调用：battery_market({ action: "install", id: "${entry.id}", confirm: true })`,
    ].join('\n')
  }

  if (value.action === 'search') {
    const lines = [`适配器源：${value.sourceUrl}`]
    if (value.warnings?.length > 0) lines.push(`索引警告：${value.warnings.join('；')}`)
    if (!value.entries || value.entries.length === 0) {
      lines.push('没有匹配的适配器。')
      return lines.join('\n')
    }
    lines.push(`找到 ${value.entries.length} 个：`)
    for (const entry of value.entries) {
      const match = entry.match
      lines.push(
        `- [${marketStatusText(entry.status)}] ${entry.name}${
          entry.model ? `（${entry.model}）` : ''
        }${entry.installed ? ' · 已安装' : ''}`,
      )
    }
    lines.push('', '安装前先 preview 查看源码。')
    return lines.join('\n')
  }

  if (value.action === 'install') {
    return [
      `已安装：${value.installed.name}（${value.installed.sha256.slice(0, 12)}…）`,
      `文件：${value.installed.file}`,
      `当前加载 ${value.adapters.length} 个适配器。`,
    ].join('\n')
  }

  if (value.action === 'remove') {
    return `已移除市场适配器：${value.removed}（${value.file}）`
  }

  if (value.action === 'list') {
    const entries = Object.entries(value.installed || {})
    if (entries.length === 0) return '还没有通过市场安装的适配器。'
    return [
      `已安装 ${entries.length} 个市场适配器：`,
      ...entries.map(
        ([id, record]) =>
          `- ${record.name || id}（${id}）← ${record.file} · ${new Date(record.installedAt).toLocaleString('zh-CN')}`,
      ),
    ].join('\n')
  }

  return JSON.stringify(value, null, 2)
}

function renderExchangeText(value) {
  const lines = [
    `设备：${value.device.vid}:${value.device.pid} UP=${value.device.usagePage} U=${value.device.usage}`,
    `模式：${value.mode}`,
    `发送：${value.sent}`,
  ]
  if (!value.reports || value.reports.length === 0) {
    lines.push('应答：无（设备休眠、帧不对，或被厂商软件占用）')
  } else {
    lines.push(`应答 ${value.reports.length} 帧：`)
    for (const report of value.reports) lines.push(`- ${report}`)
  }
  return lines.join('\n')
}

function renderListenText(value) {
  const lines = [`监听 ${value.windowMs} ms，收到 ${value.reports.length} 帧`]
  for (const collection of value.collections || []) {
    lines.push(
      `集合：UP=${collection.usagePage} IN=${collection.inLen} OUT=${collection.outLen} FEA=${collection.fea} ${collection.opened ? '打开成功' : `打开失败：${collection.error || ''}`}`,
    )
  }
  for (const report of (value.reports || []).slice(0, 20)) {
    lines.push(`- UP=${report.usagePage} len=${report.len} ${report.hex}`)
  }
  if (value.reports && value.reports.length > 20) lines.push(`…另有 ${value.reports.length - 20} 帧`)
  return lines.join('\n')
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      CLI,
      args,
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }),
    )
  })
}

function parseCliJson(result) {
  const text = result.stdout.trim()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const detail = result.error?.message || result.stderr.trim() || '侧车没有返回 JSON'
    throw new Error(`侧车调用失败：${detail}`)
  }
  if (!data.ok) throw new Error(data?.error?.message || '侧车返回失败')
  return data
}

function statusText(device) {
  switch (device.status) {
    case 'online':
      return device.charging === true ? `充电中 · ${device.percent}%` : `${device.percent}%`
    case 'asleep':
      return device.percent != null ? `休眠 · 上次 ${device.percent}%` : '休眠中'
    case 'unplugged':
    case 'missing':
      return device.percent != null ? `已拔出 · 上次 ${device.percent}%` : '已拔出'
    default:
      return '读取失败'
  }
}

function statusValue(device) {
  if (device.status === 'online') {
    if (device.percent == null) return '电量未知'
    return device.charging === true ? `充电中 · ${device.percent}%` : `${device.percent}%`
  }
  return statusText(device)
}

function filterSnapshot(snapshot, deviceFilter) {
  if (!deviceFilter) return snapshot
  const needle = String(deviceFilter).trim().toLowerCase()
  if (!needle) return snapshot
  const devices = snapshot.devices.filter((device) =>
    `${device.key} ${device.name} ${device.kind}`.toLowerCase().includes(needle),
  )
  return { ...snapshot, devices }
}

function renderStatusText(value) {
  if (!value || !Array.isArray(value.devices) || value.devices.length === 0) {
    return '没有匹配的设备。可能原因：侧车未构建、设备未连接，或设备全部休眠。'
  }
  const lines = value.devices.map(
    (device) => `- ${device.name}（${device.kind}，${device.transport}）：${statusValue(device)}`,
  )
  return [
    `读取时间：${new Date(value.generatedAtMs).toLocaleString('zh-CN')}`,
    `侧车版本：${value.sidecarVersion}`,
    ...(value.stale ? [`注意：最近一次轮询失败（${value.pollError}），下面是上一轮缓存。`] : []),
    '',
    ...lines,
    '',
    '“休眠中”是 2.4G 外设的正常省电行为：按一下设备再查即可；“已拔出”表示设备当前不在，占位行保留上次读数，可手动移除；“读取失败”才是故障。',
    ...(value.devices.some((device) => device.status === 'error')
      ? ['“读取失败”常见原因之一是厂商软件（G HUB / Synapse / 厂商 HUB）独占了 HID 通道；关掉它再查一次。']
      : []),
    ...(value.hints && value.hints.length > 0
      ? [
          '',
          '发现未适配设备（协议目录里有线索，说“帮我适配”即可）：',
          ...value.hints.map((hint) => `- ${hint.product}（${hint.vid}:${hint.pid}）：${hint.protocols.join(' / ')}`),
        ]
      : []),
  ].join('\n')
}

function renderProbeText(value) {
  if (!value || !Array.isArray(value.devices)) return '没有拿到 HID 设备列表。'
  const supported = value.devices.filter((device) => device.supported)
  const vendorUnsupported = value.devices.filter(
    (device) => !device.supported && device.vendorPage,
  )
  const lines = [
    `共 ${value.devices.length} 个 HID 集合，已适配 ${supported.length} 个协议集合。`,
    '',
    '已适配：',
    ...supported.map((device) => `- ${device.vid}:${device.pid} UP=${device.usagePage} ${device.product || '(无产品名)'}`),
  ]
  if (vendorUnsupported.length > 0) {
    lines.push('', '未适配的厂商自定义集合（后续可用 IO 原语写适配器）：')
    lines.push(
      ...vendorUnsupported.map(
        (device) => `- ${device.vid}:${device.pid} UP=${device.usagePage} IN=${device.inputLen} OUT=${device.outputLen} FEA=${device.featureLen} ${device.product || '(无产品名)'}`,
      ),
    )
  }
  return lines.join('\n')
}

function renderSettingsText(value) {
  return [
    `定时刷新：${value.scheduled ? '开' : '关'}`,
    `轮询间隔：${value.intervalMinutes} 分钟`,
    `低电量阈值：${value.thresholdPercent}%`,
    `系统通知：${value.notify ? '开' : '关'}`,
    `实验性适配器：${value.betaEnabled === false ? '关闭（仅 stable）' : '开启'}`,
    ...(value.marketUrl ? [`适配器源：${value.marketUrl}`] : []),
  ].join('\n')
}

function renderAdaptersText(value) {
  const lines = [
    `出厂适配器（随插件更新）：${value.factoryDirectory || '(包内)'}`,
    `用户适配器（永不覆盖）：${value.adapterDirectory}`,
    `已加载 ${value.adapters.length} 个适配器${value.loadedAt ? `（扫描于 ${new Date(value.loadedAt).toLocaleTimeString('zh-CN')}）` : ''}`,
  ]
  for (const adapter of value.adapters) {
    const match = adapter.match
    const origin = adapter.origin === 'factory' ? '出厂' : '用户'
    const tier = adapter.tier === 'stable' ? 'stable' : adapter.tier === 'beta' ? 'beta' : 'user'
    lines.push(
      `- [${origin}/${tier}] ${adapter.name}（${adapter.id}）：${match.vids.join('/')}:${match.pids.length > 0 ? match.pids.join('/') : '*'}${match.usagePage ? ` UP=${match.usagePage}` : ''} ← ${adapter.file}`,
    )
  }
  if (value.errors.length > 0) {
    lines.push('', '加载失败：')
    for (const error of value.errors) lines.push(`- [${error.origin === 'factory' ? '出厂' : '用户'}] ${error.file}: ${error.message}`)
  }
  return lines.join('\n')
}

function renderDevicesText(value) {
  const devices = value.devices || []
  if (devices.length === 0) return '还没有已知设备。'
  const lines = [`设备 ${devices.length} 台（顺序即底栏顺序）：`]
  for (const device of devices) {
    lines.push(`- [${device.visible ? '显示' : '隐藏'}] ${device.name}（${device.key}）· ${statusText(device)}`)
  }
  lines.push(
    '',
    '操作：battery_devices({ action: "rename"|"resetName"|"show"|"hide"|"move"|"remove", key, name, direction })',
  )
  return lines.join('\n')
}

function renderBleText(value) {
  const lines = [
    `扫描时间：${value.scannedAtMs ? new Date(value.scannedAtMs).toLocaleString('zh-CN') : '未扫描'}`,
  ]
  if (value.error) lines.push(`扫描错误：${value.error}`)
  if (!value.devices || value.devices.length === 0) {
    lines.push('没有发现带电量服务的蓝牙设备（需要设备已配对、在附近，且实现了 GATT Battery Service 或由 Windows 上报电量）。')
    return lines.join('\n')
  }
  lines.push(`共 ${value.devices.length} 台：`)
  for (const device of value.devices) {
    lines.push(
      `- ${device.name}（${device.transport}）：${device.percent}%${
        device.charging === true ? '，充电中' : ''
      }${device.detail ? ` · ${device.detail}` : ''}`,
    )
  }
  return lines.join('\n')
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readBody(request, limit = 64 * 1024) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    throw new Error('无线外设电量插件仅支持 Windows（需要 HID/WinRT）')
  }
  if (!existsSync(DAEMON_EXE)) {
    throw new Error('插件包缺少 bin/peripheral-battery-daemon.exe，请重新安装完整发布包')
  }
  if (!existsSync(CLI)) {
    throw new Error('插件包缺少 bin/peripheral-battery-cli.exe，请重新安装完整发布包')
  }
  let settings = loadSettings(config)
  adapterState.includeBeta = settings.betaEnabled !== false
  migrateLegacySeededAdapters()
  loadAdapters()
  loadDeviceRegistry()
  let deviceEventTimer = null
  ctx.effect(() => () => {
    if (deviceEventTimer) {
      clearTimeout(deviceEventTimer)
      deviceEventTimer = null
    }
    if (daemonClient) {
      daemonClient.onEvent = null
      daemonClient.dispose()
      daemonClient = null
    }
  })
  let timerDispose = null

  const state = {
    snapshot: null,
    error: null,
    lastPolledAt: 0,
    inflight: null,
    pendingRefresh: false,
    armed: new Map(),
    raw: new Map(),
    base: {},
    refreshing: false,
    daemonVersion: '',
    rev: 0,
    sources: createSourceLedger(),
    clientSeenAt: 0,
  }

  // 长轮询等待者：快照一发布就唤醒客户端，不再按固定间隔轮询。
  const waiters = new Set()
  function notifyWaiters() {
    for (const wake of [...waiters]) {
      try {
        wake()
      } catch {
        // 单个等待者失败不影响其他客户端。
      }
    }
  }

  // 插件卸载时结束挂起的长轮询，避免浏览器一直等。
  ctx.effect(() => () => {
    for (const wake of [...waiters]) {
      try {
        wake()
      } catch {
        // ignore
      }
    }
    waiters.clear()
  })

  function toast(title, body, { force = false } = {}) {
    if (!settings.notify && !force) return
    execFile(
      POWERSHELL,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        TOAST_SCRIPT,
        '-Title',
        title,
        '-Body',
        body,
        '-AppId',
        DSH_APP_ID,
      ],
      { windowsHide: true, timeout: 20_000 },
      (error) => {
        if (error) console.warn(`[peripheral-battery] toast 失败：${error.message}`)
      },
    )
  }

  function checkAlerts(snapshot) {
    if (!settings.notify) return
    for (const device of snapshot.devices) {
      if (device.status !== 'online' || device.percent == null) continue
      const key = device.key
      if (device.charging === true) {
        state.armed.set(key, false)
        continue
      }
      if (device.percent <= settings.thresholdPercent) {
        if (!state.armed.get(key)) {
          state.armed.set(key, true)
          toast('外设电量提醒', `${device.name} 电量 ${device.percent}%，建议尽快充电。`)
        }
      } else if (device.percent > Math.min(settings.thresholdPercent + 5, 100)) {
        state.armed.set(key, false)
      }
    }
  }

  function publishSnapshot() {
    state.snapshot = buildSnapshot([...state.raw.values()], state.base)
    state.rev += 1
    notifyWaiters()
  }

  function currentRawDevices() {
    return [...state.raw.values()]
  }

  function adapterClaimsDevice(device, raw = state.raw) {
    const vid = String(device.vid || '').toUpperCase()
    const pid = String(device.pid || '').toUpperCase()
    if (!vid || !pid) return false
    return adapterState.adapters.some((adapter) => {
      const recorded = raw.get(adapter.id)
      if (!recorded || recorded.status !== 'online') return false
      const match = adapter.match
      if (!match.vids.includes(vid)) return false
      return match.pids.length === 0 || match.pids.includes(pid)
    })
  }

  function deviceAction(payload) {
    const action = String(payload?.action || '')
    const key = String(payload?.key || '')
    const entry = deviceRegistry.get(key)
    if (!entry) throw new Error('设备不存在')
    switch (action) {
      case 'show':
        entry.visible = true
        break
      case 'hide':
        entry.visible = false
        break
      case 'rename':
        entry.customName = normalizeCustomName(payload.name)
        break
      case 'resetName':
        entry.customName = null
        break
      case 'move': {
        const list = [...deviceRegistry.values()].sort((left, right) => left.order - right.order)
        const index = list.findIndex((item) => item.key === key)
        const target = payload.direction === 'up' ? index - 1 : index + 1
        if (index < 0 || target < 0 || target >= list.length) return registryList(currentRawDevices())
        const [moved] = list.splice(index, 1)
        list.splice(target, 0, moved)
        list.forEach((item, position) => {
          item.order = position + 1
        })
        deviceOrderSeq = Math.max(deviceOrderSeq, list.length)
        break
      }
      case 'moveTo': {
        const list = [...deviceRegistry.values()].sort((left, right) => left.order - right.order)
        const index = list.findIndex((item) => item.key === key)
        if (index < 0) return registryList(currentRawDevices())
        const target = Math.max(0, Math.min(list.length - 1, Math.round(Number(payload.index))))
        if (target === index) return registryList(currentRawDevices())
        const [moved] = list.splice(index, 1)
        list.splice(target, 0, moved)
        list.forEach((item, position) => {
          item.order = position + 1
        })
        deviceOrderSeq = Math.max(deviceOrderSeq, list.length)
        break
      }
      case 'remove':
        // 在线设备「移除」= 隐藏，避免下一轮又被自动发现；已拔出才真正删除记录。
        if (state.raw.has(key)) {
          entry.visible = false
        } else {
          deviceRegistry.delete(key)
        }
        break
      default:
        throw new Error('未知操作')
    }
    saveDeviceRegistry()
    publishSnapshot()
    return registryList(currentRawDevices())
  }

  // 休眠设备不会触发 WM_DEVICECHANGE；短间隔重试，唤醒后无需手动刷新。
  let asleepRetryTimer = null
  let asleepRetryDelay = 5_000

  function clearAsleepRetry() {
    if (asleepRetryTimer) {
      clearTimeout(asleepRetryTimer)
      asleepRetryTimer = null
    }
  }

  function scheduleAsleepRetry(snapshot) {
    const hasAsleep = Boolean(
      snapshot?.devices?.some((device) => device.visible !== false && device.status === 'asleep'),
    )
    if (!hasAsleep) {
      clearAsleepRetry()
      asleepRetryDelay = 5_000
      return
    }
    // 页面关闭后不再为休眠设备保持 daemon / 轮询；下一次打开页面会重新启动。
    if (!state.clientSeenAt || Date.now() - state.clientSeenAt > 5 * 60_000) {
      clearAsleepRetry()
      asleepRetryDelay = 5_000
      return
    }
    if (asleepRetryTimer) return
    const delay = asleepRetryDelay
    asleepRetryDelay = Math.min(asleepRetryDelay * 2, 10_000)
    asleepRetryTimer = setTimeout(() => {
      asleepRetryTimer = null
      void poll(true, { adaptersOnly: true })
    }, delay)
  }

  function poll(force = false, options = {}) {
    if (state.inflight) {
      if (force) state.pendingRefresh = true
      return state.inflight
    }
    const adaptersOnly = options.adaptersOnly === true
    const intervalMs = settings.intervalMinutes * 60_000
    if (!force && state.snapshot && Date.now() - state.lastPolledAt < intervalMs) {
      scheduleAsleepRetry(state.snapshot)
      return Promise.resolve(state.snapshot)
    }
    state.inflight = (async () => {
      state.refreshing = true
      const nextRaw = adaptersOnly ? new Map(state.raw) : new Map()
      let nextBase = adaptersOnly ? { ...state.base, generatedAtMs: Date.now() } : {}
      try {
        if (!state.daemonVersion) {
          try {
            state.daemonVersion = (await getDaemon().request('ping', {})).version || '0.1.0'
          } catch {
            state.daemonVersion = '0.1.0'
          }
        }
        if (!adaptersOnly) {
          nextBase = {
            schema: 1,
            version: state.daemonVersion,
            sidecarVersion: state.daemonVersion,
            generatedAtMs: Date.now(),
          }
          try {
            const xinput = await getDaemon().request('xinput', {})
            const devices = xinput.devices || []
            for (const device of devices) nextRaw.set(device.key, device)
            state.sources.set('xinput', { count: devices.length, error: null })
          } catch (error) {
            state.sources.set('xinput', { count: 0, error: String(error?.message ?? error) })
            // 没有 XInput 手柄不影响 HID / BLE 数据源。
          }
        } else {
          // 轻量重试只重读适配器，删掉旧适配器条目，避免已移除设备残留。
          for (const adapter of adapterState.adapters) nextRaw.delete(adapter.id)
        }
        await readAdapterDevices((device) => {
          nextRaw.set(device.key, device)
        })
        if (!adaptersOnly) {
          try {
            const generic = await getDaemon().request('genericBattery', {})
            for (const device of generic.devices || []) {
              if (adapterClaimsDevice(device, nextRaw)) continue
              nextRaw.set(device.key, device)
            }
            state.sources.set('generic', {
              enumerated: Number(generic.diagnostics?.enumerated) || 0,
              matched: Number(generic.diagnostics?.matched) || 0,
              error: generic.diagnostics?.error || null,
            })
          } catch (error) {
            state.sources.set('generic', {
              enumerated: 0,
              matched: 0,
              error: String(error?.message ?? error),
            })
            // 旧 daemon 或不支持标准 HID Battery：不影响适配器/BLE。
          }
          const ble = await ensureBle(force)
          for (const device of ble) nextRaw.set(device.key, device)
          state.sources.set('ble', {
            gatt: Number(bleState.diagnostics?.gatt) || 0,
            windows: Number(bleState.diagnostics?.windows) || 0,
            fastpair: Number(bleState.diagnostics?.fastpair) || 0,
            fastpairAdvertisements: Number(bleState.diagnostics?.fastpairAdvertisements) || 0,
            fastpairError: bleState.diagnostics?.fastpairError || null,
            count: ble.length,
            error: bleState.error,
          })
          try {
            const phone = await getDaemon().request('phonelink', {})
            const devices = phone.devices || []
            for (const device of devices) nextRaw.set(device.key, device)
            state.sources.set('phonelink', {
              fileFound: phone.diagnostics?.fileFound === true,
              ageSecs: typeof phone.diagnostics?.ageSecs === 'number'
                ? phone.diagnostics.ageSecs
                : null,
              count: devices.length,
              error: phone.diagnostics?.error || null,
            })
          } catch (error) {
            state.sources.set('phonelink', {
              fileFound: false,
              ageSecs: null,
              count: 0,
              error: String(error?.message ?? error),
            })
            // 没有 Phone Link 或旧 daemon：不影响其他数据源。
          }
        }
        // 所有源写进临时 Map 后再替换，避免分步 publish 把设备闪成“已拔出”。
        state.raw = nextRaw
        state.base = nextBase
        state.error = null
        publishSnapshot()
        scheduleAsleepRetry(state.snapshot)
        if (state.snapshot) checkAlerts(state.snapshot)
      } catch (error) {
        state.error = String(error?.message ?? error)
        publishSnapshot()
        scheduleAsleepRetry(state.snapshot)
      } finally {
        state.refreshing = false
        state.lastPolledAt = Date.now()
        state.inflight = null
        if (state.pendingRefresh) {
          state.pendingRefresh = false
          queueMicrotask(() => void poll(true))
        }
      }
      return state.snapshot
    })()
    return state.inflight
  }

  function statusPayload() {
    return {
      ok: true,
      snapshot: state.snapshot,
      settings,
      lastPolledAt: state.lastPolledAt,
      intervalMs: settings.intervalMinutes * 60_000,
      error: state.error,
      refreshing: state.refreshing,
      rev: state.rev,
      devices: registryList(currentRawDevices()),
      adapters: adapterPublicList(),
      adapterErrors: adapterState.errors,
      ble: {
        scannedAtMs: bleState.scannedAt,
        count: bleState.devices.length,
        error: bleState.error,
        diagnostics: bleState.diagnostics,
      },
      sources: state.sources.toJSON(),
    }
  }

  async function healthPayload() {
    let daemon = {
      running: false,
      pid: null,
      version: state.daemonVersion || null,
      error: null,
    }
    try {
      daemon = await getDaemon().health()
      if (daemon.version) state.daemonVersion = daemon.version
    } catch (error) {
      daemon.error = String(error?.message ?? error)
    }
    return {
      ok: true,
      plugin: {
        version: PLUGIN_VERSION,
        platform: process.platform,
        arch: process.arch,
      },
      daemon,
      lastPolledAt: state.lastPolledAt,
      lastError: state.error,
      deviceCount: state.snapshot?.devices?.length || 0,
      adapterCount: adapterState.adapters.length,
      adapterErrors: adapterState.errors,
      sources: state.sources.toJSON(),
      paths: {
        settings: SETTINGS_DIR,
        userAdapters: ADAPTER_DIR,
        factoryAdapters: FACTORY_ADAPTER_DIR,
      },
    }
  }

  async function verificationReport(id) {
    const adapter = adapterState.adapters.find((entry) => entry.id === id)
    const record = readMarketInstalled()[id]
    if (!adapter && !record) throw new Error(`没有找到适配器：${id}`)

    const health = await healthPayload()
    const devices = registryList(currentRawDevices()).filter((device) => device.key === id)
    const origin = record ? 'market' : adapter?.origin || 'unknown'
    const tier = adapter?.tier || 'market'
    const match = adapter?.match
    const lines = [
      `# 适配器验证报告：${adapter?.name || record?.name || id}`,
      '',
      `- 适配器 ID：${id}`,
      `- 来源：${origin === 'market' ? '市场安装' : origin === 'factory' ? '出厂' : '用户'}`,
      `- 层级：${tier}`,
      `- 文件：${adapter?.file || record?.file || '—'}`,
      `- SHA-256：${record?.sha256 || '—'}`,
      ...(record?.status ? [`- 市场状态：${marketStatusText(record.status)}`] : []),
      `- 插件版本：${health.plugin.version}`,
      `- daemon 版本：${health.daemon.version || '—'}`,
      `- 平台：${health.plugin.platform}/${health.plugin.arch}`,
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      ...(record?.source ? [`- 安装源：${record.source}`] : []),
      ...(match
        ? [
            `- 匹配：${match.vids.join('/')}:${match.pids.length > 0 ? match.pids.join('/') : '*'}${
              match.usagePage ? ` UP=${match.usagePage}` : ''
            }`,
          ]
        : []),
      '',
      '## 当前读数',
      '',
    ]
    if (devices.length === 0) {
      lines.push('当前没有匹配设备。请插上设备、开机后重新生成报告。')
    } else {
      for (const device of devices) {
        lines.push(
          `- ${device.name} · key=${device.key} · 状态=${device.status} · 电量=${device.percent ?? '—'}% · 充电=${
            device.charging == null ? '未知' : device.charging ? '是' : '否'
          }${device.error ? ` · 错误=${device.error}` : ''}`,
        )
      }
    }
    lines.push(
      '',
      '## 用户验证清单',
      '',
      '- [ ] 电量与厂商软件一致',
      '- [ ] 充电状态正确',
      '- [ ] 休眠/关机不误报 0%',
      '- [ ] 拔出/重连正常',
      '',
      '## 备注',
      '',
      '（请填写设备型号、固件版本、接收器型号、测试现象）',
      '',
      '---',
      '提交到：https://github.com/wbx1217/dsh-peripheral-battery-adapters/issues/new?template=adapter-verification.yml',
    )
    return {
      text: lines.join('\n'),
      report: {
        adapterId: id,
        name: adapter?.name || record?.name || id,
        origin,
        tier,
        file: adapter?.file || record?.file || null,
        sha256: record?.sha256 || null,
        pluginVersion: health.plugin.version,
        daemonVersion: health.daemon.version || null,
        platform: `${health.plugin.platform}/${health.plugin.arch}`,
        devices,
      },
    }
  }

  function diagnosticsText(health) {
    const lines = [
      '无线外设电量 · 诊断信息',
      `时间：${new Date().toLocaleString('zh-CN')}`,
      `插件版本：${health.plugin.version} · 平台：${health.plugin.platform}/${health.plugin.arch}`,
      `服务：${health.daemon.running ? '运行中' : '未运行'} · PID：${health.daemon.pid ?? '—'} · 版本：${health.daemon.version ?? '—'}`,
      `最近刷新：${health.lastPolledAt ? new Date(health.lastPolledAt).toLocaleString('zh-CN') : '未刷新'}`,
      `设备：${health.deviceCount} 台 · 适配器：${health.adapterCount} 个`,
      `设置：定时刷新=${settings.scheduled ? '开' : '关'} · 间隔=${settings.intervalMinutes} 分钟 · 通知=${settings.notify ? '开' : '关'} · 阈值=${settings.thresholdPercent}%`,
      `最后错误：${health.lastError || '无'}`,
      `daemon 错误：${health.daemon.error || '无'}`,
      '',
      '数据源：',
      ...sourceSummaryLines(health.sources),
      '',
      '设备列表：',
    ]
    const devices = registryList(currentRawDevices())
    if (devices.length === 0) lines.push('- （无）')
    for (const device of devices) {
      lines.push(`- ${device.name} · ${device.status || 'unknown'} · ${device.percent ?? '—'}% · ${device.key}`)
    }
    lines.push('', '适配器：')
    for (const adapter of adapterPublicList()) {
      lines.push(`- [${adapter.origin}/${adapter.tier || 'user'}] ${adapter.id} · ${adapter.name}`)
    }
    if (adapterState.errors.length > 0) {
      lines.push('', '适配器加载错误：')
      for (const error of adapterState.errors) lines.push(`- ${error.file}: ${error.message}`)
    }
    lines.push('', `设置目录：${SETTINGS_DIR}`, `用户适配器：${ADAPTER_DIR}`)
    const stderr = getDaemon().lastStderr?.trim()
    if (stderr) lines.push('', 'daemon stderr（末尾）：', stderr.slice(-1200))
    return lines.join('\n')
  }

  // daemon 的 HID 到达/移除事件：去抖 350 ms 后强制刷新一次。
  const daemon = getDaemon()
  daemon.onEvent = (event) => {
    if (event?.event !== 'devicesChanged') return
    if (deviceEventTimer) clearTimeout(deviceEventTimer)
    deviceEventTimer = setTimeout(() => {
      deviceEventTimer = null
      void poll(true)
    }, 350)
  }

  // ---- tools -------------------------------------------------------------

  const batteryStatusTool = {
    name: 'battery_status',
    description:
      '读取本机无线外设电量。默认返回缓存（毫秒级），带 name/displayName、kind、status、percent、charging、visible、order；' +
      'refresh=true 时强制刷新（约 1–1.5 秒，休眠设备可能无应答）。status：online/asleep/unplugged/error。' +
      '“asleep”是省电休眠，“unplugged”是已拔出（保留上次读数但不参与低电量判断）。',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: '可选：按设备名、key 或类型过滤（不区分大小写），例如 keyboard。',
        },
        refresh: {
          type: 'boolean',
          description: '强制刷新；默认 false 读缓存。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderStatusText(value) }],
    },
    async execute(args) {
      const refresh = args?.refresh === true
      let snapshot
      if (refresh || !state.snapshot) {
        snapshot = await poll(true)
      } else {
        snapshot = state.snapshot
        if (settings.scheduled && Date.now() - state.lastPolledAt > settings.intervalMinutes * 60_000) {
          void poll()
        }
      }
      if (!snapshot) throw new Error(state.error || '侧车没有返回数据（是否忘了构建 bin/peripheral-battery-cli.exe？）')
      const value = filterSnapshot(snapshot, args?.device)
      let hints = []
      try {
        const devices = parseCliJson(await runCli(['probe', 'list', '--json'])).devices
        const covered = new Set()
        for (const device of devices) {
          if (device.supported) covered.add(`${device.vid}:${device.pid}`)
        }
        for (const adapter of adapterState.adapters) {
          for (const vid of adapter.match.vids) {
            if (adapter.match.pids.length === 0) {
              for (const device of devices) {
                if (device.vid === vid) covered.add(`${device.vid}:${device.pid}`)
              }
              continue
            }
            for (const pid of adapter.match.pids) covered.add(`${vid}:${pid}`)
          }
        }
        const seen = new Set()
        for (const device of devices) {
          if (!device.vendorPage) continue
          const id = `${device.vid}:${device.pid}`
          if (covered.has(id) || seen.has(id)) continue
          const protocols = protocolsForDevice(device)
          if (protocols.length === 0) continue
          seen.add(id)
          hints.push({
            product: device.product || '(无产品名)',
            vid: device.vid,
            pid: device.pid,
            protocols: protocols.map((protocol) => protocol.name),
          })
        }
      } catch {
        // 提示是附加信息，失败不影响读数。
      }
      return {
        ...value,
        stale: state.error != null,
        pollError: state.error ?? null,
        refreshing: state.refreshing,
        hints,
      }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryStatusTool))

  const batteryProbeTool = {
    name: 'battery_probe',
    description:
      '列出本机所有 HID 集合（VID/PID、usage page、报文长度、产品名），并标注哪些已经被电量插件适配。' +
      '当用户问“为什么我的新鼠标不支持”或想为新设备写适配器时，用这个工具确认设备到底暴露了什么。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderProbeText(value) }],
    },
    async execute() {
      const result = await runCli(['probe', 'list', '--json'])
      const data = parseCliJson(result)
      const devices = data.devices.map((device) => {
        const adapter = adapterState.adapters.find((candidate) => adapterMatches(candidate, device))
        return adapter ? { ...device, supported: true, adapter: adapter.id } : device
      })
      return {
        ...data,
        devices,
        adapters: adapterPublicList(),
        adapterErrors: adapterState.errors,
        adapterDirectory: ADAPTER_DIR,
      }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryProbeTool))

  const batteryConfigTool = {
    name: 'battery_config',
    description:
      '读取或修改外设电量插件的设置：是否定时刷新、轮询间隔（分钟）、低电量阈值（%）、是否发系统通知、是否加载实验性适配器、适配器源 URL。' +
      '不带参数时只读取；带参数时保存并立即生效。',
    parameters: {
      type: 'object',
      properties: {
        scheduled: { type: 'boolean', description: '是否启用定时刷新。' },
        intervalMinutes: { type: 'number', description: '轮询间隔，1–1440 分钟。' },
        thresholdPercent: { type: 'number', description: '低电量阈值，1–99。' },
        notify: { type: 'boolean', description: '是否发送 Windows 系统通知。' },
        betaEnabled: { type: 'boolean', description: '是否加载实验性（beta）出厂适配器；关闭后只保留真机验证的 stable 适配器。' },
        marketUrl: { type: 'string', description: '适配器市场索引 URL（http(s) 或 file:）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderSettingsText(value) }],
    },
    async execute(args) {
      if (args && Object.keys(args).length > 0) {
        const previousBeta = settings.betaEnabled
        settings = saveSettings({ ...settings, ...args })
        adapterState.includeBeta = settings.betaEnabled !== false
        if (previousBeta !== settings.betaEnabled) {
          loadAdapters()
          await poll(true)
        }
        state.lastPolledAt = 0
      }
      return settings
    },
  }
  ctx.effect(() => ctx.tools.register(batteryConfigTool))

  const batteryAdaptersTool = {
    name: 'battery_adapters',
    description:
      '列出或重新加载 JS 电量适配器。出厂适配器随插件包更新，用户适配器放在 ' +
      '%LOCALAPPDATA%\\dsh-peripheral-battery\\adapters，两者分目录加载、互不影响。' +
      '用户适配器用 defineAdapter({ id, name, kind, match, read(io) }) 声明；' +
      '修改后 action=reload 生效，不用重启 DSH。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'reload'],
          description: 'list 只查看当前加载结果；reload 重新扫描适配器目录。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderAdaptersText(value) }],
    },
    async execute(args) {
      if (args?.action === 'reload') loadAdapters()
      return {
        adapterDirectory: ADAPTER_DIR,
        factoryDirectory: FACTORY_ADAPTER_DIR,
        loadedAt: adapterState.loadedAt,
        adapters: adapterPublicList(),
        errors: adapterState.errors,
      }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryAdaptersTool))

  const batteryBleTool = {
    name: 'battery_ble',
    description:
      '扫描或列出 Windows 蓝牙设备的电量：优先读 GATT Battery Service（0x180F/0x2A19），' +
      '读不到再看 Windows 蓝牙栈已知电量（覆盖经典蓝牙 HID）。' +
      'scan 会重新扫描（约 1–3 秒），list 只读缓存。没有蓝牙外设时返回空列表。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['scan', 'list'],
          description: 'scan = 重新扫描；list = 读缓存。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderBleText(value) }],
    },
    async execute(args) {
      if (args?.action === 'scan') await scanBle()
      return {
        scannedAtMs: bleState.scannedAt,
        devices: bleState.devices,
        raw: bleState.raw,
        error: bleState.error,
      }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryBleTool))

  const batteryDetectTool = {
    name: 'battery_detect',
    description:
      '当用户想添加一台新外设、但不知道 VID/PID 时用这个工具。' +
      'list 按产品名列出当前所有尚未适配的厂商 HID 设备（含 VID/PID、usage page、报文长度）；' +
      'watch 会先等用户把接收器插上/把设备打开（5–60 秒），再列出未适配设备。' +
      '普通用户只需要说“我新买了一个 XX”，不需要提供任何 ID。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['list', 'watch'],
          description: 'list = 立即列出；watch = 等用户插上设备后再列出。',
        },
        seconds: {
          type: 'number',
          description: 'watch 模式等待秒数，5–60，默认 20。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderDetectText(value) }],
    },
    async execute(args) {
      const mode = args?.mode === 'watch' ? 'watch' : 'list'
      const seconds = Math.min(Math.max(Math.round(Number(args?.seconds) || 20), 5), 60)
      return detectDevices(mode, seconds)
    },
  }
  ctx.effect(() => ctx.tools.register(batteryDetectTool))

  const batteryProtocolsTool = {
    name: 'battery_protocols',
    description:
      '把当前 HID 设备与内置协议目录匹配，返回已知协议（帧格式、解析规则、状态、来源）。' +
      '用户想适配新设备时先调这个：命中 verified/experimental 条目后，按目录写适配器，再用 battery_save_adapter 热加载。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderProtocolsText(value) }],
    },
    async execute() {
      const devices = parseCliJson(await runCli(['probe', 'list', '--json'])).devices
      const seen = new Set()
      const matches = []
      for (const device of devices) {
        const key = `${device.vid}:${device.pid}:${device.usagePage}:${device.inputLen}:${device.outputLen}:${device.featureLen}`
        if (seen.has(key)) continue
        seen.add(key)
        const protocols = protocolsForDevice(device)
        if (protocols.length === 0) continue
        const adapter = adapterState.adapters.find((candidate) => adapterMatches(candidate, device))
        matches.push({
          device: {
            vid: device.vid,
            pid: device.pid,
            usagePage: device.usagePage,
            usage: device.usage,
            inputLen: device.inputLen,
            outputLen: device.outputLen,
            featureLen: device.featureLen,
            product: device.product,
          },
          protocols: protocols.map(({ id, name, status, transport, frame, parse, notes, source }) => ({
            id,
            name,
            status,
            transport,
            frame,
            parse,
            notes,
            source,
            adapter: adapter ? adapter.id : null,
          })),
        })
      }
      return {
        catalog: PROTOCOLS.map(({ id, name, status, transport, source }) => ({
          id,
          name,
          status,
          transport,
          source,
        })),
        matches,
      }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryProtocolsTool))

  const batterySaveAdapterTool = {
    name: 'battery_save_adapter',
    description:
      '把 agent 生成的适配器源码写入用户适配器目录并热加载（语法检查 + defineAdapter 校验）。' +
      '出厂适配器文件名不可占用；用户适配器永远不会被插件更新覆盖。覆盖同名用户文件需要 overwrite: true。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '适配器文件名，如 my-mouse.js' },
        source: { type: 'string', description: '完整的 defineAdapter(...) 源码' },
        overwrite: { type: 'boolean', description: '允许覆盖同名文件' },
      },
      required: ['file', 'source'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderSaveAdapterText(value) }],
    },
    async execute(args) {
      const file = String(args?.file || '').trim()
      const source = String(args?.source || '')
      if (!/^[A-Za-z0-9._-]+\.js$/.test(file)) throw new Error('file 只能是适配器目录里的 .js 文件名')
      if (!source.includes('defineAdapter')) throw new Error('source 必须调用 defineAdapter(...)')
      if (source.length > 64 * 1024) throw new Error('source 超过 64 KiB')
      new vm.Script(source, { filename: file })
      if (existsSync(path.join(FACTORY_ADAPTER_DIR, file))) {
        throw new Error(`${file} 是出厂适配器文件名，请换一个名字（例如 my-${file}）`)
      }
      const target = path.join(ADAPTER_DIR, file)
      if (existsSync(target) && !args?.overwrite) {
        throw new Error(`${file} 已存在；覆盖请传 overwrite: true`)
      }
      mkdirSync(ADAPTER_DIR, { recursive: true })
      writeFileSync(target, source, 'utf8')
      loadAdapters()
      return { file, adapters: adapterPublicList(), errors: adapterState.errors }
    },
  }
  ctx.effect(() => ctx.tools.register(batterySaveAdapterTool))

  const batteryMarketTool = {
    name: 'battery_market',
    description:
      '从策展的静态索引搜索/安装社区适配器。搜索匹配索引名、设备型号或适配器 ID，不需要 VID/PID。' +
      '流程：search → preview 审阅源码 → install 且 confirm:true 才写入用户适配器目录。' +
      '安装会校验 SHA-256 以及源码 id/match 与索引一致，不会覆盖出厂适配器。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'preview', 'install', 'remove', 'list'],
          description: 'search 搜索、preview 预览源码、install 安装、remove 移除、list 查看已安装。',
        },
        query: { type: 'string', description: 'search 关键词：索引名、型号或适配器 ID。' },
        id: { type: 'string', description: '适配器 id（索引里的 id）。' },
        confirm: { type: 'boolean', description: 'install 时确认执行；缺省只返回预览。' },
        overwrite: { type: 'boolean', description: '允许覆盖同名用户适配器文件。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderMarketText(value) }],
    },
    async execute(args) {
      const action = String(args?.action || 'search')
      const url = settings.marketUrl
      if (action === 'search') {
        const index = await loadMarketIndex(url)
        return {
          ok: true,
          action,
          sourceUrl: index.sourceUrl || url,
          entries: marketSearch(index, args?.query),
          warnings: index.warnings,
        }
      }
      if (action === 'preview') {
        const preview = await marketPreview(String(args?.id || ''), url)
        return {
          ok: true,
          action,
          sourceUrl: url,
          entry: preview.entry,
          source: preview.source,
          sha256: preview.hash,
          requiresConfirmation: true,
        }
      }
      if (action === 'install') {
        const result = await marketInstall(String(args?.id || ''), url, {
          confirm: args?.confirm === true,
          overwrite: args?.overwrite === true,
        })
        return { ok: true, action, sourceUrl: url, ...result }
      }
      if (action === 'remove') {
        return { ok: true, action, ...marketRemove(String(args?.id || '')) }
      }
      if (action === 'list') {
        return { ok: true, action, installed: readMarketInstalled() }
      }
      throw new Error(`未知操作：${action}`)
    },
  }
  ctx.effect(() => ctx.tools.register(batteryMarketTool))

  const batteryExchangeTool = {
    name: 'battery_exchange',
    description:
      '对一台 HID 设备发送一帧原始报文并读回应答。用于“没有现成适配器”时让 agent 直接试探协议，' +
      '不需要写文件或调用 shell。先用 battery_protocols 查目录；目录没命中再用它从已知帧开始试。' +
      'mode：write=interrupt OUT，setout=HID SET_REPORT，setfeat/getfeat=Feature Report。',
    parameters: {
      type: 'object',
      properties: {
        vid: { type: 'string', description: '十六进制 VID，如 373B' },
        pid: { type: 'string', description: '十六进制 PID，如 1115' },
        usagePage: { type: 'string', description: '可选：usage page，如 FF02' },
        usage: { type: 'string', description: '可选：usage' },
        inLen: { type: 'number', description: '可选：输入报文长度过滤' },
        outLen: { type: 'number', description: '可选：输出报文长度过滤' },
        hex: { type: 'string', description: '要发送的报文，空格分隔十六进制，如 "08 04 ... 49"' },
        mode: {
          type: 'string',
          enum: ['write', 'setout', 'setfeat', 'getfeat'],
          description: '发送方式，默认 write',
        },
        wait: { type: 'number', description: '等应答毫秒数，默认 600' },
        reads: { type: 'number', description: '最多读几帧，默认 4' },
      },
      required: ['vid', 'pid', 'hex'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderExchangeText(value) }],
    },
    async execute(args) {
      const cli = [
        'probe',
        'exchange',
        '--json',
        '--vid',
        String(args.vid),
        '--pid',
        String(args.pid),
        '--hex',
        String(args.hex),
        '--mode',
        String(args.mode || 'write'),
        '--wait',
        String(Math.min(Number(args.wait) || 600, 10_000)),
        '--reads',
        String(Math.min(Number(args.reads) || 4, 32)),
      ]
      if (args.usagePage) cli.push('--usage-page', String(args.usagePage))
      if (args.usage) cli.push('--usage', String(args.usage))
      if (args.inLen != null) cli.push('--in-len', String(args.inLen))
      if (args.outLen != null) cli.push('--out-len', String(args.outLen))
      return parseCliJson(await runCli(cli))
    },
  }
  ctx.effect(() => ctx.tools.register(batteryExchangeTool))

  const batteryListenTool = {
    name: 'battery_listen',
    description:
      '只读监听一台 HID 设备在指定时间内主动上报的报文。给“输入上报型”协议（雷柏、DualSense 等）逆向用：' +
      '让用户动一下设备/按下按键，再调它抓取原始帧。',
    parameters: {
      type: 'object',
      properties: {
        vid: { type: 'string', description: '十六进制 VID' },
        pid: { type: 'string', description: '十六进制 PID' },
        usagePage: { type: 'string', description: '可选：只看某个 usage page 的集合' },
        seconds: { type: 'number', description: '监听秒数，1–30，默认 5' },
      },
      required: ['vid', 'pid'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderListenText(value) }],
    },
    async execute(args) {
      const seconds = Math.min(Math.max(Math.round(Number(args.seconds) || 5), 1), 30)
      const cli = [
        'probe',
        'listen',
        '--vid',
        String(args.vid),
        '--pid',
        String(args.pid),
        '--secs',
        String(seconds),
      ]
      if (args.usagePage) cli.push('--usage-page', String(args.usagePage))
      return parseCliJson(await runCli(cli))
    },
  }
  ctx.effect(() => ctx.tools.register(batteryListenTool))

  const batteryDevicesTool = {
    name: 'battery_devices',
    description:
      '管理设备列表：list 查看所有已知设备（含隐藏/已拔出），show/hide 控制底栏是否显示，' +
      'rename 改自定义名（1–40 字符），resetName 恢复默认名，move 上移/下移，remove 移除记录。' +
      '改名只影响显示名，底层 name/key 不变。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'hide', 'rename', 'resetName', 'move', 'moveTo', 'remove'],
          description: '要执行的操作；省略或 list 只查看。',
        },
        key: { type: 'string', description: '设备 key（list 结果里的 key）' },
        name: { type: 'string', description: 'rename 使用的新名称' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'move 的方向' },
        index: { type: 'number', description: 'moveTo 的目标位置（0 起）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderDevicesText(value) }],
    },
    async execute(args) {
      if (!args?.action || args.action === 'list') {
        return { devices: registryList(currentRawDevices()), settings }
      }
      const devices = deviceAction(args)
      return { devices, settings }
    },
  }
  ctx.effect(() => ctx.tools.register(batteryDevicesTool))

  // ---- HTTP routes（Client 底栏与设置面板用） ------------------------------

  const requestRejection = (request) => {
    try {
      const connection = ctx.get('connection')
      if (!connection) return 401
      return connection.requestRejection(request) || null
    } catch {
      return 401
    }
  }

  // 所有插件 Web 路由都走 DSH 的 Host/Origin + 浏览器凭据检查。
  const secureRoute = (route) => {
    if (typeof route.handler === 'function') {
      return {
        ...route,
        handler: async (request, response) => {
          const rejection = requestRejection(request)
          if (rejection) {
            sendJson(response, rejection, {
              ok: false,
              error: { message: '未认证或来源不受信任' },
            })
            return
          }
          state.clientSeenAt = Date.now()
          scheduleAsleepRetry(state.snapshot)
          return route.handler(request, response)
        },
      }
    }
    if (typeof route.resource === 'function') {
      return {
        ...route,
        resource: async (request, peer) => {
          const rejection = requestRejection(request)
          if (rejection) {
            return new Response(
              JSON.stringify({ ok: false, error: { message: '未认证或来源不受信任' } }),
              {
                status: rejection,
                headers: { 'content-type': 'application/json; charset=utf-8' },
              },
            )
          }
          state.clientSeenAt = Date.now()
          scheduleAsleepRetry(state.snapshot)
          return route.resource(request, peer)
        },
      }
    }
    return route
  }

  const statusRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/status',
    resource: async () =>
      new Response(JSON.stringify(statusPayload()), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      }),
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(statusRoute)))

  // 极轻量版本号：Client 每 2 秒对一次，变了才拉完整状态。
  const revRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/rev',
    resource: async () =>
      new Response(JSON.stringify({ ok: true, rev: state.rev, refreshing: state.refreshing }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      }),
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(revRoute)))

  // 长轮询：有变化立即返回，没变化最多挂 25 秒（客户端随即重连）。
  const nextRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/next',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
        return
      }
      let since = -1
      try {
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        since = Number(url.searchParams.get('since') ?? '-1')
      } catch {
        since = -1
      }
      if (!Number.isFinite(since)) since = -1
      if (state.rev !== since) {
        sendJson(response, 200, { ok: true, rev: state.rev })
        return
      }
      await new Promise((resolve) => {
        let settled = false
        const finish = (payload) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          waiters.delete(wake)
          if (!response.writableEnded) sendJson(response, 200, payload)
          resolve()
        }
        const timer = setTimeout(() => finish({ ok: true, rev: state.rev, timeout: true }), 25_000)
        const wake = () => finish({ ok: true, rev: state.rev })
        waiters.add(wake)
        request.once('close', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          waiters.delete(wake)
          resolve()
        })
      })
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(nextRoute)))

  const settingsRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/settings',
    handler: async (request, response) => {
      try {
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, settings })
          return
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET / POST' } })
          return
        }
        const patch = JSON.parse((await readBody(request)) || '{}')
        const previousBeta = settings.betaEnabled
        settings = saveSettings({ ...settings, ...patch })
        adapterState.includeBeta = settings.betaEnabled !== false
        if (previousBeta !== settings.betaEnabled) {
          loadAdapters()
          await poll(true)
        }
        state.lastPolledAt = 0
        sendJson(response, 200, { ok: true, settings })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(settingsRoute)))

  const devicesRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/devices',
    handler: async (request, response) => {
      try {
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, devices: registryList(currentRawDevices()), settings })
          return
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET / POST' } })
          return
        }
        const payload = JSON.parse((await readBody(request)) || '{}')
        const devices = deviceAction(payload)
        sendJson(response, 200, { ok: true, devices, settings })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(devicesRoute)))

  const refreshRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/refresh',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 POST' } })
          return
        }
        await poll(true)
        sendJson(response, 200, statusPayload())
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(refreshRoute)))

  const healthRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/health',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        sendJson(response, 200, await healthPayload())
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(healthRoute)))

  const restartRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/restart',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 POST' } })
          return
        }
        await getDaemon().restart()
        state.daemonVersion = ''
        state.lastPolledAt = 0
        await poll(true)
        sendJson(response, 200, await healthPayload())
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(restartRoute)))

  const diagnosticsRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/diagnostics',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        const health = await healthPayload()
        sendJson(response, 200, {
          ok: true,
          text: diagnosticsText(health),
          health,
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(diagnosticsRoute)))

  const detectRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/detect',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET' && request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET / POST' } })
          return
        }
        const result = await detectDevices('list', 0)
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(detectRoute)))

  const testNotificationRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/test-notification',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 POST' } })
          return
        }
        toast('外设电量测试通知', '如果你看到这条通知，低电量提醒已生效。', { force: true })
        sendJson(response, 200, { ok: true, message: '已发送测试通知' })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(testNotificationRoute)))

  const marketSearchRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/search',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        const query = url.searchParams.get('query') || ''
        const index = await loadMarketIndex(
          settings.marketUrl,
          url.searchParams.get('refresh') === '1',
        )
        sendJson(response, 200, {
          ok: true,
          sourceUrl: index.sourceUrl || settings.marketUrl,
          entries: marketSearch(index, query),
          warnings: index.warnings,
        })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketSearchRoute)))

  const marketMatchRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/match',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        const vid = String(url.searchParams.get('vid') || '').trim().toUpperCase()
        const pid = String(url.searchParams.get('pid') || '').trim().toUpperCase()
        if (!/^[0-9A-F]{1,8}$/.test(vid) || !/^[0-9A-F]{1,8}$/.test(pid)) {
          throw new Error('需要合法的 vid / pid')
        }
        const device = {
          vid,
          pid,
          usagePage: String(url.searchParams.get('usagePage') || '').trim().toUpperCase() || undefined,
          usage: String(url.searchParams.get('usage') || '').trim().toUpperCase() || undefined,
          inLen: url.searchParams.get('inLen') ? Number(url.searchParams.get('inLen')) : undefined,
          outLen: url.searchParams.get('outLen') ? Number(url.searchParams.get('outLen')) : undefined,
          featureLen: url.searchParams.get('featureLen')
            ? Number(url.searchParams.get('featureLen'))
            : undefined,
        }
        const index = await loadMarketIndex(
          settings.marketUrl,
          url.searchParams.get('refresh') === '1',
        )
        sendJson(response, 200, {
          ok: true,
          sourceUrl: index.sourceUrl || settings.marketUrl,
          entries: marketMatch(index, device),
          warnings: index.warnings,
        })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketMatchRoute)))

  const marketReportRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/report',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        const result = await verificationReport(url.searchParams.get('id') || '')
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketReportRoute)))

  const marketPreviewRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/preview',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 GET' } })
          return
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        const id = url.searchParams.get('id') || ''
        const preview = await marketPreview(id, settings.marketUrl)
        const builtIn = adapterState.factoryIds.has(id)
        const installed = Boolean(readMarketInstalled()[id])
        sendJson(response, 200, {
          ok: true,
          entry: { ...preview.entry, builtIn, installed },
          source: preview.source,
          sha256: preview.hash,
        })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketPreviewRoute)))

  const marketInstallRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/install',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 POST' } })
          return
        }
        const payload = JSON.parse((await readBody(request)) || '{}')
        const result = await marketInstall(String(payload.id || ''), settings.marketUrl, {
          confirm: payload.confirm === true,
          overwrite: payload.overwrite === true,
        })
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketInstallRoute)))

  const marketRemoveRoute = {
    kind: 'exact',
    path: '/peripheral-battery/v1/market/remove',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { message: '只支持 POST' } })
          return
        }
        const payload = JSON.parse((await readBody(request)) || '{}')
        const result = marketRemove(String(payload.id || ''))
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(secureRoute(marketRemoveRoute)))

  // ---- 后台轮询 -----------------------------------------------------------
  // 每 30 秒醒来一次，只有到了真正的间隔才真的去问设备：改间隔不需要重建定时器。
  const tick = () => {
    if (!settings.scheduled) return
    if (Date.now() - state.lastPolledAt >= settings.intervalMinutes * 60_000) {
      void poll()
    }
  }
  timerDispose = ctx.timer.interval(tick, 30_000)
  ctx.effect(() => () => {
    clearAsleepRetry()
    timerDispose?.()
    timerDispose = null
  })

  // 页面仍在轮询时保持 daemon 常驻；页面关闭后 lastPolledAt 不再更新，daemon 按空闲超时退出。
  const keepalive = setInterval(() => {
    if (!state.lastPolledAt || Date.now() - state.lastPolledAt > 15 * 60_000) return
    void getDaemon()
      .request('ping', {})
      .then((pong) => {
        if (pong?.version) state.daemonVersion = pong.version
      })
      .catch(() => {})
  }, 10 * 60_000)
  ctx.effect(() => () => clearInterval(keepalive))

  void poll(true)
}

