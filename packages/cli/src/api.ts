// kioku 命令向 Kioku 发的核对请求：服务端的接口代际（健康检查），以及访问密钥对应的接入实例（whoami）

import {
  KeyRejected,
  KiokuFailure,
  errorCodeOf,
  failureText,
  fetchFailure,
  isRedirect,
  LEGACY_DATABASE_CODE,
  legacyDatabaseText,
  plain,
  redirectError,
  rejectionOf,
  shownUrl,
} from './core.ts'
import type { TargetConfig, WhoamiResponse } from './types.ts'

export { KeyRejected }

const TIMEOUT = 8000
const PROBE_TIMEOUT = 5000

// 这个命令行能接的服务端接口代际：记忆圈重构换了一代，接口与访问密钥都不兼容上一代
export const SUPPORTED_API = 2

// 服务端的现状：
// - generation：接口代际，健康检查里没有 api 字段的旧服务端按 1 算；连不上、认不出是 Kioku 时为 null
// - state：ok 正常；legacy 服务端已升级、库还是旧结构，等管理员迁移；unavailable 数据库暂时连不上；
//   unreachable 连不上、返回跳转或者不像 Kioku（原因在 problem）
export interface ServerProbe {
  generation: number | null
  state: 'ok' | 'legacy' | 'unavailable' | 'unreachable'
  version: string | null
  problem?: string
}

async function readHealth(
  url: string,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response
  let data: Record<string, unknown> | null
  try {
    res = await fetch(`${url}/v1/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    })
    data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, PROBE_TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  return { status: res.status, data: data && typeof data === 'object' ? data : null }
}

// 读健康检查，判断服务端的代际与现状。不要访问密钥，不抛错：连不上时 state 为 unreachable
export async function probeServer(url: string): Promise<ServerProbe> {
  let answer
  try {
    answer = await readHealth(url)
  } catch (err) {
    return { generation: null, state: 'unreachable', version: null, problem: failureText(err) }
  }
  const { status, data } = answer
  const version = typeof data?.version === 'string' && data.version ? plain(data.version) : null
  const api = data?.api
  const generation = typeof api === 'number' && Number.isInteger(api) && api > 0 ? api : 1
  if (status === 200 && data?.status === 'ok') return { generation, state: 'ok', version }
  if (status === 503 && data) {
    const legacy = data.database === 'legacy' || errorCodeOf(data) === LEGACY_DATABASE_CODE
    return { generation, state: legacy ? 'legacy' : 'unavailable', version }
  }
  return {
    generation: null,
    state: 'unreachable',
    version: null,
    problem: `不像 Kioku（HTTP ${status}）`,
  }
}

export function olderServerText(version: string | null): string {
  return `服务端是记忆圈重构之前的版本（${version ?? '版本未知'}），这个命令行需要新版服务端：先升级服务端（升级后在管理界面按引导一键迁移），或者暂时使用 npx @kioku-memory/cli@0.5`
}

export function newerServerText(generation: number): string {
  return `服务端的接口是第 ${generation} 代，比这个命令行新：升级命令行（npx @kioku-memory/cli@latest）`
}

export const UNAVAILABLE_TEXT = 'Kioku 的数据库暂时无法连接：稍后再试，或者让管理员查看服务端日志'

// 这个服务端不能直接接的原因（代际不对、库待迁移）；能接、或者连不上（由后面的请求报）时为 null
export function generationProblem(probe: ServerProbe, url: string): string | null {
  if (probe.state === 'unreachable' || probe.generation === null) return null
  if (probe.generation < SUPPORTED_API) return olderServerText(probe.version)
  if (probe.generation > SUPPORTED_API) return newerServerText(probe.generation)
  if (probe.state === 'legacy') return legacyDatabaseText(url)
  return null
}

// 服务端的代际或现状不对：报错里写清下一步，不报成「响应格式不对」或「HTTP 503」
export class ServerMismatch extends KiokuFailure {
  probe: ServerProbe
  constructor(message: string, probe: ServerProbe) {
    super(message)
    this.probe = probe
  }
}

// 走服务端的入口先调它：代际不对、库待迁移、数据库连不上时抛 ServerMismatch；连不上的交给后面的请求去报
export async function assertServerSupported(url: string): Promise<ServerProbe> {
  const probe = await probeServer(url)
  const problem = generationProblem(probe, url)
  if (problem) throw new ServerMismatch(problem, probe)
  if (probe.state === 'unavailable') throw new ServerMismatch(UNAVAILABLE_TEXT, probe)
  return probe
}

// 请求失败之后再看一眼健康检查：是代际或库的问题就换成那个说法，否则用原来的失败
async function explained(url: string, fallback: KiokuFailure): Promise<KiokuFailure> {
  const probe = await probeServer(url)
  const problem = generationProblem(probe, url)
  return problem ? new ServerMismatch(problem, probe) : fallback
}

// 这个访问密钥对应的接入实例与权限；连不上、跳转、访问密钥无效、响应不对都以 KiokuFailure 抛出。
// 访问密钥被拒时抛 KeyRejected（legacy 为真时是升级前签发的）；响应不对时先看服务端的代际
export async function whoami({ url, key }: TargetConfig): Promise<WhoamiResponse> {
  let res: Response
  let data: unknown
  try {
    res = await fetch(`${url}/v1/whoami`, {
      headers: { authorization: `Bearer ${key}` },
      // 不跟着跳转走：访问密钥只发给配置的地址
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    data = await res.json().catch(() => null)
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  const rejected = res.ok ? null : rejectionOf(res.status, data, url)
  if (rejected) throw rejected
  if (!res.ok) throw await explained(url, new KiokuFailure(`Kioku 返回 HTTP ${res.status}`))
  const record = data as Partial<WhoamiResponse> | null
  if (
    typeof record?.client?.runtimeFamily !== 'string' ||
    typeof record?.client?.slug !== 'string' ||
    typeof record?.client?.name !== 'string' ||
    typeof record?.primaryCircle?.id !== 'string' ||
    typeof record?.primaryCircle?.slug !== 'string' ||
    typeof record?.primaryCircle?.name !== 'string' ||
    (record.linkedCircles !== undefined && !Array.isArray(record.linkedCircles)) ||
    !record.scopes ||
    typeof record.scopes !== 'object' ||
    Array.isArray(record.scopes) ||
    (record.scopes.readKinds !== undefined && !Array.isArray(record.scopes.readKinds)) ||
    (record.scopes.writeKinds !== undefined && !Array.isArray(record.scopes.writeKinds))
  ) {
    throw await explained(url, new KiokuFailure('Kioku 的响应格式不对'))
  }
  return {
    ...(record as WhoamiResponse),
    linkedCircles: Array.isArray(record.linkedCircles) ? record.linkedCircles : [],
  }
}

// 地址只给协议、主机与路径，给提示文字用
export function upgradePageOf(url: string): string {
  return `${shownUrl(url)}/legacy-upgrade`
}
