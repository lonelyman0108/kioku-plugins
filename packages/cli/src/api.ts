// kioku 命令向 Kioku 发的核对请求

import { KiokuFailure, fetchFailure, isRedirect, redirectError } from './core.ts'
import type { TargetConfig, WhoamiResponse } from './types.ts'

const TIMEOUT = 8000

// 服务端明说访问密钥不能用（401）：和连不上、响应不对分开，向导据此标「已失效」
export class KeyRejected extends KiokuFailure {}

// 这个访问密钥对应的应用与权限；连不上、跳转、访问密钥无效、响应不对都以 KiokuFailure 抛出
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
  if (res.status === 401) throw new KeyRejected('访问密钥无效或已吊销')
  if (!res.ok) throw new KiokuFailure(`Kioku 返回 HTTP ${res.status}`)
  const record = data as Partial<WhoamiResponse> | null
  if (
    typeof record?.app?.runtimeFamily !== 'string' ||
    record.scopes === null ||
    typeof record.scopes !== 'object'
  ) {
    throw new KiokuFailure('Kioku 的响应格式不对')
  }
  return record as WhoamiResponse
}
