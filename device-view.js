// 设备视图：把「原始读数 + 注册表 + 上次读数」合成稳定快照。
// 纯函数模块，不读写文件，也不发布事件；Host 只负责持有 registry/lastReadings。

export function buildDeviceView(rawDevices, { registry, lastReadings, displayNameOf, base = {} }) {
  const current = new Map(rawDevices.map((device) => [device.key, device]))
  const merged = []

  for (const entry of [...registry.values()].sort((left, right) => left.order - right.order)) {
    if (!entry.visible) continue
    const device = current.get(entry.key)
    const last = lastReadings.get(entry.key)
    if (device) {
      const status = device.status === 'missing' ? 'unplugged' : device.status
      merged.push({
        ...device,
        status,
        name: displayNameOf(entry, device),
        defaultName: device.name,
        displayName: displayNameOf(entry, device),
        visible: true,
        order: entry.order,
        nameSource: entry.customName ? 'custom' : 'default',
        percent:
          device.percent ??
          (status === 'asleep' || status === 'unplugged' ? (last?.percent ?? null) : null),
        stale: status !== 'online' && last != null,
      })
      continue
    }
    merged.push({
      key: entry.key,
      name: displayNameOf(entry, null),
      displayName: displayNameOf(entry, null),
      defaultName: entry.name,
      kind: entry.kind,
      transport: entry.transport,
      status: 'unplugged',
      percent: last?.percent ?? null,
      charging: last?.charging ?? null,
      updatedAt: null,
      source: 'registry',
      visible: true,
      order: entry.order,
      nameSource: entry.customName ? 'custom' : 'default',
      stale: last != null,
    })
  }

  return {
    ...base,
    devices: merged,
    onlineCount: merged.filter((device) => device.status === 'online').length,
  }
}

export function listDeviceRegistry(currentDevices, { registry, lastReadings, displayNameOf }) {
  const current = new Map((currentDevices || []).map((device) => [device.key, device]))
  return [...registry.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => {
      const device = current.get(entry.key)
      const last = lastReadings.get(entry.key)
      return {
        key: entry.key,
        name: displayNameOf(entry, device),
        displayName: displayNameOf(entry, device),
        defaultName: device?.defaultName || device?.name || entry.name,
        kind: device?.kind || entry.kind,
        transport: device?.transport || entry.transport,
        visible: entry.visible,
        order: entry.order,
        customName: entry.customName,
        nameSource: entry.customName ? 'custom' : 'default',
        status: device ? (device.status === 'missing' ? 'unplugged' : device.status) : 'unplugged',
        percent: device?.percent ?? last?.percent ?? null,
        charging: device?.charging ?? last?.charging ?? null,
        detail: device?.detail || null,
        components: Array.isArray(device?.components) ? device.components : [],
      }
    })
}

export function normalizeDeviceName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!text) throw new Error('名称不能为空')
  if ([...text].length > 40) throw new Error('名称最多 40 个字符')
  return text
}
