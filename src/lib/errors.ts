/**
 * 통일된 에러 처리 모듈
 */

import type { ToolResponse } from "./types.js"

/**
 * 에러 코드
 */
export const ErrorCodes = {
  NOT_FOUND: "LAW_NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "REQUEST_TIMEOUT",
  PARSE_ERROR: "PARSE_ERROR",
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

/**
 * 법제처 API 에러
 */
export class LawApiError extends Error {
  code: ErrorCode
  suggestions: string[]

  constructor(message: string, code: ErrorCode, suggestions: string[] = []) {
    super(message)
    this.name = "LawApiError"
    this.code = code
    this.suggestions = suggestions
  }

  format(): string {
    let result = `[ERROR] ${this.message}`
    if (this.suggestions.length > 0) {
      result += "\n제안:"
      this.suggestions.forEach((s, i) => {
        result += `\n  ${i + 1}. ${s}`
      })
    }
    return result
  }
}

/**
 * 도구 에러 응답 생성 -- 구조화된 포맷
 *
 * 출력 형식:
 *   ❌ [에러코드] 메시지
 *   🔧 도구: <toolName>
 *   💡 제안: ...
 */
/**
 * 검색 결과 없음 힌트 생성
 * 법제처 API는 공백 키워드를 AND 조건으로 처리하므로, 키워드가 많으면 결과가 0건이 되기 쉬움
 */
export function noResultHint(query: string, label?: string): ToolResponse {
  const prefix = label ? `${label} ` : ""
  const keywords = query.trim().split(/\s+/)
  const lines = [`${prefix}'${query}' 검색 결과가 없습니다.`]

  if (keywords.length >= 2) {
    lines.push("")
    lines.push("힌트: 법제처 API는 공백 구분 키워드를 AND 조건으로 처리합니다. 키워드가 많을수록 결과가 줄어듭니다.")
    lines.push(`재시도 제안: "${keywords[0]}" 또는 "${keywords.slice(0, 2).join(" ")}"`)
  } else {
    lines.push("다른 키워드로 재시도하세요.")
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  }
}

export function formatToolError(error: unknown, context?: string): ToolResponse {
  let code: string
  let msg: string
  let suggestions: string[]

  if (error instanceof LawApiError) {
    code = error.code || ErrorCodes.API_ERROR
    msg = error.message
    suggestions = error.suggestions || []
  } else if (error instanceof Error) {
    // Zod validation 에러 감지
    if (error.name === "ZodError" && Array.isArray((error as any).issues)) {
      code = ErrorCodes.INVALID_PARAM
      msg = (error as any).issues
        .map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      suggestions = ["파라미터 형식과 필수 값을 확인하세요."]
    } else {
      code = ErrorCodes.API_ERROR
      msg = error.message
      suggestions = []
    }
  } else {
    code = ErrorCodes.API_ERROR
    msg = String(error)
    suggestions = []
  }

  const lines: string[] = []
  lines.push(`[${code}] ${msg}`)

  if (context) {
    lines.push(`도구: ${context}`)
  }

  if (suggestions.length > 0) {
    lines.push("제안:")
    suggestions.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s}`)
    })
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  }
}

