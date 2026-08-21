/**
 * 발주 요약 집계 (상품별).
 *
 * 금액은 발주 파일의 공급단가/공급가를 **그대로** 쓴다 —
 * 상품마스터의 컬리 공급가로 재계산하지 않는다(프로모션 할인이 반영된 실제 발주 금액이 파일에 있음).
 */
import type { KurlyOrderRow, ProductMaster } from './kurly'
import { norm } from './kurly'

export type ProductSummaryRow = {
  masterCode: string
  name: string // 상품마스터 별칭(없으면 발주 파일 상품명)
  boxes: number
  units: number
  unitPrices: number[] // 파일에 나타난 공급단가들 (보통 1개, 행마다 다르면 여러 개)
  supplyTotal: number
}

export type OrderSummary = {
  rows: ProductSummaryRow[]
  totalBoxes: number
  totalUnits: number
  totalSupply: number
}

/** 마스터코드 단위 합산 (등장 순서 유지) */
export function summarizeOrders(
  orders: KurlyOrderRow[],
  masterByCode: Record<string, ProductMaster>,
): OrderSummary {
  const byCode = new Map<string, ProductSummaryRow>()
  for (const o of orders) {
    const key = norm(o.masterCode)
    let r = byCode.get(key)
    if (!r) {
      r = {
        masterCode: o.masterCode,
        name: masterByCode[key]?.alias || o.productName || o.masterCode,
        boxes: 0,
        units: 0,
        unitPrices: [],
        supplyTotal: 0,
      }
      byCode.set(key, r)
    }
    r.boxes += o.boxCount
    r.units += o.totalUnits
    r.supplyTotal += o.supplyTotal
    if (o.supplyUnit > 0 && !r.unitPrices.includes(o.supplyUnit)) r.unitPrices.push(o.supplyUnit)
  }

  const rows = [...byCode.values()]
  return {
    rows,
    totalBoxes: rows.reduce((s, r) => s + r.boxes, 0),
    totalUnits: rows.reduce((s, r) => s + r.units, 0),
    totalSupply: rows.reduce((s, r) => s + r.supplyTotal, 0),
  }
}
