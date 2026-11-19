// CLI 各模块共用的结构定义

export type Env = Record<string, string | undefined>

export type PlatformPresence = 'installed' | 'config-only' | 'absent'
export type PlatformInstallKind = 'cli' | 'desktop' | 'ide'

export interface Writer {
  write(chunk: string | Uint8Array): unknown
}

export interface Reader extends AsyncIterable<Buffer | string> {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
  resume?: () => void
  pause?: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface TargetConfig {
  url: string
  key: string
}

export interface SavedProfile extends TargetConfig {
  file: string
}

export interface WhoamiCircle {
  id: string
  slug: string | null
  name: string | null
  kind: 'personal' | 'shared'
}

export interface WhoamiLinkedCircle extends WhoamiCircle {
  mode: 'read' | 'read_write'
}

export interface WhoamiResponse {
  primaryCircle: {
    id: string
    slug: string
    name: string
    kind: 'personal' | 'shared'
  }
  linkedCircles: WhoamiLinkedCircle[]
  accountName?: string
  client: {
    id: string
    circleId: string
    slug: string
    name: string
    runtimeFamily: string
    ownerAccountId?: string
    defaultPersonaId?: string | null
    config?: {
      elevateOwnerDirect?: 'internal'
      personMemoryMode?: 'persona_shared' | 'strict'
      recordPrompt?: boolean
    }
  }
  persona: {
    id: string
    slug: string
    name: string
  } | null
  contextFacets?: Record<string, string[]>
  resolvedFacets?: Record<string, string[]>
  vocabulary?: Array<{
    key: string
    name: string
    matchMode: 'exclusive' | 'additive'
    terms: Array<{ slug: string; label: string }>
  }>
  scopes: {
    readKinds?: string[]
    writeKinds?: string[]
    maxSensitivity?: string
    allowedRealms?: string[] | null
    admin?: boolean
    credentials?: string
  }
}

export interface PlatformStatus {
  plugin: boolean | null
  memory: 'on' | 'off' | 'none' | null
  reenabledIn?: string | null
}

export interface InstallGuide {
  where?: string
  commands: string[]
  after: string
}

export interface InspectCallbacks {
  ok: (text: string) => void
  warn: (text: string) => void
  bad: (text: string) => void
  note: (text: string) => void
}

export interface SetupOptions {
  dryRun: boolean
  undo: boolean
  check: boolean
  serverUrl?: string
  removeConflicts?: boolean
  requireTarget?: boolean
  platform?: string
}

export interface SetupIo {
  env: Env
  out: Writer
  cwd: string
  stdin?: Reader
  readKey?: (opts: { env: Env; canLogin?: boolean; hasSaved?: boolean }) => Promise<string>
  plain?: (value: unknown) => string
  login?: ((opts: { url: string; id: string }) => Promise<string>) | null
  hints?: boolean
  beforeLogin?: () => Promise<void>
  readSaved?: () => Promise<SavedProfile | null>
}

export interface PlatformDescriptor {
  name: string
  runtimeFamily: string
  command: (env: Env) => string
  home: (env: Env) => string
  status: (ctx: { env: Env; cwd: string }) => Promise<PlatformStatus>
  install: InstallGuide
  source?: string
  detect: (env: Env) => boolean
  readConfig?: (env: Env) => Promise<SavedProfile | null>
  setup?: (options: SetupOptions, io: SetupIo) => Promise<number>
  preflight?: (ctx: { env: Env; cwd?: string }) => Promise<void>
  inspect?: (ctx: { env: Env; cwd: string }, callbacks: InspectCallbacks) => Promise<void>
}
