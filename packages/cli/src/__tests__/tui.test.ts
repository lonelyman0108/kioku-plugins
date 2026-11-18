import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { readCliPreferences, writeCliPreferences } from '../identity.ts'
import { defaultServerUrl, detectPlatformPresence, type PlatformRow } from '../panel.ts'
import { createLineInput } from '../ui/lineInput.ts'
import { createTheme } from '../ui/theme.ts'
import { renderTuiFrame, runTui, type TuiDeps, type TuiModal, type TuiState } from '../ui/tui.ts'
import { displayWidth, stripAnsi } from '../ui/width.ts'

const WHO = (family: string) => ({
  spaceId: '11111111-2222-3333-4444-555555555555',
  spaceName: '个人空间',
  accountName: '测试账号',
  app: { id: 'app-id', slug: family, name: `${family} 应用`, runtimeFamily: family },
  scopes: {
    readLayers: ['core', 'user', 'app'],
    writeLayers: ['user', 'app'],
    maxSensitivity: 'private',
    credentials: 'use',
  },
})

function makeState(overrides: Partial<TuiState> = {}): TuiState {
  const platforms: PlatformRow[] = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      present: true,
      connection: 'ok',
      who: WHO('claudecode'),
      plugin: true,
      memory: 'off',
      local: 5,
    },
    {
      id: 'codex',
      name: 'Codex',
      present: true,
      connection: 'none',
      plugin: false,
      memory: 'on',
      conflicts: [
        {
          id: 'codex:mem0:mcp:/x#mem0',
          platform: 'codex',
          tool: 'mem0',
          toolName: 'Mem0',
          kind: 'mcp',
          summary: 'mcp_servers.mem0（/tmp/config.toml）',
          removable: true,
        },
      ],
    },
    {
      id: 'pi',
      name: 'pi',
      present: true,
      connection: 'invalid',
      reason: '访问密钥无效或已吊销',
      plugin: true,
      memory: 'none',
    },
    {
      id: 'hermes',
      name: 'Hermes',
      present: false,
      connection: 'none',
      plugin: null,
      memory: null,
    },
  ]
  return {
    version: '0.4.1',
    url: 'https://kioku.example.com',
    server: {
      url: 'https://kioku.example.com',
      reachable: true,
      version: '0.4.2',
      problem: null,
      needsSetup: false,
    },
    platforms,
    selectedId: 'claude-code',
    showUninstalled: false,
    listScroll: 0,
    detailScroll: 0,
    spinnerFrame: 0,
    busyLabel: null,
    toast: null,
    resultsById: {},
    pendingById: {},
    modal: null,
    ...overrides,
  }
}

