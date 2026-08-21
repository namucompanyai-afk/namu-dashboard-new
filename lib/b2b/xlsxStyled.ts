/**
 * 서식 있는 xlsx 생성기 (노란 헤더 + 굵게 + 전체 테두리).
 *
 * SheetJS 커뮤니티 빌드는 채우기/테두리 같은 셀 서식을 **쓰지** 못한다(읽기만 가능).
 * 필요한 서식이 헤더 1행 + 전체 테두리로 단순해서, 이미 의존성에 있는 jszip 으로
 * 최소 OOXML 을 직접 만든다(새 의존성 없음).
 */
import JSZip from 'jszip'

export type CellValue = string | number | null | undefined

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

/** 0-based 열 인덱스 → A, B, … Z, AA */
export function colName(i: number): string {
  let s = ''
  let n = i
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return s
}

const isNum = (v: CellValue): v is number => typeof v === 'number' && Number.isFinite(v)

// s=1 헤더(굵게·노랑·테두리·가운데), s=2 본문(테두리)
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="맑은 고딕"/></font>
<font><b/><sz val="11"/><name val="맑은 고딕"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

// 시트명 제한: 31자 · : \ / ? * [ ] 금지
function safeSheetName(name: string): string {
  const s = String(name || 'Sheet1').replace(/[:\\/?*[\]]/g, ' ').trim()
  return (s || 'Sheet1').slice(0, 31)
}

function sheetXml(rows: CellValue[][], widths: number[]): string {
  const cols = widths.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === null || v === undefined || v === '') return ''
          const ref = `${colName(c)}${r + 1}`
          const s = r === 0 ? 1 : 2
          return isNum(v)
            ? `<c r="${ref}" s="${s}"><v>${v}</v></c>`
            : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join('')

  const lastCol = colName(Math.max(1, rows.reduce((m, r) => Math.max(m, r.length), 0)) - 1)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${Math.max(1, rows.length)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}<sheetData>${body}</sheetData>
</worksheet>`
}

/** 행 배열(0행 = 헤더) → xlsx Blob. widths 는 열 너비(문자 수) */
export async function buildStyledXlsx(
  sheetName: string,
  rows: CellValue[][],
  widths: number[] = [],
): Promise<Blob> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', ROOT_RELS)
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  )
  zip.file('xl/_rels/workbook.xml.rels', WB_RELS)
  zip.file('xl/styles.xml', STYLES)
  zip.file('xl/worksheets/sheet1.xml', sheetXml(rows, widths))
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** Blob 파일 저장 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
