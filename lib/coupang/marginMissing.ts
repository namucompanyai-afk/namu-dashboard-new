/**
 * 광고 전환으로 팔렸는데 나무_마스터 '마진계산'에 옵션 행이 없는 상품 — 알림 + 마진계산 붙여넣기 줄 (순수 함수).
 *
 * 2026-10-19 대표 지시: 마진계산에 없으면 매출·마진이 0 으로 잡혀 BEP 미달 판정이 과해진다 → 알려서 사람이 넣게.
 * 잡는 조건: 판매수량(14일) ≥ 1 이고 전환 옵션ID 가 마진계산 3P 행(X 옵션ID)에도 1P 행(X 옵션ID)에도 없음. 옵션 단위로 합침.
 * (3P 광고 → 같은 상품 1P 구매는 1P 행에 있으므로 여기 안 잡힘 — adAnalysis 가 1P 마진으로 셈)
 * 빠진 매출(lostRevenue)은 3P 캠페인 행 분만 — 1P 캠페인 행은 옵션 행이 없어도 상품명으로 SKU 에 연결돼 매출·1봉 마진이 잡힌다.
 *
 * 붙여넣기 줄 = 마진계산 A~AD 30칸 TSV. 입력 칸만 채운다:
 *   A 채널 · B 별칭 · C 봉수 · W 노출ID(3P) · X 옵션ID · Y 1P 상품코드(1P) · AD 쿠팡 옵션명. D 판매가는 비움(실판매가는 사람이 확인)
 *   나머지(F~T·Z~AC)는 행마다 수식 — 맨 아래 빈 행에 붙여넣은 뒤 위 행 수식을 아래로 채워야 계산됨.
 * 별칭은 원가 조회 키(단가DB)라 추측하지 않고 같은 노출ID 3P 행 또는 같은 상품(1P SKU) 행의 별칭을 그대로 쓴다. 못 찾으면 비움.
 * 봉수: 별칭에 'N개'가 있으면(예: '즉석밥 6개' = 6개 봉지) 상품명 개수 ÷ N (12개 → 2봉, 18개 → 3봉 — 2026-10-19 대표 확인).
 * 채널: 윙 스냅샷(3P 전체 옵션)에 있으면 3P, 없으면 1P (윙 스냅샷을 못 읽었을 땐 1P 연결이 될 때만 1P, 아니면 빈칸).
 */
import type { AdCampaignRow } from './parsers/adCampaign'
import type { CostMaster } from './parsers/marginMaster'
import { isRetailRow, make1PLinker } from './onePAnalysis'

export type MarginMissingOption = {
  optionId: string
  name: string // 광고전환매출발생 상품명 (엑셀)
  sold: number // 판매수량(14일) 합
  revenue: number // 총 전환매출액(14일) 합 — 쿠팡 값
  lostRevenue: number // 그중 광고 분석에서 0 으로 빠진 매출 = 3P 캠페인 행 분 (1P 캠페인 행은 상품명으로 SKU 1봉 마진에 연결돼 계산됨)
  campaigns: string[]
  channel: '쿠팡 3P' | '쿠팡 1P' | '' // 붙여넣을 채널 (모르면 '')
  alias: string // 같은 상품 기존 행 별칭 (모르면 '')
  bagCount: number | null // 상품명의 'N개'
  exposureId: string // 3P 노출ID (윙 스냅샷에서, 모르면 '')
  sku: string // 1P 상품코드 (모르면 '')
}

/** '…,1kg,1kg,3개,3개' / '…,5개,5개,1kg,1kg' → 3 / 5 */
export function bagCountOf(name: string): number | null {
  const m = String(name || '').match(/(?:^|[,\s])(\d+)\s*개(?=$|[,\s])/)
  return m ? Number(m[1]) : null
}

/**
 * @param master 마진계산 원본(augmentMasterWith1P 전) — 1P 합성 행이 섞이면 '시트에 있음'으로 잘못 볼 수 있음
 * @param pidByOption 윙 스냅샷(coupang_catalog_YYYY-MM-DD) 옵션ID → 노출상품ID. 없으면 빈 Map
 */
export function findMarginMissing(
  rows: AdCampaignRow[] | null,
  master: CostMaster | null,
  pidByOption: Map<string, string> = new Map(),
): MarginMissingOption[] {
  if (!rows?.length || !master) return []
  const sheet3P = new Set(master.marginRows.filter((r) => r.saleChannel !== '1P').map((r) => String(r.optionId).trim()))
  const one = master.onePRows || []
  const sheet1P = new Set(one.map((x) => String(x.optionId || '').trim()).filter(Boolean))
  const aliasByPid = new Map<string, string>()
  for (const r of master.marginRows) if (r.saleChannel !== '1P' && r.exposureId && !aliasByPid.has(r.exposureId)) aliasByPid.set(r.exposureId, r.alias)
  const linker = one.length ? make1PLinker(rows.filter(isRetailRow), one, master.marginRows) : null

  const by = new Map<string, MarginMissingOption>()
  for (const r of rows) {
    const id = String(r.convOptionId || '').trim()
    if (!id || !((r.sold14d || 0) > 0) || sheet3P.has(id) || sheet1P.has(id)) continue
    let e = by.get(id)
    if (!e) {
      const name = String(r.convProductName || '').trim()
      const pid = pidByOption.get(id) ?? ''
      // 1P 로 보이는지 — 전환 상품명이 1P 로 연결된 다른 행 이름과 같으면 그 SKU (onePAnalysis 와 같은 연결 규칙)
      const link = linker?.linkOf({ ...r, convOptionId: id, adOptionId: '', adProductName: '' } as AdCampaignRow)
      const oneP = link && link.kind === '1P' ? link : null
      const alias = pid ? aliasByPid.get(pid) ?? '' : oneP?.alias ?? ''
      const count = bagCountOf(name)
      const pack = Number(alias.match(/(\d+)\s*개/)?.[1] ?? 0) // 별칭의 'N개' = 1봉에 든 개수
      e = {
        optionId: id,
        name,
        sold: 0,
        revenue: 0,
        lostRevenue: 0,
        campaigns: [],
        channel: pid ? '쿠팡 3P' : oneP || pidByOption.size > 0 ? '쿠팡 1P' : '',
        alias,
        bagCount: count != null && pack > 1 && count % pack === 0 ? count / pack : count,
        exposureId: pid,
        sku: !pid && oneP ? oneP.sku ?? '' : '',
      }
      by.set(id, e)
    }
    e.sold += r.sold14d || 0
    e.revenue += r.revenue14d || 0
    if (!isRetailRow(r)) e.lostRevenue += r.revenue14d || 0
    if (r.campaignName && !e.campaigns.includes(r.campaignName)) e.campaigns.push(r.campaignName)
  }
  return [...by.values()].sort((a, b) => b.revenue - a.revenue)
}

const COLS = 30 // 마진계산 A~AD
const col = (letter: string) => (letter.length === 1 ? letter.charCodeAt(0) - 65 : 26 + letter.charCodeAt(1) - 65)

/** 마진계산 A~AD 한 줄 (탭 구분) — 입력 칸만, 수식 칸은 비움 */
export function marginRowTsv(o: MarginMissingOption): string {
  const cells = new Array<string>(COLS).fill('')
  cells[col('A')] = o.channel
  cells[col('B')] = o.alias
  cells[col('C')] = o.bagCount != null ? String(o.bagCount) : ''
  cells[col('W')] = o.exposureId
  cells[col('X')] = o.optionId
  cells[col('Y')] = o.sku
  cells[col('AD')] = o.name
  return cells.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')
}