function createFakeTty(cols = 104, rows = 28) {
  const ttyIn = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((mode: boolean) => {
      ttyIn.isRaw = mode
    }),
    resume: vi.fn(),
    pause: vi.fn(),
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {},
  })
  const writes: string[] = []
  const out = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    write(chunk: string | Uint8Array) {
      writes.push(String(chunk))
      return true
    },
  })
  return { ttyIn, out, writes }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('renderTuiFrame 纯渲染布局与弹出层对齐', () => {
  it('在宽屏、窄屏、矮窗及 TrueColor / 256色 / 无色主题下严格保持行数与列宽不变量，并展示正确标题', () => {
    const state = makeState()
    const themes = [
      createTheme({ color: true, env: { COLORTERM: 'truecolor' } }),
      createTheme({ color: true, env: { TERM: 'xterm-256color' } }),
      createTheme({ color: false }),
    ]
    const sizes: Array<[number, number]> = [
      [104, 28],
      [68, 22],
      [92, 14],
    ]
    for (const theme of themes) {
      for (const [cols, rows] of sizes) {
        const lines = renderTuiFrame(state, cols, rows, theme)
        expect(lines).toHaveLength(rows)
        for (const line of lines) {
          expect(displayWidth(line)).toBeLessThanOrEqual(cols)
        }
        const topPlain = stripAnsi(lines[0])
        expect(topPlain).toContain('記 憶')
        expect(topPlain).toContain('kioku-plugins')
        expect(topPlain).not.toContain('客户端控制台')

        const joined = stripAnsi(lines.join('\n'))
        expect(joined).toContain('Claude Code')
        expect(joined).toContain('Codex')
        expect(joined).toContain('服务与权限')
      }
    }
  })

  it('未检出客户端默认折叠并在展开后显示', () => {
    const theme = createTheme({ color: false })
    const folded = renderTuiFrame(makeState({ showUninstalled: false }), 104, 24, theme).join('\n')
    expect(folded).toContain('折叠 1 个未检出')
    expect(folded).not.toContain('Hermes')

    const expanded = renderTuiFrame(makeState({ showUninstalled: true }), 104, 24, theme).join('\n')
    expect(expanded).toContain('Hermes')
    expect(expanded).toContain('折叠未检出（1）')
  })

  it('各类弹出层覆盖在中文背景上时保持总列宽严丝合缝', () => {
    const modals: TuiModal[] = [
      {
        kind: 'text',
        title: '设置服务地址',
        prompt: 'Kioku 的服务地址',
        placeholder: 'https://kioku.example.com',
        input: createLineInput('https://kioku.example.com'),
      },
      {
        kind: 'confirm',
        title: '接入计划',
        lines: ['Codex：签发访问密钥，写入配置，停用自带长期记忆'],
        question: '开始执行？',
        yesLabel: '确认',
        noLabel: '取消',
        value: true,
      },
      {
        kind: 'multiselect',
        title: '批量接入',
        prompt: '选择客户端：',
        options: [
          { value: 'codex', label: 'Codex' },
          { value: 'pi', label: 'pi', hint: '本机未检出' },
        ],
        selected: ['codex'],
        cursor: 0,
        scroll: 0,
      },
      {
        kind: 'device-auth',
        title: '浏览器授权',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://kioku.example.com/authorize',
        remainingSec: 598,
        codeCopied: true,
        linkCopied: false,
      },
      {
        kind: 'help',
        title: '操作说明与分工边界',
        lines: ['快捷键说明', '记忆目录与凭据请在网页端操作'],
      },
    ]

    for (const theme of [
      createTheme({ color: true, env: { COLORTERM: 'truecolor' } }),
      createTheme({ color: false }),
    ]) {
      for (const modal of modals) {
        const lines = renderTuiFrame(makeState({ modal }), 100, 26, theme)
        expect(lines).toHaveLength(26)
        for (const line of lines) {
          expect(displayWidth(line)).toBe(100)
        }
      }
    }
  })
})

