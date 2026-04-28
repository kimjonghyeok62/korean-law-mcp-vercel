/**
 * 별표 파일 파서 — kordoc 위임
 *
 * HWPX/HWP5/PDF 모두 kordoc 통합 파서에 위임.
 * kordoc은 colAddr/rowAddr 기반 HWP5 셀 배치, PDF 라인+클러스터 이중 테이블 감지,
 * ZIP bomb 방지, 깨진 ZIP 복구 등 강화된 파싱 기능을 제공.
 *
 * @see https://github.com/chrisryugj/kordoc
 */

import { parse } from "kordoc"
import type { ParseResult, FileType } from "kordoc"

// ─── 인터페이스 ───────────────────────────────────────

/** 마크다운 표에서 추출한 구조화 데이터 (수치 계산 보조용) */
export interface TableData {
  headers: string[]
  rows: string[][]
}

export interface AnnexParseResult {
  success: boolean
  markdown?: string
  /** 마크다운 표를 JSON으로 구조화한 데이터 — LLM 수치 계산 보조 */
  tables?: TableData[]
  fileType: FileType
  /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
  isImageBased?: boolean
  /** PDF 페이지 수 */
  pageCount?: number
  error?: string
}

// ─── 표 파싱 헬퍼 ─────────────────────────────────────

function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map(cell => cell.trim())
}

/**
 * 마크다운에서 표 블록을 JSON으로 추출.
 * | 헤더1 | 헤더2 |
 * |-------|-------|
 * | 값1   | 값2   |
 * 형태의 GFM 표를 파싱.
 */
function extractTablesAsJson(markdown: string): TableData[] {
  const tables: TableData[] = []
  const lines = markdown.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trim()
    // 헤더 행 후보: | 로 시작·끝, 구분자 행이 바로 다음에 오는지 확인
    if (
      line.startsWith("|") && line.endsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s\-:|]+\|/.test(lines[i + 1].trim())
    ) {
      const headers = parseTableRow(line)
      const rows: string[][] = []
      let j = i + 2  // 구분자 행 건너뜀
      while (j < lines.length) {
        const rowLine = lines[j].trim()
        if (rowLine.startsWith("|") && rowLine.endsWith("|")) {
          rows.push(parseTableRow(rowLine))
          j++
        } else {
          break
        }
      }
      if (headers.length > 0 && rows.length > 0) {
        tables.push({ headers, rows })
      }
      i = j
      continue
    }
    i++
  }
  return tables
}

// ─── 메인 엔트리 ─────────────────────────────────────

export async function parseAnnexFile(buffer: ArrayBuffer): Promise<AnnexParseResult> {
  const result: ParseResult = await parse(buffer)

  if (result.success) {
    return {
      success: true,
      fileType: result.fileType,
      markdown: result.markdown,
      tables: result.markdown ? extractTablesAsJson(result.markdown) : [],
    }
  }

  return {
    success: false,
    fileType: result.fileType,
    isImageBased: result.isImageBased,
    pageCount: result.pageCount,
    error: result.error,
  }
}
