// 集中引入 packages/core 的零依赖运行时，让 CLI 模块只通过这一处与核心运行时耦合，
// 也方便 TypeScript 严格检查与 tsdown 单包打包。

export {
  DATABASE_UNAVAILABLE_CODE,
  INVALID_KEY_TEXT,
  KeyRejected,
  KiokuFailure,
  LEGACY_DATABASE_CODE,
  LEGACY_KEY_CODE,
  LEGACY_KEY_TEXT,
  LegacyDatabase,
  errorCodeOf,
  errorKind,
  failureText,
  fetchFailure,
  isRedirect,
  keyFormatError,
  legacyDatabaseText,
  redirectError,
  rejectionOf,
} from '../../core/lib/http.mjs'

export {
  profileDir,
  profileFile,
  readProfile,
  removeProfile,
  serverUrlProblem,
  writeProfile,
} from '../../core/lib/profile.mjs'

export { NotConfigured, loadConfig } from '../../core/lib/config.mjs'
export { plain, shownUrl } from '../../core/lib/text.mjs'
export { UsageError } from '../../core/lib/usage.mjs'

import { capture as coreCapture } from '../../core/lib/command.mjs'
import type { Env } from './types.ts'

export { envValue, findCommand, hasCommand, killTree, launch } from '../../core/lib/command.mjs'

export interface CaptureResult {
  found: boolean
  ok: boolean
  stdout: string
  stderr: string
  output: string
}

export function capture(
  name: string,
  args: string[],
  env: Env,
  options?: { timeout?: number; maxBuffer?: number },
): Promise<CaptureResult> {
  return (
    coreCapture as unknown as (
      n: string,
      a: string[],
      e: Env,
      o?: { timeout?: number; maxBuffer?: number },
    ) => Promise<CaptureResult>
  )(name, args, env, options)
}

export {
  TOOLS_TIMEOUT,
  TOOL_CALL_TIMEOUT,
  callTool,
  listTools,
  mcpCall,
  readToolCacheSync,
  removeToolCache,
  toolCacheFile,
  toolsOf,
  writeToolCache,
} from '../../core/lib/mcp.mjs'

export { USAGE as RUN_USAGE, parseRunArgs, run } from '../../core/lib/run.mjs'
