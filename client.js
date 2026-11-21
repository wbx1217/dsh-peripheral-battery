/**
 * Client 半：`shell.bottom` 里一行设备电量摘要。
 *
 * 数据来自 Host 注册的 `/peripheral-battery/status`（同源 fetch），
 * 30 秒刷新一次；Host 自己按用户设置的间隔去问侧车，底栏只读缓存。
 */

window.__ModuleLoader__.load({
  id: 'dsh-peripheral-battery',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = (() => {
      try {
        if (location.protocol !== 'file:') return ''
        const transport = window.__DSH_TRANSPORT__
        return transport?.streamBaseUrl || transport?.baseUrl || ''
      } catch {
        return ''
      }
    })()

    const STATUS_URL = `${BASE}/peripheral-battery/v1/status`
    const SETTINGS_URL = `${BASE}/peripheral-battery/v1/settings`
    const DEVICES_URL = `${BASE}/peripheral-battery/v1/devices`
    const REFRESH_URL = `${BASE}/peripheral-battery/v1/refresh`
    const NEXT_URL = `${BASE}/peripheral-battery/v1/next`
    const HEALTH_URL = `${BASE}/peripheral-battery/v1/health`
    const RESTART_URL = `${BASE}/peripheral-battery/v1/restart`
    const DIAGNOSTICS_URL = `${BASE}/peripheral-battery/v1/diagnostics`
    const DETECT_URL = `${BASE}/peripheral-battery/v1/detect`
    const TEST_NOTIFICATION_URL = `${BASE}/peripheral-battery/v1/test-notification`
    const MARKET_SEARCH_URL = `${BASE}/peripheral-battery/v1/market/search`
    const MARKET_PREVIEW_URL = `${BASE}/peripheral-battery/v1/market/preview`
    const MARKET_MATCH_URL = `${BASE}/peripheral-battery/v1/market/match`
    const MARKET_REPORT_URL = `${BASE}/peripheral-battery/v1/market/report`
    const MARKET_INSTALL_URL = `${BASE}/peripheral-battery/v1/market/install`
    const MARKET_REMOVE_URL = `${BASE}/peripheral-battery/v1/market/remove`
    const MARKET_CACHE_MS = 5 * 60 * 1000
    let marketCache = { entries: null, warnings: [], sourceUrl: '', fetchedAt: 0 }

    function colorFor(device) {
      if (device.status !== 'online' || device.percent == null) {
        return 'var(--dsw-alias-state-idle-primary)'
      }
      // 常用电量色：红 / 橙 / 绿（绿沿用主题成功色）。
      if (device.percent <= 20) return '#ff4d4f'
      if (device.percent <= 50) return '#fa8c16'
      return 'var(--dsw-alias-state-success-primary)'
    }

    function valueFor(device) {
      if (device.status === 'online') {
        if (device.percent == null) return '电量未知'
        return device.charging === true ? `${device.percent}% ⚡` : `${device.percent}%`
      }
      if (device.status === 'unplugged' || device.status === 'missing') {
        return device.percent != null ? `已拔出 · 上次 ${device.percent}%` : '已拔出'
      }
      if (device.status === 'asleep') {
        return device.percent != null ? `休眠 · 上次 ${device.percent}%` : '休眠'
      }
      return '读取失败'
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 16px',
      minHeight: 34,
      boxSizing: 'border-box',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: 1.5,
      overflow: 'hidden',
    }

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
    }

    const nameStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      maxWidth: 200,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const inputStyle = {
      width: 62,
      padding: '2px 6px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
    }

    const buttonStyle = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      fontSize: 12,
      padding: '2px 6px',
      borderRadius: 6,
    }

    function Toggle({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          onClick: () => onChange(!checked),
          style: {
            width: 28,
            height: 16,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            position: 'relative',
            cursor: 'pointer',
            flex: '0 0 auto',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
            transition: 'background .15s ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 3,
            left: checked ? 15 : 3,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .15s ease',
            boxShadow: '0 1px 2px rgba(0,0,0,.2)',
          },
        }),
      )
    }

    function SettingsPanel({ draft, onChange }) {
      const numberStyle = {
        width: 42,
        height: 20,
        padding: '0 3px',
        boxSizing: 'border-box',
        textAlign: 'center',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
      }
      const suffixStyle = {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        whiteSpace: 'nowrap',
        width: 22,
        textAlign: 'left',
      }
      const pair = (label, control) =>
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '80px auto',
              alignItems: 'center',
              gap: 12,
              minWidth: 0,
            },
          },
          h(
            'span',
            { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 500 } },
            label,
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
              },
            },
            ...(Array.isArray(control) ? control : [control]),
          ),
        )
      const row = (left, right, first) =>
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              columnGap: 24,
              alignItems: 'center',
              padding: '8px 0',
              borderTop: first ? 'none' : '1px solid var(--dsw-alias-border-l1)',
            },
          },
          left,
          right,
        )

      return h(
        'div',
        {
          style: {
            width: '100%',
          },
        },
        h(
          'style',
          null,
          [
            '.pb-number { appearance: textfield; -moz-appearance: textfield; }',
            '.pb-number::-webkit-inner-spin-button, .pb-number::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }',
          ].join('\n'),
        ),
        row(
          pair(
            '定时刷新',
            h(Toggle, {
              checked: Boolean(draft.scheduled),
              onChange: (value) => onChange({ scheduled: value }),
              label: '定时刷新',
            }),
          ),
          pair('轮询间隔', [
            h('input', {
              className: 'pb-number',
              style: numberStyle,
              type: 'number',
              min: 1,
              max: 1440,
              value: draft.intervalMinutes,
              onChange: (event) => onChange({ intervalMinutes: event.target.value }),
            }),
            h('span', { style: suffixStyle }, '分钟'),
          ]),
          true,
        ),
        row(
          pair(
            '系统通知',
            h(Toggle, {
              checked: Boolean(draft.notify),
              onChange: (value) => onChange({ notify: value }),
              label: '系统通知',
            }),
          ),
          pair('低电量阈值', [
            h('input', {
              className: 'pb-number',
              style: numberStyle,
              type: 'number',
              min: 1,
              max: 99,
              value: draft.thresholdPercent,
              onChange: (event) => onChange({ thresholdPercent: event.target.value }),
            }),
            h('span', { style: suffixStyle }, '%'),
          ]),
        ),
        row(
          pair(
            '实验性适配器',
            h(Toggle, {
              checked: draft.betaEnabled !== false,
              onChange: (value) => onChange({ betaEnabled: value }),
              label: '实验性适配器',
            }),
          ),
          pair(
            '加载范围',
            h(
              'span',
              { style: { fontSize: 11, opacity: 0.6 } },
              draft.betaEnabled === false ? '仅 stable（真机验证）' : '包含 beta（未真机验证）',
            ),
          ),
        ),
        draft.notify && !draft.scheduled
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 0 2px',
                  color: 'var(--dsw-alias-state-warning-primary)',
                  fontSize: 11,
                },
              },
              h('span', null, '通知已开启，但定时刷新关闭：只有手动刷新或设备插拔时才会检查低电量。'),
              h(
                'button',
                { style: buttonStyle, onClick: () => onChange({ scheduled: true }) },
                '开启后台检查',
              ),
            )
          : null,
      )
    }

    let rootCtx = null

    function openPeripheralSettings() {
      const dialogSelector = '[data-shortcut-modal="settings"]'
      const clickSection = () => {
        const dialog = document.querySelector(dialogSelector)
        if (!dialog) return false
        const nav = [...dialog.querySelectorAll('nav button')].find(
          (button) => (button.textContent || '').trim() === '外设电量',
        )
        if (!nav) return false
        nav.click()
        return true
      }
      const invokeShortcut = () => {
        try {
          const shortcuts = rootCtx?.get?.('shortcuts')
          const registry = shortcuts?.registry
          if (!registry || typeof registry.invoke !== 'function') return false
          registry.invoke('settings.open', { region: 'page', modal: null, target: null })
          return true
        } catch {
          return false
        }
      }
      const openDirect = () => {
        try {
          const entries = rootCtx?.slots?.entries?.('sidebar.settings') || []
          for (const entry of entries) {
            const stores = [entry?.options?.store, entry?.store, entry?.registration?.options?.store]
            for (const store of stores) {
              if (!store) continue
              let instance
              try {
                instance = store.create?.()
              } catch {
                instance = undefined
              }
              for (const candidate of [instance, store]) {
                const actions = candidate?.actions
                const openSection = actions?.openSection || candidate?.openSection
                if (typeof openSection === 'function') {
                  openSection.call(actions || candidate, 'peripheral-battery')
                  return true
                }
              }
            }
          }
        } catch {
          // 继续尝试 fiber。
        }

        try {
          const triggers = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
            .filter((button) => button.getClientRects().length > 0)
            .slice(0, 4)
          for (const trigger of triggers) {
            const fiberKey = Object.keys(trigger).find((key) => key.startsWith('__reactFiber$'))
            let fiber = fiberKey ? trigger[fiberKey] : null
            for (let depth = 0; fiber && depth < 20; depth += 1) {
              const props = fiber.memoizedProps
              if (props && typeof props.openSettings === 'function') {
                props.openSettings('peripheral-battery')
                return true
              }
              fiber = fiber.return
            }
          }
        } catch {
          // ignore
        }
        return false
      }
      const waitFor = (check, timeout) =>
        new Promise((resolve) => {
          const deadline = Date.now() + timeout
          const tick = () => {
            const value = check()
            if (value) return resolve(value)
            if (Date.now() >= deadline) return resolve(false)
            setTimeout(tick, 50)
          }
          tick()
        })
      const warn = (message) => {
        try {
          console.warn(`[peripheral-battery] ${message}`)
        } catch {
          // ignore
        }
      }

      void (async () => {
        if (clickSection()) return
        if (document.querySelector(dialogSelector)) return

        // 1) 直接拿设置壳 store 的 openSection，一步打开目标 section。
        if (openDirect()) {
          if (await waitFor(() => document.querySelector(dialogSelector), 400)) {
            if (!clickSection()) warn('设置已打开，但没找到「外设电量」导航项')
            return
          }
        }

        // 2) 直接调用快捷键服务已注册的 settings.open（桌面快捷键走原生桥，
        // 合成 DOM 键盘事件不会触发它）。
        if (invokeShortcut()) {
          if (await waitFor(() => document.querySelector(dialogSelector), 600)) {
            if (!clickSection()) warn('设置已打开，但没找到「外设电量」导航项')
            return
          }
        }

        // 3) 设置快捷键（桌面 Ctrl+, / Web Ctrl+Alt+,）。
        const mac = /mac/i.test(navigator.userAgent)
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ',',
            code: 'Comma',
            ctrlKey: !mac,
            metaKey: mac,
            altKey: false,
            bubbles: true,
            cancelable: true,
          }),
        )
        const opened = await waitFor(() => document.querySelector(dialogSelector), 600)
        if (opened) {
          if (!clickSection()) warn('设置已打开，但没找到「外设电量」导航项')
          return
        }

        // 2) 账户菜单里的「设置」项（可能有多个菜单按钮，逐个试）。
        const candidates = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
          .filter((button) => button.getClientRects().length > 0)
          .slice(0, 4)
        for (const menuButton of candidates) {
          menuButton.click()
          const item = await waitFor(
            () =>
              [...document.querySelectorAll('[role="menuitem"]')].find((element) =>
                /^(设置|Settings|設定|Einstellungen|Paramètres|Configuración|Configurações|Настройки)$/.test(
                  (element.textContent || '').trim(),
                ),
              ),
            400,
          )
          if (!item) {
            menuButton.click()
            continue
          }
          item.click()
          if (await waitFor(() => document.querySelector(dialogSelector), 800)) clickSection()
          return
        }
        warn('没找到设置入口（快捷键与账户菜单都不可用）')
      })()
    }

    function BottomBar() {
      const [payload, setPayload] = React.useState(null)
      const [fetchError, setFetchError] = React.useState(null)
      const [refreshingLocal, setRefreshingLocal] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          if (!response.ok) {
            throw new Error(
              response.status === 404
                ? '插件服务未就绪（404），可能正在重载'
                : `HTTP ${response.status}`,
            )
          }
          const json = await response.json()
          setPayload(json)
          setFetchError(null)
        } catch (error) {
          setFetchError(String(error?.message ?? error))
        }
      }, [])

      React.useEffect(() => {
        const onDevicesChanged = () => void refresh()
        window.addEventListener('peripheral-battery:devices-changed', onDevicesChanged)
        return () => window.removeEventListener('peripheral-battery:devices-changed', onDevicesChanged)
      }, [refresh])

      // 长轮询：没有变化时请求挂起，有变化宿主立即返回；不再按固定间隔轮询。
      const sinceRef = React.useRef(-1)
      React.useEffect(() => {
        let stopped = false
        const controller = new AbortController()
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const run = async () => {
          // 页面打开时手动刷新一次，确保看到的是设备当前状态；
          // 之后完全由长轮询推送，不再按固定间隔轮询。
          try {
            await fetch(REFRESH_URL, { method: 'POST' })
          } catch {
            // 首次刷新失败时仍进入长轮询，后续事件/手动刷新会补上。
          }
          await refresh()
          while (!stopped) {
            try {
              const response = await fetch(`${NEXT_URL}?since=${sinceRef.current}`, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
              })
              if (!response.ok) {
                await refresh()
                await sleep(2_000)
                continue
              }
              const json = await response.json()
              if (stopped) return
              if (typeof json.rev === 'number') sinceRef.current = json.rev
              if (json.timeout) continue
              await refresh()
            } catch {
              if (stopped) return
              await sleep(2_000)
            }
          }
        }
        void run()
        return () => {
          stopped = true
          controller.abort()
        }
      }, [refresh])

      async function refreshNow() {
        setRefreshingLocal(true)
        try {
          const response = await fetch(REFRESH_URL, { method: 'POST' })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setPayload(json)
        } catch (error) {
          setFetchError(String(error?.message ?? error))
        } finally {
          setRefreshingLocal(false)
        }
      }

      const snapshot = payload?.snapshot
      const devices = snapshot?.devices || []
      const error = fetchError || payload?.error
      const onboarding = payload?.settings?.onboardingDone === false
      const shownDevices = devices.slice(0, 3)
      const hiddenCount = Math.max(0, devices.length - shownDevices.length)

      React.useEffect(() => {
        if (!onboarding) return
        let alreadyOpened = false
        try {
          alreadyOpened = sessionStorage.getItem('pb-onboarding-opened') === '1'
        } catch {
          // ignore
        }
        if (alreadyOpened) return
        try {
          sessionStorage.setItem('pb-onboarding-opened', '1')
        } catch {
          // ignore
        }
        const timer = setTimeout(() => {
          if (!document.querySelector('[data-shortcut-modal="settings"]')) {
            openPeripheralSettings()
          }
        }, 800)
        return () => clearTimeout(timer)
      }, [onboarding])

      const chips = shownDevices.map((device) => {
        const color = colorFor(device)
        return h(
          'span',
          {
            key: device.key,
            style: chipStyle,
            title: device.detail || device.transport || device.name,
          },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color,
              flex: '0 0 auto',
            },
          }),
          h('span', { style: nameStyle }, device.name),
          h(
            'span',
            { style: { color, fontWeight: 600, whiteSpace: 'nowrap' } },
            valueFor(device),
          ),
        )
      })

      if (hiddenCount > 0) {
        chips.push(
          h(
            'button',
            {
              key: 'more',
              className: 'pb-bar-action',
              title: `还有 ${hiddenCount} 台设备`,
              onClick: openPeripheralSettings,
            },
            `+${hiddenCount}`,
          ),
        )
      }

      if (onboarding && devices.length > 0) {
        chips.push(
          h(
            'button',
            {
              key: 'onboarding',
              className: 'pb-bar-action',
              onClick: openPeripheralSettings,
            },
            '完成首次设置',
          ),
        )
      }

      if (chips.length === 0) {
        chips.push(
          error
            ? h(
                'button',
                {
                  key: 'empty',
                  className: 'pb-bar-action',
                  style: { color: 'var(--dsw-alias-state-error-primary)' },
                  onClick: openPeripheralSettings,
                },
                `电量服务错误：${error} · 详情`,
              )
            : snapshot
              ? h(
                  'button',
                  {
                    key: 'empty',
                    className: 'pb-bar-action',
                    onClick: openPeripheralSettings,
                  },
                  payload?.devices?.length > 0
                    ? '设备已全部隐藏 · 去设置'
                    : '未发现无线外设 · 去设置',
                )
              : h(
                  'span',
                  { key: 'empty', style: { color: 'var(--dsw-alias-label-secondary)' } },
                  '正在读取外设电量…',
                ),
        )
      } else if (error) {
        chips.push(
          h(
            'button',
            {
              key: 'error',
              className: 'pb-bar-action',
              style: {
                color: 'var(--dsw-alias-state-error-primary)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              onClick: openPeripheralSettings,
            },
            `电量服务错误：${error} · 详情`,
          ),
        )
      }

      const refreshing = refreshingLocal || Boolean(payload?.refreshing)

      return h(
        'div',
        { style: { background: 'var(--dsw-alias-bg-base)' } },
        h(
          'style',
          null,
          [
            '.pb-title { transition: opacity .15s ease; }',
            '.pb-title:hover { opacity: .75; }',
            '.pb-bar-action { border:none; background:transparent; color:var(--dsw-alias-brand-primary); cursor:pointer; font-size:11px; padding:0 2px; white-space:nowrap; }',
            '.pb-bar-action:hover { text-decoration:underline; }',
            '.pb-refresh { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border:none; border-radius:5px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; transition: background .15s ease, color .15s ease, transform .12s ease; }',
            '.pb-refresh:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }',
            '.pb-refresh:active:not(:disabled) { transform: scale(.9); }',
            '.pb-refresh:disabled { cursor: default; opacity:.45; }',
            '.pb-refresh[data-busy="true"] svg { animation: pb-spin .9s linear infinite; }',
            '.pb-refresh svg { display:block; transform-origin:center; }',
            '@keyframes pb-spin { to { transform: rotate(360deg); } }',
          ].join('\n'),
        ),
        h(
          'div',
          { style: rowStyle },
          h(
            'button',
            {
              className: 'pb-title',
              style: {
                border: 'none',
                background: 'transparent',
                padding: 0,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--dsw-alias-label-primary)',
                fontWeight: 600,
                fontSize: 'inherit',
                lineHeight: '18px',
                cursor: 'pointer',
                flex: '0 0 auto',
              },
              onClick: openPeripheralSettings,
              title: '打开设置 · 外设电量',
            },
            '外设电量',
          ),
          h(
            'button',
            {
              className: 'pb-refresh',
              'data-busy': refreshing ? 'true' : 'false',
              style: { flex: '0 0 auto' },
              onClick: refreshNow,
              disabled: refreshing,
              title: '刷新外设电量',
              'aria-label': '刷新外设电量',
            },
            h(
              'svg',
              {
                width: 13,
                height: 13,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 2.3,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': 'true',
              },
              h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
              h('path', { d: 'M21 3v5h-5' }),
              h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
              h('path', { d: 'M8 16H3v5' }),
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                minWidth: 0,
                flex: '1 1 auto',
                overflow: 'hidden',
              },
            },
            ...chips,
          ),
        ),
      )
    }

    function DeviceManager() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [drag, setDrag] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [settingsError, setSettingsError] = React.useState(null)
      const [marketQuery, setMarketQuery] = React.useState('')
      const [marketSearchInput, setMarketSearchInput] = React.useState('')
      const [marketPage, setMarketPage] = React.useState(1)
      const [marketResult, setMarketResult] = React.useState(null)
      const [marketLoading, setMarketLoading] = React.useState(false)
      const [marketError, setMarketError] = React.useState(null)
      const [marketNotice, setMarketNotice] = React.useState(null)
      const [marketModal, setMarketModal] = React.useState(null)
      const [marketConfirm, setMarketConfirm] = React.useState(false)
      const [marketBusyId, setMarketBusyId] = React.useState(null)
      const [marketSelectedId, setMarketSelectedId] = React.useState(null)
      const [health, setHealth] = React.useState(null)
      const [healthLoading, setHealthLoading] = React.useState(false)
      const [serviceNotice, setServiceNotice] = React.useState(null)
      const [detectLoading, setDetectLoading] = React.useState(false)
      const [detectResult, setDetectResult] = React.useState(null)
      const [detectError, setDetectError] = React.useState(null)
      const [marketMatches, setMarketMatches] = React.useState({})
      const [marketMatchError, setMarketMatchError] = React.useState(null)
      const [marketMatchLoading, setMarketMatchLoading] = React.useState(false)
      const [onboardingNotify, setOnboardingNotify] = React.useState(true)
      const rowRefs = React.useRef(new Map())
      const saveTimerRef = React.useRef(null)
      const pendingSettingsRef = React.useRef(null)
      const savingRef = React.useRef(false)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(DEVICES_URL, { headers: { accept: 'application/json' } })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setData(json)
          setError(null)
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const loadHealth = React.useCallback(async () => {
        try {
          const response = await fetch(HEALTH_URL, { headers: { accept: 'application/json' } })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setHealth(json)
        } catch (healthError) {
          setHealth({ ok: false, error: String(healthError?.message ?? healthError) })
        }
      }, [])

      React.useEffect(() => {
        void loadHealth()
        const timer = setInterval(() => void loadHealth(), 60_000)
        return () => clearInterval(timer)
      }, [loadHealth])

      React.useEffect(() => {
        if (!data?.settings) return
        // 没有本地待保存改动时，以服务端设置为准，避免旧 draft 覆盖 agent/另一窗口的修改。
        if (pendingSettingsRef.current || savingRef.current) return
        setDraft({ ...data.settings })
      }, [data?.settings])

      async function act(action, key, extra = {}) {
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(DEVICES_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, key, ...extra }),
          })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setData(json)
          window.dispatchEvent(new CustomEvent('peripheral-battery:devices-changed'))
          return true
        } catch (actionError) {
          setError(String(actionError?.message ?? actionError))
          return false
        } finally {
          setBusy(false)
        }
      }

      async function commitEdit(device) {
        const value = String(editing?.value ?? '').trim()
        if (!value) {
          setError('名称不能为空')
          return
        }
        if (value === (device.customName || device.name)) {
          setEditing(null)
          return
        }
        if (await act('rename', device.key, { name: value })) setEditing(null)
      }

      function settingsBody(value) {
        return {
          scheduled: Boolean(value.scheduled),
          intervalMinutes: Number(value.intervalMinutes),
          thresholdPercent: Number(value.thresholdPercent),
          notify: Boolean(value.notify),
          betaEnabled: value.betaEnabled !== false,
          onboardingDone: Boolean(value.onboardingDone),
        }
      }

      async function flushSettings() {
        if (savingRef.current) return false
        const next = pendingSettingsRef.current
        if (!next) return true
        pendingSettingsRef.current = null
        savingRef.current = true
        setSettingsError(null)
        try {
          const response = await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settingsBody(next)),
          })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          const betaChanged = (data?.settings?.betaEnabled !== false) !== (json.settings?.betaEnabled !== false)
          setData((current) => (current ? { ...current, settings: json.settings } : current))
          if (!pendingSettingsRef.current) setDraft({ ...json.settings })
          if (betaChanged) await load()
          return true
        } catch (saveError) {
          setSettingsError(String(saveError?.message ?? saveError))
          return false
        } finally {
          savingRef.current = false
          if (pendingSettingsRef.current) void flushSettings()
        }
      }

      function changeSettings(patch) {
        const next = { ...(draft || {}), ...patch }
        setDraft(next)
        pendingSettingsRef.current = next
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null
          void flushSettings()
        }, 300)
      }

      async function saveSettingsNow(patch) {
        const next = { ...(draft || {}), ...patch }
        setDraft(next)
        pendingSettingsRef.current = next
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        return await flushSettings()
      }

      async function completeOnboarding() {
        const saved = await saveSettingsNow({
          onboardingDone: true,
          notify: onboardingNotify,
          scheduled: onboardingNotify ? true : false,
        })
        setServiceNotice(saved ? '首次设置已保存' : '首次设置保存失败，请重试')
      }

      async function matchDetected(candidates) {
        if (!candidates || candidates.length === 0) {
          setMarketMatches({})
          return
        }
        setMarketMatchLoading(true)
        setMarketMatchError(null)
        try {
          const results = await Promise.all(
            candidates.slice(0, 6).map(async (candidate) => {
              const params = new URLSearchParams({ vid: candidate.vid, pid: candidate.pid })
              const response = await fetch(`${MARKET_MATCH_URL}?${params.toString()}`, {
                headers: { accept: 'application/json' },
              })
              const json = await response.json()
              if (!response.ok || !json.ok) {
                throw new Error(json?.error?.message || `HTTP ${response.status}`)
              }
              return [`${candidate.vid}:${candidate.pid}`, json.entries || []]
            }),
          )
          setMarketMatches(Object.fromEntries(results))
        } catch (matchError) {
          setMarketMatchError(String(matchError?.message ?? matchError))
        } finally {
          setMarketMatchLoading(false)
        }
      }

      async function scanDevices() {
        setDetectLoading(true)
        setDetectError(null)
        try {
          const response = await fetch(DETECT_URL, { headers: { accept: 'application/json' } })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setDetectResult(json)
          void matchDetected(json.candidates || [])
        } catch (scanError) {
          setDetectError(String(scanError?.message ?? scanError))
        } finally {
          setDetectLoading(false)
        }
      }

      async function copyText(text) {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            const ok = document.execCommand('copy')
            document.body.removeChild(area)
            return ok
          } catch {
            return false
          }
        }
      }

      async function copyAdaptPrompt(candidate) {
        const prompt = `帮我适配这台外设：${candidate.product}（${candidate.vid}:${candidate.pid}）。先检测并抓包，再写适配器。`
        const ok = await copyText(prompt)
        setServiceNotice(ok ? '适配指令已复制，到对话里粘贴即可' : '复制失败，请手动输入设备名请求适配')
      }

      async function copyVerificationReport(id) {
        try {
          const response = await fetch(`${MARKET_REPORT_URL}?id=${encodeURIComponent(id)}`, {
            headers: { accept: 'application/json' },
          })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          const ok = await copyText(json.text)
          setMarketNotice(
            ok
              ? '验证报告已复制，请提交到 GitHub issue（市场仓库的 adapter-verification 模板）'
              : '验证报告复制失败',
          )
          if (ok) {
            setMarketModal(null)
            setMarketConfirm(false)
          }
        } catch (reportError) {
          setMarketError(String(reportError?.message ?? reportError))
        }
      }

      async function restartService() {
        setHealthLoading(true)
        try {
          const response = await fetch(RESTART_URL, { method: 'POST' })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setHealth(json)
          setServiceNotice('电量服务已重启')
          window.dispatchEvent(new CustomEvent('peripheral-battery:devices-changed'))
          await load()
        } catch (restartError) {
          setServiceNotice(`重启失败：${String(restartError?.message ?? restartError)}`)
        } finally {
          setHealthLoading(false)
        }
      }

      async function copyDiagnostics() {
        try {
          const response = await fetch(DIAGNOSTICS_URL, { headers: { accept: 'application/json' } })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          const ok = await copyText(json.text)
          setServiceNotice(ok ? '诊断信息已复制' : '诊断信息复制失败')
        } catch (diagnosticsError) {
          setServiceNotice(`获取诊断失败：${String(diagnosticsError?.message ?? diagnosticsError)}`)
        }
      }

      async function testNotification() {
        try {
          const response = await fetch(TEST_NOTIFICATION_URL, { method: 'POST' })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setServiceNotice(json.message || '测试通知已发送')
        } catch (notificationError) {
          setServiceNotice(`测试通知失败：${String(notificationError?.message ?? notificationError)}`)
        }
      }

      async function loadMarket(force = false) {
        if (
          !force &&
          marketCache.entries &&
          Date.now() - marketCache.fetchedAt < MARKET_CACHE_MS
        ) {
          setMarketResult({
            entries: marketCache.entries,
            warnings: marketCache.warnings,
            sourceUrl: marketCache.sourceUrl,
          })
          return
        }
        setMarketLoading(true)
        setMarketError(null)
        setMarketNotice(null)
        try {
          const response = await fetch(
            `${MARKET_SEARCH_URL}?query=&refresh=${force ? '1' : '0'}`,
            { headers: { accept: 'application/json' } },
          )
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          const result = {
            entries: Array.isArray(json.entries) ? json.entries : [],
            warnings: Array.isArray(json.warnings) ? json.warnings : [],
            sourceUrl: json.sourceUrl || '',
          }
          marketCache = { ...result, fetchedAt: Date.now() }
          setMarketResult(result)
        } catch (loadError) {
          setMarketError(String(loadError?.message ?? loadError))
        } finally {
          setMarketLoading(false)
        }
      }

      async function openMarketModal(id) {
        setMarketSelectedId(id)
        setMarketBusyId(id)
        setMarketError(null)
        setMarketNotice(null)
        setMarketConfirm(false)
        try {
          const response = await fetch(
            `${MARKET_PREVIEW_URL}?id=${encodeURIComponent(id)}`,
            { headers: { accept: 'application/json' } },
          )
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setMarketModal(json)
        } catch (previewError) {
          setMarketError(String(previewError?.message ?? previewError))
        } finally {
          setMarketBusyId(null)
        }
      }

      async function installMarket(id) {
        if (!marketConfirm) {
          setMarketConfirm(true)
          return
        }
        setMarketBusyId(id)
        setMarketError(null)
        setMarketNotice(null)
        try {
          const response = await fetch(MARKET_INSTALL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, confirm: true }),
          })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          const installedName = json.installed?.name || id
          setMarketModal(null)
          setMarketConfirm(false)
          marketCache.fetchedAt = 0
          await fetch(REFRESH_URL, { method: 'POST' }).catch(() => {})
          await loadMarket(true)
          await load()
          setMarketNotice(`已安装：${installedName}`)
        } catch (installError) {
          setMarketError(String(installError?.message ?? installError))
        } finally {
          setMarketBusyId(null)
        }
      }

      async function removeMarketAdapter(id) {
        setMarketBusyId(id)
        setMarketError(null)
        setMarketNotice(null)
        try {
          const response = await fetch(MARKET_REMOVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          const json = await response.json()
          if (!response.ok || !json.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`)
          setMarketModal(null)
          marketCache.fetchedAt = 0
          await loadMarket(true)
          await load()
          setMarketNotice(`已移除：${id}`)
        } catch (removeError) {
          setMarketError(String(removeError?.message ?? removeError))
        } finally {
          setMarketBusyId(null)
        }
      }

      React.useEffect(() => {
        void loadMarket(false)
      }, [])

      React.useEffect(() => {
        const timer = setTimeout(() => {
          setMarketQuery(marketSearchInput.trim())
          setMarketPage(1)
        }, 250)
        return () => clearTimeout(timer)
      }, [marketSearchInput])

      React.useEffect(() => {
        if (!marketModal) return
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setMarketModal(null)
            setMarketConfirm(false)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [marketModal])

      // 关闭设置页时把还没发出的最后一次修改补发出去。
      React.useEffect(
        () => () => {
          if (!saveTimerRef.current) return
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
          const next = pendingSettingsRef.current
          if (!next) return
          pendingSettingsRef.current = null
          void fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settingsBody(next)),
          }).catch(() => {})
        },
        [],
      )

      const devices = data?.devices || []
      const marketMatchDetails = (match) => {
        const parts = [`VID ${match.vids.join('/')}`, `PID ${match.pids.length > 0 ? match.pids.join('/') : '任意'}`]
        if (match.usagePage) parts.push(`UP ${match.usagePage}`)
        if (match.usage) parts.push(`Usage ${match.usage}`)
        for (const key of ['inLen', 'outLen', 'featureLen']) {
          if (match[key] !== undefined) {
            const label = key === 'inLen' ? 'IN' : key === 'outLen' ? 'OUT' : 'FEA'
            parts.push(`${label} ${match[key]}`)
          }
        }
        return parts.join(' · ')
      }
      const marketMeta = (label, value) =>
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '70px 1fr',
              gap: 10,
              padding: '5px 0',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          h('span', { style: { opacity: 0.6, fontSize: 11 } }, label),
          h(
            'span',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 11,
                wordBreak: 'break-all',
              },
            },
            value,
          ),
        )
      const marketBadge = (text, key) =>
        h(
          'span',
          {
            key,
            style: {
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              opacity: 0.8,
              whiteSpace: 'nowrap',
              maxWidth: 110,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          text,
        )
      const marketStatusLabel = (status) => {
        if (status === 'verified') return '真机验证'
        if (status === 'community') return '社区验证'
        if (status === 'experimental') return '实验性'
        return status
      }
      const marketConnections = (entry) =>
        Array.isArray(entry.connection) && entry.connection.length > 0
          ? entry.connection
          : entry.transport
            ? [entry.transport]
            : []
      const marketEntries = marketResult?.entries || []
      const marketNeedle = marketQuery.trim().toLowerCase()
      const marketFiltered = marketEntries.filter((entry) => {
        if (!marketNeedle) return true
        return [entry.id, entry.name, entry.model]
          .join(' ')
          .toLowerCase()
          .includes(marketNeedle)
      })
      const MARKET_PAGE_SIZE = 6
      const marketPageCount = Math.max(1, Math.ceil(marketFiltered.length / MARKET_PAGE_SIZE))
      const marketCurrentPage = Math.min(marketPage, marketPageCount)
      const marketPageEntries = marketFiltered.slice(
        (marketCurrentPage - 1) * MARKET_PAGE_SIZE,
        marketCurrentPage * MARKET_PAGE_SIZE,
      )

      function startDrag(event, device) {
        event.preventDefault()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // 某些环境不支持 pointer capture；仍允许拖动。
        }
        setDrag({ key: device.key, pointerId: event.pointerId, overKey: device.key })
      }

      function moveDrag(event) {
        if (!drag || drag.pointerId !== event.pointerId) return
        let over = drag.key
        for (const [key, node] of rowRefs.current) {
          if (!node) continue
          const rect = node.getBoundingClientRect()
          if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
            over = key
            break
          }
        }
        if (over !== drag.overKey) {
          setDrag((current) => (current ? { ...current, overKey: over } : current))
        }
      }

      async function endDrag(event) {
        if (!drag || drag.pointerId !== event.pointerId) return
        const from = drag.key
        const to = drag.overKey
        setDrag(null)
        if (!to || to === from) return
        const order = devices.map((device) => device.key)
        const index = order.indexOf(to)
        if (index >= 0) await act('moveTo', from, { index })
      }

      const row = (device) =>
        h(
          'div',
          {
            key: device.key,
            ref: (node) => {
              if (node) rowRefs.current.set(device.key, node)
              else rowRefs.current.delete(device.key)
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              padding: '8px 0',
              borderTop:
                drag?.overKey === device.key && drag?.key !== device.key
                  ? '2px solid var(--dsw-alias-brand-primary)'
                  : '1px solid var(--dsw-alias-border-l1)',
              opacity: drag?.key === device.key ? 0.45 : 1,
            },
          },
          h(
            'button',
            {
              style: { ...buttonStyle, cursor: 'grab', touchAction: 'none' },
              title: '拖动排序',
              onPointerDown: (event) => startDrag(event, device),
              onPointerMove: moveDrag,
              onPointerUp: endDrag,
              onPointerCancel: () => setDrag(null),
            },
            '⠿',
          ),
          h('input', {
            type: 'checkbox',
            checked: Boolean(device.visible),
            disabled: busy,
            title: '显示/隐藏',
            onChange: (event) => void act(event.target.checked ? 'show' : 'hide', device.key),
          }),
          editing?.key === device.key
            ? h('input', {
                autoFocus: true,
                style: { ...inputStyle, width: 180 },
                value: editing.value,
                onChange: (event) => setEditing({ key: device.key, value: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void commitEdit(device)
                  if (event.key === 'Escape') setEditing(null)
                },
                onBlur: () => void commitEdit(device),
              })
            : h(
                'button',
                {
                  style: {
                    ...buttonStyle,
                    padding: 0,
                    color: 'var(--dsw-alias-label-primary)',
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  title: '点击改名',
                  onClick: () => setEditing({ key: device.key, value: device.customName || device.name }),
                },
                device.name,
              ),
          device.customName
            ? h(
                'button',
                { style: buttonStyle, disabled: busy, onClick: () => void act('resetName', device.key) },
                '恢复默认',
              )
            : null,
          h(
            'span',
            {
              style: { color: 'var(--dsw-alias-label-secondary)' },
              title: device.detail || device.transport || '',
            },
            valueFor(device),
          ),
          h(
            'span',
            { style: { marginLeft: 'auto', display: 'inline-flex', gap: 2 } },
            h(
              'button',
              { style: buttonStyle, disabled: busy, title: '上移', onClick: () => void act('move', device.key, { direction: 'up' }) },
              '↑',
            ),
            h(
              'button',
              { style: buttonStyle, disabled: busy, title: '下移', onClick: () => void act('move', device.key, { direction: 'down' }) },
              '↓',
            ),
            device.status === 'unplugged'
              ? h(
                  'button',
                  {
                    style: buttonStyle,
                    disabled: busy,
                    title: '移除记录（仅已拔出设备）',
                    onClick: () => void act('remove', device.key),
                  },
                  '✕',
                )
              : null,
          ),
          device.components?.length > 0
            ? h(
                'div',
                {
                  style: {
                    width: '100%',
                    paddingLeft: 52,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                    fontSize: 11,
                  },
                },
                ...device.components.map((component) => {
                  const color =
                    component.percent <= 20
                      ? '#ff4d4f'
                      : component.percent <= 50
                        ? '#fa8c16'
                        : 'var(--dsw-alias-state-success-primary)'
                  return h(
                    'span',
                    {
                      key: `${device.key}:${component.label}`,
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '1px 7px',
                        borderRadius: 999,
                        background: 'var(--dsw-alias-bg-layer-1)',
                        border: '1px solid var(--dsw-alias-border-l1)',
                      },
                    },
                    h('span', { style: { opacity: 0.6 } }, component.label),
                    h('span', { style: { color, fontWeight: 600 } }, `${component.percent}%`),
                    component.charging ? h('span', { title: '充电中' }, '⚡') : null,
                  )
                }),
              )
            : null,
        )

      const formatTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—')
      const serviceRunning = health?.daemon?.running === true
      const detectCandidates = detectResult?.candidates || []

      return h(
        'div',
        { style: { padding: '4px 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
        h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 12,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
            h('span', {
              style: {
                width: 7,
                height: 7,
                borderRadius: '50%',
                flex: '0 0 auto',
                background: serviceRunning
                  ? 'var(--dsw-alias-state-success-primary)'
                  : health
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-state-idle-primary)',
              },
            }),
            h(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } },
              health
                ? serviceRunning
                  ? '电量服务运行中'
                  : '电量服务未启动'
                : '正在检查服务…',
            ),
            h(
              'span',
              { style: { opacity: 0.55, fontSize: 11 } },
              health?.plugin
                ? `v${health.plugin.version} · daemon ${health.daemon?.version || '—'}`
                : '',
            ),
            h(
              'div',
              { style: { marginLeft: 'auto', display: 'flex', gap: 6, flex: '0 0 auto', flexWrap: 'wrap' } },
              h(
                'button',
                {
                  style: buttonStyle,
                  disabled: healthLoading,
                  onClick: () => void restartService(),
                },
                healthLoading ? '重启中…' : '重启服务',
              ),
              h(
                'button',
                { style: buttonStyle, onClick: () => void testNotification() },
                '测试通知',
              ),
              h(
                'button',
                { style: buttonStyle, onClick: () => void copyDiagnostics() },
                '复制诊断',
              ),
            ),
          ),
          h(
            'div',
            { style: { marginTop: 4, fontSize: 11, opacity: 0.6 } },
            health
              ? `最近刷新：${formatTime(health.lastPolledAt)}${health.lastError ? ` · 最后错误：${health.lastError}` : ''}`
              : '正在读取服务信息…',
          ),
          health?.daemon?.error
            ? h(
                'div',
                { style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } },
                health.daemon.error,
              )
            : null,
          serviceNotice
            ? h('div', { style: { marginTop: 4, fontSize: 11, opacity: 0.8 } }, serviceNotice)
            : null,
        ),
        draft?.onboardingDone === false
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsw-alias-brand-primary)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 12,
                  background: 'var(--dsw-alias-bg-base)',
                },
              },
              h(
                'div',
                { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                '首次使用：两步完成设置',
              ),
              h(
                'div',
                { style: { marginTop: 4, fontSize: 11, opacity: 0.7 } },
                devices.length > 0
                  ? `已检测到 ${devices.length} 台无线外设，已自动加入底栏。`
                  : '暂时没有检测到受支持的无线外设。',
              ),
              devices.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
                    ...devices.slice(0, 5).map((device) =>
                      h(
                        'span',
                        {
                          key: device.key,
                          style: {
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: 'var(--dsw-alias-bg-layer-1)',
                            color: 'var(--dsw-alias-label-primary)',
                          },
                        },
                        `${device.name} ${device.status === 'online' && device.percent != null ? `${device.percent}%` : valueFor(device)}`,
                      ),
                    ),
                  )
                : null,
              h(
                'label',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 10,
                    cursor: 'pointer',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked: onboardingNotify,
                  onChange: (event) => setOnboardingNotify(event.target.checked),
                }),
                h('span', null, '低电量时提醒我'),
                h(
                  'span',
                  { style: { fontSize: 10, opacity: 0.55 } },
                  '会同时开启后台定时刷新',
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
                h(
                  'button',
                  {
                    style: {
                      ...buttonStyle,
                      color: 'var(--dsw-alias-brand-primary)',
                      fontWeight: 600,
                    },
                    onClick: () => void completeOnboarding(),
                  },
                  '完成设置',
                ),
                devices.length === 0
                  ? h(
                      'button',
                      {
                        style: buttonStyle,
                        disabled: detectLoading,
                        onClick: async () => {
                          await scanDevices()
                          document.getElementById('pb-detect')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        },
                      },
                      detectLoading ? '扫描中…' : '扫描新设备',
                    )
                  : null,
                devices.length === 0
                  ? h(
                      'button',
                      {
                        style: buttonStyle,
                        onClick: () => {
                          document.getElementById('pb-market')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        },
                      },
                      '去适配器市场',
                    )
                  : null,
                h(
                  'span',
                  { style: { fontSize: 10, opacity: 0.55 } },
                  onboardingNotify ? '手动刷新仍随时可用。' : '不提醒时只在你手动刷新时检查。',
                ),
              ),
            )
          : null,
        h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 } }, '刷新设置'),
        draft
          ? h(SettingsPanel, {
              draft,
              onChange: changeSettings,
            })
          : h('div', { style: { opacity: 0.7 } }, '设置读取中…'),
        settingsError
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 } }, settingsError)
          : null,
        h(
          'div',
          {
            id: 'pb-market',
            style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginTop: 14, marginBottom: 6 },
          },
          '适配器市场',
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
          h('input', {
            type: 'search',
            value: marketSearchInput,
            placeholder: '名称 / 型号 / ID',
            onChange: (event) => setMarketSearchInput(event.target.value),
            style: {
              flex: '1 1 auto',
              height: 22,
              boxSizing: 'border-box',
              padding: '0 6px',
              borderRadius: 5,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 11,
            },
          }),
          h(
            'button',
            { style: buttonStyle, disabled: marketLoading, onClick: () => void loadMarket(true) },
            marketLoading ? '刷新中…' : '刷新',
          ),
        ),
        marketError
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 6 } }, marketError)
          : null,
        marketNotice
          ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary)', marginBottom: 6 } }, marketNotice)
          : null,
        h(
          'style',
          null,
          [
            '.pb-market-card { cursor: pointer; transition: border-color .16s ease, box-shadow .18s ease, transform .18s ease; }',
            '.pb-market-card:hover { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary), 0 6px 16px rgba(0,0,0,.10); transform: translateY(-1px); }',
            '.pb-market-card[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }',
            '.pb-market-card:active { transform: translateY(0); }',
            '.pb-market-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
            '.pb-market-chevron { transition: color .16s ease, opacity .16s ease; }',
            '.pb-market-card:hover .pb-market-chevron { color: var(--dsw-alias-brand-primary); opacity: 1; }',
          ].join('\n'),
        ),
        marketLoading && !marketResult ? (
          h('div', { style: { opacity: 0.7, marginBottom: 6 } }, '正在读取市场…')
        ) : !marketResult ? null : marketFiltered.length === 0 ? (
          h('div', { style: { opacity: 0.7, marginBottom: 6 } }, '没有匹配的适配器。')
        ) : (
          h(
            'div',
            {
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
                padding: 8,
                background: 'var(--dsw-alias-bg-base)',
                marginBottom: 6,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 8,
              },
            },
            ...marketPageEntries.map((entry) =>
              h(
                'div',
                {
                  key: entry.id,
                  role: 'button',
                  tabIndex: 0,
                  className: 'pb-market-card',
                  title: '查看详情',
                  'data-selected': marketSelectedId === entry.id ? 'true' : 'false',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 6,
                    minWidth: 0,
                  },
                  onClick: () => void openMarketModal(entry.id),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void openMarketModal(entry.id)
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                      flex: '1 1 auto',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                        minWidth: 0,
                      },
                    },
                    h(
                      'span',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-primary)',
                          fontSize: 13,
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: '0 1 auto',
                        },
                        title: entry.name,
                      },
                      entry.name,
                    ),
                    entry.model
                      ? h(
                          'span',
                          {
                            style: {
                              color: 'var(--dsw-alias-label-primary)',
                              opacity: 0.62,
                              fontSize: 11,
                              fontWeight: 400,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                              flex: '1 1 auto',
                            },
                            title: entry.model,
                          },
                          entry.model,
                        )
                      : null,
                  ),
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 4,
                        minWidth: 0,
                      },
                    },
                    ...marketConnections(entry).map((tag, index) =>
                      marketBadge(tag, `connection-${entry.id}-${index}`),
                    ),
                    entry.installed && !entry.builtIn
                      ? marketBadge('已安装')
                      : marketBadge(marketStatusLabel(entry.status)),
                    entry.author ? marketBadge(entry.author) : null,
                  ),
                ),
                entry.installed && !entry.builtIn
                  ? h(
                      'button',
                      {
                        style: {
                          ...buttonStyle,
                          color: 'var(--dsw-alias-state-error-primary)',
                          fontSize: 11,
                        },
                        disabled: marketBusyId === entry.id,
                        onClick: (event) => {
                          event.stopPropagation()
                          void removeMarketAdapter(entry.id)
                        },
                      },
                      '移除',
                    )
                  : null,
                h(
                  'span',
                  {
                    className: 'pb-market-chevron',
                    style: {
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: 14,
                      lineHeight: 1,
                      opacity: 0.5,
                      flex: '0 0 auto',
                    },
                  },
                  '›',
                ),
              ),
            ),
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginTop: 6,
                },
              },
              h('span', { style: { opacity: 0.6, fontSize: 11 } }, `共 ${marketFiltered.length} 个`),
              marketPageCount > 1
                ? h(
                    'span',
                    { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                    h(
                      'button',
                      {
                        style: buttonStyle,
                        disabled: marketCurrentPage <= 1,
                        onClick: () => setMarketPage(marketCurrentPage - 1),
                      },
                      '‹ 上一页',
                    ),
                    h(
                      'span',
                      { style: { opacity: 0.6, fontSize: 11 } },
                      `${marketCurrentPage} / ${marketPageCount}`,
                    ),
                    h(
                      'button',
                      {
                        style: buttonStyle,
                        disabled: marketCurrentPage >= marketPageCount,
                        onClick: () => setMarketPage(marketCurrentPage + 1),
                      },
                      '下一页 ›',
                    ),
                  )
                : null,
            ),
          )
        ),
        h(
          'div',
          {
            id: 'pb-detect',
            style: {
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              padding: '10px 12px',
              marginTop: 14,
              marginBottom: 12,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'span',
              { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
              '新设备',
            ),
            h(
              'button',
              {
                style: { ...buttonStyle, marginLeft: 'auto' },
                disabled: detectLoading,
                onClick: () => void scanDevices(),
              },
              detectLoading ? '扫描中…' : '扫描新设备',
            ),
          ),
          h(
            'div',
            { style: { fontSize: 11, opacity: 0.65, marginTop: 4 } },
            '找不到设备时，扫描未适配的厂商 HID；复制适配指令后到对话里粘贴，agent 会检测并写适配器。',
          ),
          detectError
            ? h(
                'div',
                { style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' } },
                detectError,
              )
            : null,
          detectResult
            ? detectCandidates.length === 0
              ? h('div', { style: { marginTop: 6, opacity: 0.7 } }, '没有发现未适配的厂商 HID 设备。')
              : h(
                  'div',
                  { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 } },
                  ...detectCandidates.slice(0, 6).map((candidate) => {
                    const key = `${candidate.vid}:${candidate.pid}`
                    const matches = marketMatches[key] || []
                    return h(
                      'div',
                      {
                        key,
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          padding: '6px 0',
                          borderTop: '1px solid var(--dsw-alias-border-l1)',
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                        h(
                          'span',
                          {
                            style: {
                              flex: '1 1 auto',
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--dsw-alias-label-primary)',
                            },
                            title: key,
                          },
                          candidate.product,
                        ),
                        h(
                          'button',
                          { style: buttonStyle, onClick: () => void copyAdaptPrompt(candidate) },
                          '复制适配指令',
                        ),
                        h(
                          'button',
                          {
                            style: buttonStyle,
                            onClick: () => {
                              setMarketSearchInput(candidate.product)
                              setMarketQuery(candidate.product)
                              setMarketPage(1)
                              setMarketSelectedId(null)
                              document
                                .getElementById('pb-market')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            },
                          },
                          '在市场搜索',
                        ),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                            fontSize: 11,
                            opacity: 0.7,
                          },
                        },
                        marketMatchLoading
                          ? '正在查询市场匹配…'
                          : matches.length > 0
                            ? h(
                                'span',
                                {
                                  style: {
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  },
                                },
                                `市场匹配：${matches
                                  .slice(0, 2)
                                  .map((entry) => `${entry.name}（${marketStatusLabel(entry.status)}）`)
                                  .join(' / ')}`,
                                matches.length > 2 ? ` +${matches.length - 2}` : '',
                              )
                            : '市场暂无匹配',
                        matches.length > 0
                          ? h(
                              'button',
                              {
                                style: { ...buttonStyle, color: 'var(--dsw-alias-brand-primary)' },
                                onClick: () => void openMarketModal(matches[0].id),
                              },
                              '查看/安装',
                            )
                          : null,
                      ),
                    )
                  }),
                  marketMatchError
                    ? h(
                        'div',
                        { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } },
                        `市场匹配失败：${marketMatchError}`,
                      )
                    : null,
                )
            : null,
        ),
        h(
          'div',
          { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginTop: 14, marginBottom: 6 } },
          '设备列表',
        ),
        h(
          'div',
          { style: { opacity: 0.7, marginBottom: 8 } },
          '勾选控制底栏显示；点击名称改名（Enter 保存 / Esc 取消）；⠿ 拖动或 ↑/↓ 排序；✕ 仅对已拔出设备删除记录。',
        ),
        error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 } }, error) : null,
        devices.length === 0
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', null, '还没有已知设备。'),
              h(
                'button',
                { style: buttonStyle, disabled: detectLoading, onClick: () => void scanDevices() },
                detectLoading ? '扫描中…' : '扫描新设备',
              ),
            )
          : devices.map(row),
        marketModal
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  background: 'rgba(0,0,0,.45)',
                  zIndex: 2_000,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 16,
                },
                onClick: (event) => {
                  if (event.target !== event.currentTarget) return
                  setMarketModal(null)
                  setMarketConfirm(false)
                },
              },
              h(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': `${marketModal.entry.name} 详情`,
                  style: {
                    width: 560,
                    maxWidth: '100%',
                    maxHeight: '80vh',
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'var(--dsw-alias-bg-base)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 10,
                    boxShadow: '0 18px 50px rgba(0,0,0,.35)',
                    overflow: 'hidden',
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        flex: '1 1 auto',
                        fontWeight: 600,
                        color: 'var(--dsw-alias-label-primary)',
                        fontSize: 14,
                      },
                    },
                    marketModal.entry.name,
                  ),
                  h('span', { style: { opacity: 0.6, fontSize: 11 } }, marketStatusLabel(marketModal.entry.status)),
                  h(
                    'button',
                    {
                      style: { ...buttonStyle, fontSize: 16, lineHeight: 1, padding: '0 4px' },
                      title: '关闭',
                      onClick: () => {
                        setMarketModal(null)
                        setMarketConfirm(false)
                      },
                    },
                    '×',
                  ),
                ),
                h(
                  'div',
                  { style: { padding: '10px 16px', overflow: 'auto' } },
                  marketError
                    ? h(
                        'div',
                        { style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 6 } },
                        marketError,
                      )
                    : null,
                  marketMeta('ID', marketModal.entry.id),
                  marketMeta('型号', marketModal.entry.model || '—'),
                  marketMeta(
                    '连接',
                    marketConnections(marketModal.entry).join(' · ') || '—',
                  ),
                  marketMeta('匹配', marketMatchDetails(marketModal.entry.match)),
                  marketMeta('作者', marketModal.entry.author || '未知'),
                  marketMeta('文件', marketModal.entry.file),
                  marketMeta('SHA-256', marketModal.sha256),
                  marketModal.entry.notes ? marketMeta('说明', marketModal.entry.notes) : null,
                  h(
                    'div',
                    {
                      style: {
                        marginTop: 10,
                        fontSize: 11,
                        color: 'var(--dsw-alias-label-secondary)',
                      },
                    },
                    '源码（请审阅后再安装）',
                  ),
                  h(
                    'pre',
                    {
                      style: {
                        maxHeight: 220,
                        overflow: 'auto',
                        margin: '6px 0 0',
                        padding: 8,
                        borderRadius: 6,
                        background: 'var(--dsw-alias-bg-layer-1)',
                        fontSize: 10,
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                      },
                    },
                    marketModal.source,
                  ),
                ),
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      gap: 8,
                      padding: '10px 16px',
                      borderTop: '1px solid var(--dsw-alias-border-l1)',
                    },
                  },
                  marketModal.entry.builtIn
                    ? h('span', { style: { opacity: 0.65, fontSize: 11, marginRight: 'auto' } }, '真机验证通过，无需安装')
                    : [
                        h(
                          'button',
                          {
                            key: 'install',
                            style: {
                              ...buttonStyle,
                              color: 'var(--dsw-alias-brand-primary)',
                              fontWeight: 600,
                            },
                            disabled: marketBusyId === marketModal.entry.id,
                            onClick: () => void installMarket(marketModal.entry.id),
                          },
                          marketConfirm ? '确认安装' : '安装',
                        ),
                        marketConfirm
                          ? h(
                              'button',
                              {
                                key: 'cancel',
                                style: buttonStyle,
                                onClick: () => setMarketConfirm(false),
                              },
                              '取消',
                            )
                          : null,
                      ],
                  marketModal.entry.installed
                    ? h(
                        'button',
                        {
                          style: buttonStyle,
                          onClick: () => void copyVerificationReport(marketModal.entry.id),
                        },
                        '复制验证报告',
                      )
                    : null,
                  h(
                    'button',
                    {
                      style: buttonStyle,
                      onClick: () => {
                        setMarketModal(null)
                        setMarketConfirm(false)
                      },
                    },
                    '关闭',
                  ),
                ),
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        rootCtx = ctx
        ctx.effect(() => () => {
          if (rootCtx === ctx) rootCtx = null
        })
        ctx.slots.inject('shell.bottom', () =>
          ctx.slots.register({ name: 'shell.bottom', id: 'peripheral-battery' }, BottomBar),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'peripheral-battery', order: 30, label: '外设电量' },
            DeviceManager,
          ),
        )
      },
    }
  },
})
