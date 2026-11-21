// 数据源账本：统一每个源的「是否执行、数量、为什么为空」。
// 只做纯数据整理，不读文件、不访问 daemon，便于单测。

const DEFAULTS = {
  xinput: { count: 0, error: null },
  generic: { enumerated: 0, matched: 0, error: null },
  ble: {
    gatt: 0,
    windows: 0,
    fastpair: 0,
    fastpairAdvertisements: 0,
    fastpairError: null,
    count: 0,
    error: null,
  },
  phonelink: { fileFound: false, ageSecs: null, count: 0, error: null },
}

export const SOURCE_NAMES = Object.keys(DEFAULTS)

export function createSourceLedger(initial = {}) {
  const entries = {}
  for (const name of SOURCE_NAMES) {
    entries[name] = { ...DEFAULTS[name], ...(initial[name] || {}) }
  }
  return {
    set(name, value) {
      if (!Object.hasOwn(entries, name)) return
      entries[name] = { ...DEFAULTS[name], ...(value || {}) }
    },
    get(name) {
      return entries[name] ? { ...entries[name] } : null
    },
    toJSON() {
      return Object.fromEntries(SOURCE_NAMES.map((name) => [name, { ...entries[name] }]))
    },
  }
}

function errorSuffix(error) {
  return error ? ` · ${error}` : ''
}

/** 生成诊断文本的一段；HTTP/UI/报告共享同一份文案。 */
export function sourceSummaryLines(sources = {}) {
  const xinput = sources.xinput || DEFAULTS.xinput
  const generic = sources.generic || DEFAULTS.generic
  const ble = sources.ble || DEFAULTS.ble
  const phonelink = sources.phonelink || DEFAULTS.phonelink
  return [
    `- XInput：${xinput.count ?? 0} 台${errorSuffix(xinput.error)}`,
    `- 通用 HID Battery：${generic.matched ?? 0} 台匹配 / ${generic.enumerated ?? 0} 个集合${errorSuffix(generic.error)}`,
    `- BLE：GATT ${ble.gatt ?? 0} · Windows ${ble.windows ?? 0} · Fast Pair ${ble.fastpair ?? 0}（广告 ${ble.fastpairAdvertisements ?? 0}）${errorSuffix(ble.error || ble.fastpairError)}`,
    `- Phone Link：${
      phonelink.fileFound
        ? `已找到卡片（${Math.round((phonelink.ageSecs ?? 0) / 60)} 分钟前）`
        : '未找到卡片'
    }${errorSuffix(phonelink.error)}`,
  ]
}
