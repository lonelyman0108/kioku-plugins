// kioku 命令向 Kioku 发的核对请求

import { fetchFailure, isRedirect, KiokuFailure, redirectError } from './http.mjs'

const TIMEOUT = 8000

// 这个访问密钥对应的应用与权限；连不上、跳转、访问密钥无效、响应不对都以 KiokuFailure 抛出
export async function whoami({ url, key }) {
  let res
  let data
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
  if (res.status === 401) throw new KiokuFailure('访问密钥无效或已吊销')
  if (!res.ok) throw new KiokuFailure(`Kioku 返回 HTTP ${res.status}`)
  if (
    typeof data?.app?.runtimeFamily !== 'string' ||
    data.scopes === null ||
    typeof data.scopes !== 'object'
  ) {
    throw new KiokuFailure('Kioku 的响应格式不对')
  }
  return data
}