describe('runTui 交互工作台状态流', () => {
  it('渐进式扫描先渲染本机列表，再在远端校验完成后更新状态并 cleanly 退出', async () => {
    const { ttyIn, out, writes } = createFakeTty(104, 26)
    let resolveHealth!: (v: {
      reachable: boolean
      version: string
      problem: null
      needsSetup: false
    }) => void
    let resolveRemote!: (v: PlatformRow) => void

    const deps: Partial<TuiDeps> = {
      defaultServerUrl: async () => 'https://kioku.example.com',
      serverHealth: () =>
        new Promise((r) => {
          resolveHealth = r
        }),
      scanLocalPlatform: async (id) => {
        if (id === 'pi') {
          return {
            row: {
              id: 'pi',
              name: 'pi',
              present: true,
              connection: 'unknown',
              checking: true,
              plugin: true,
              memory: 'none',
            },
            config: { url: 'https://kioku.example.com', key: 'fake-token' },
          }
        }
        return {
          row: {
            id,
            name: id,
            present: false,
            connection: 'none',
            plugin: null,
            memory: null,
          },
          config: null,
        }
      },
      verifyPlatformRemote: (row) =>
        new Promise((r) => {
          resolveRemote = r
          void row
        }),
    }

    const done = runTui({ env: {}, cwd: '/tmp', stdin: ttyIn, out, deps })
    await flush()

    const firstSnapshot = stripAnsi(writes.join(''))
    expect(firstSnapshot).toContain('核对中')
    expect(firstSnapshot).toContain('连接中')

    resolveHealth({ reachable: true, version: '0.4.2', problem: null, needsSetup: false })
    resolveRemote({
      id: 'pi',
      name: 'pi',
      present: true,
      connection: 'ok',
      who: WHO('pi'),
      plugin: true,
      memory: 'none',
    })
    await flush()

    const updatedSnapshot = stripAnsi(writes.join(''))
    expect(updatedSnapshot).toContain('已接入')
    expect(updatedSnapshot).toContain('个人空间')

    ttyIn.emit('keypress', 'q', { name: 'q' })
    await expect(done).resolves.toBe(0)
    expect(writes.at(-1)).toContain('\x1b[?25h\x1b[?1049l')
    expect(ttyIn.isRaw).toBe(false)
  })

  it('支持确认计划后进入浏览器授权弹出层（o/c 快捷键）并自动安装插件与握手验证', async () => {
    const { ttyIn, out, writes } = createFakeTty(104, 28)
    const opened: string[] = []
    const copied: string[] = []
    let finishConnect!: (
      res: Array<{ id: string; status: 'connected'; app: { name: string } }>,
    ) => void

    const installPlugin = vi.fn(async () => ({
      id: 'codex',
      status: 'installed' as const,
      message: '已安装 Codex 插件',
    }))
    const verifyConnectionHandshake = vi.fn(async () => ({
      ok: true,
      who: WHO('codex'),
      toolCount: 9,
    }))

    const deps: Partial<TuiDeps> = {
      defaultServerUrl: async () => 'https://kioku.example.com',
      serverHealth: async () => ({
        reachable: true,
        version: '0.4.2',
        problem: null,
        needsSetup: false,
      }),
      scanLocalPlatform: async (id) => ({
        row: {
          id,
          name: id === 'codex' ? 'Codex' : id,
          present: id === 'codex',
          connection: 'none',
          plugin: id === 'codex' ? false : null,
          memory: id === 'codex' ? 'on' : null,
        },
        config: null,
      }),
      connectPlatforms: async (_target, opts) => {
        const handle = await opts.authPrompt!({
          userCode: 'BCDF-GHJK',
          verificationUrl: 'https://kioku.example.com/authorize',
          expiresIn: 600,
          open: (u) => opened.push(u),
          browser: false,
          onCancel: () => {},
        })
        const res = await new Promise<
          Array<{ id: string; status: 'connected'; app: { name: string } }>
        >((r) => {
          finishConnect = r
        })
        handle.stop('授权完成')
        return res
      },
      installPlugin,
      verifyConnectionHandshake,
      open: (u) => opened.push(u),
      copy: async (text) => {
        copied.push(text)
        return { ok: true, method: 'native' }
      },
    }

    const emptyEnv = {
      HOME: '/tmp/kioku-tui-test-none',
      KIOKU_CONFIG_DIR: '/tmp/kioku-tui-test-none',
      CODEX_HOME: '/tmp/kioku-tui-test-none/codex',
    }
    const done = runTui({ env: emptyEnv, cwd: '/tmp', stdin: ttyIn, out, deps })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('Codex'))

    // Enter 触发接入 -> 弹出接入计划确认框 -> 按 y 确认
    ttyIn.emit('keypress', '\r', { name: 'return' })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('接入计划'))

    ttyIn.emit('keypress', 'y', { name: 'y' })
    await vi.waitFor(() => {
      const text = stripAnsi(writes.join(''))
      expect(text).toContain('B C D F - G H J K')
      expect(text).toContain('https://kioku.example.com/authorize')
    })

    // 浏览器授权弹出层响应 [o] 打开浏览器与 [c] 复制链接
    ttyIn.emit('keypress', 'o', { name: 'o' })
    ttyIn.emit('keypress', 'c', { name: 'c' })
    await vi.waitFor(() =>
      expect(copied).toEqual(['BCDF-GHJK', 'https://kioku.example.com/authorize']),
    )

    expect(opened).toEqual(['https://kioku.example.com/authorize'])

    finishConnect([{ id: 'codex', status: 'connected', app: { name: 'Codex' } }])
    await vi.waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith('codex', { env: emptyEnv, cwd: '/tmp' })
      expect(stripAnsi(writes.join(''))).toContain('已安装 Codex 插件')
    })

    ttyIn.emit('keypress', 'q', { name: 'q' })
    await expect(done).resolves.toBe(0)
  })

  it('按 d 收集诊断输出在右侧展示，按 u 预览并断开 Antigravity 托管插件', async () => {
    const { ttyIn, out, writes } = createFakeTty(104, 28)
    const setupCalls: string[][] = []
    const removeManagedAgyPlugin = vi.fn(async () => true)
    const doctorMock = vi.fn<TuiDeps['doctor']>(async (args, io) => {
      expect(args).toEqual(['agy'])
      expect(io?.out).toBeDefined()
      expect(io?.out).not.toBe(out)
      io?.out?.write('✓ Antigravity 配置正常\n')
      return 0
    })

    const deps: Partial<TuiDeps> = {
      defaultServerUrl: async () => 'https://kioku.example.com',
      serverHealth: async () => ({
        reachable: true,
        version: '0.4.2',
        problem: null,
        needsSetup: false,
      }),
      scanLocalPlatform: async (id) => ({
        row: {
          id,
          name: id === 'agy' ? 'Antigravity' : id,
          present: id === 'agy',
          connection: id === 'agy' ? 'ok' : 'none',
          plugin: id === 'agy' ? true : null,
          memory: id === 'agy' ? 'none' : null,
        },
        config: null,
      }),
      doctor: doctorMock,
      setup: async (args, io) => {
        setupCalls.push(args)
        io?.out?.write(args.includes('--dry-run') ? '将移除 mcpServers.kioku\n' : '✓ 已断开\n')
        return 0
      },
      removeManagedAgyPlugin,
    }

    const done = runTui({ env: {}, cwd: '/tmp', stdin: ttyIn, out, deps })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('Antigravity'))

    ttyIn.emit('keypress', 'd', { name: 'd' })
    await vi.waitFor(() => {
      expect(doctorMock).toHaveBeenCalledOnce()
      expect(stripAnsi(writes.join(''))).toContain('Antigravity 配置正常')
    })

    ttyIn.emit('keypress', 'u', { name: 'u' })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('确认断开 Antigravity'))

    ttyIn.emit('keypress', 'y', { name: 'y' })
    await vi.waitFor(() => {
      expect(setupCalls).toEqual([
        ['agy', '--undo', '--dry-run'],
        ['agy', '--undo'],
      ])
      expect(removeManagedAgyPlugin).toHaveBeenCalledOnce()
    })

    ttyIn.emit('keypress', 'q', { name: 'q' })
    await expect(done).resolves.toBe(0)
  })

  it('按 s 设置服务地址后会持久化到 cli.json 并保留 defaultPlatform，下次启动直接读回', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kioku-tui-url-'))
    try {
      const env = {
        HOME: tmp,
        KIOKU_CONFIG_DIR: join(tmp, 'kioku'),
        CODEX_HOME: join(tmp, 'codex'),
      }
      await writeCliPreferences({ defaultPlatform: 'codex' }, env)

      const { ttyIn, out, writes } = createFakeTty(104, 28)
      const deps: Partial<TuiDeps> = {
        serverHealth: async () => ({
          reachable: true,
          version: '0.4.2',
          problem: null,
          needsSetup: false,
        }),
        scanLocalPlatform: async (id) => ({
          row: {
            id,
            name: id === 'codex' ? 'Codex' : id,
            present: id === 'codex',
            connection: 'none',
            plugin: id === 'codex' ? false : null,
            memory: id === 'codex' ? 'on' : null,
          },
          config: null,
        }),
      }

      const done = runTui({ env, cwd: tmp, stdin: ttyIn, out, deps })
      await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('尚未设置服务地址'))

      ttyIn.emit('keypress', 's', { name: 's' })
      await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('设置服务地址'))

      for (const ch of 'https://kioku.example.com/') {
        ttyIn.emit('keypress', ch, { name: ch })
      }
      ttyIn.emit('keypress', '\r', { name: 'return' })

      await vi.waitFor(() =>
        expect(stripAnsi(writes.join(''))).toContain('已切换到 https://kioku.example.com'),
      )

      ttyIn.emit('keypress', 'q', { name: 'q' })
      await expect(done).resolves.toBe(0)

      expect(await readCliPreferences(env)).toEqual({
        defaultPlatform: 'codex',
        serverUrl: 'https://kioku.example.com',
      })
      expect(await defaultServerUrl(env)).toBe('https://kioku.example.com')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('detectPlatformPresence 区分桌面/IDE、仅配置残余，并避免 ~/.gemini 与 Antigravity 冲突', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kioku-presence-'))
    const emptyBin = join(tmp, 'empty-bin')
    mkdirSync(emptyBin, { recursive: true })
    const env = {
      HOME: tmp,
      USERPROFILE: tmp,
      LOCALAPPDATA: join(tmp, 'LocalAppData'),
      PATH: emptyBin,
      PATHEXT: '.EXE;.CMD;.BAT;.PS1',
    }
    try {
      mkdirSync(join(tmp, '.gemini', 'antigravity'), { recursive: true })
      mkdirSync(join(tmp, '.gemini', 'config'), { recursive: true })

      expect(await detectPlatformPresence('gemini', env)).toMatchObject({
        presence: 'absent',
        hasCli: false,
      })
      expect(await detectPlatformPresence('agy', env)).toMatchObject({
        presence: 'installed',
        installKind: 'desktop',
        hasCli: false,
      })

      writeFileSync(join(tmp, '.gemini', 'settings.json'), '{}', 'utf8')
      expect(await detectPlatformPresence('gemini', env)).toMatchObject({
        presence: 'config-only',
        hasCli: false,
      })

      mkdirSync(join(tmp, '.vscode', 'extensions', 'anthropic.claude-code-2.0.0'), {
        recursive: true,
      })
      expect(await detectPlatformPresence('claude-code', env)).toMatchObject({
        presence: 'installed',
        installKind: 'ide',
        hasCli: false,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('三态列表渲染：折叠未配置的仅残余配置、提示已连接但缺少程序，并仅默认勾选已安装客户端', async () => {
    const theme = createTheme({ color: false })
    const base = makeState({
      platforms: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          present: true,
          presence: 'config-only',
          hasCli: false,
          connection: 'ok',
          who: WHO('claudecode'),
          plugin: true,
          memory: 'off',
        },
        {
          id: 'codex',
          name: 'Codex',
          present: false,
          presence: 'absent',
          hasCli: false,
          connection: 'ok',
          who: WHO('codex'),
          plugin: true,
          memory: 'on',
        },
        {
          id: 'gemini',
          name: 'Gemini CLI',
          present: true,
          presence: 'config-only',
          hasCli: false,
          connection: 'none',
          plugin: null,
          memory: null,
        },
      ],
      selectedId: 'claude-code',
      showUninstalled: false,
    })

    const collapsed = stripAnsi(renderTuiFrame(base, 108, 28, theme).join('\n'))
    expect(collapsed).toContain('未找到程序')
    expect(collapsed).toContain('客户端不在')
    expect(collapsed).not.toContain('Gemini CLI')

    const expanded = stripAnsi(
      renderTuiFrame({ ...base, showUninstalled: true, selectedId: 'gemini' }, 108, 28, theme).join(
        '\n',
      ),
    )
    expect(expanded).toContain('Gemini CLI')
    expect(expanded).toContain('仅残余配置')

    const { ttyIn, out, writes } = createFakeTty(104, 28)
    const connectedTargets: unknown[] = []
    const deps: Partial<TuiDeps> = {
      defaultServerUrl: async () => 'https://kioku.example.com',
      serverHealth: async () => ({
        reachable: true,
        version: '0.4.2',
        problem: null,
        needsSetup: false,
      }),
      scanLocalPlatform: async (id) => {
        if (id === 'codex') {
          return {
            row: {
              id,
              name: 'Codex',
              present: true,
              presence: 'installed',
              installKind: 'cli',
              hasCli: true,
              connection: 'none',
              plugin: false,
              memory: 'on',
            },
            config: null,
          }
        }
        if (id === 'claude-code') {
          return {
            row: {
              id,
              name: 'Claude Code',
              present: true,
              presence: 'installed',
              installKind: 'ide',
              hasCli: false,
              connection: 'none',
              plugin: false,
              memory: null,
            },
            config: null,
          }
        }
        if (id === 'gemini') {
          return {
            row: {
              id,
              name: 'Gemini CLI',
              present: true,
              presence: 'config-only',
              hasCli: false,
              connection: 'none',
              plugin: null,
              memory: null,
            },
            config: null,
          }
        }
        return {
          row: {
            id,
            name: id,
            present: false,
            presence: 'absent',
            hasCli: false,
            connection: 'none',
            plugin: null,
            memory: null,
          },
          config: null,
        }
      },
      connectPlatforms: async (target) => {
        connectedTargets.push(target)
        return []
      },
    }

    const done = runTui({
      env: { HOME: '/tmp/kioku-batch-test', KIOKU_CONFIG_DIR: '/tmp/kioku-batch-test' },
      cwd: '/tmp',
      stdin: ttyIn,
      out,
      deps,
    })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('Codex'))

    ttyIn.emit('keypress', 'a', { name: 'a' })
    await vi.waitFor(() => {
      const text = stripAnsi(writes.join(''))
      expect(text).toContain('编辑器扩展')
      expect(text).toContain('仅发现配置，未找到程序')
    })

    ttyIn.emit('keypress', '\r', { name: 'return' })
    await vi.waitFor(() => expect(stripAnsi(writes.join(''))).toContain('接入计划'))
    ttyIn.emit('keypress', 'y', { name: 'y' })
    await vi.waitFor(() => expect(connectedTargets.length).toBeGreaterThan(0))
    expect(connectedTargets[0]).toEqual({
      url: 'https://kioku.example.com',
      ids: ['claude-code', 'codex'],
    })

    ttyIn.emit('keypress', 'q', { name: 'q' })
    await expect(done).resolves.toBe(0)
  })
})
