/**
 * 발주 요약 집계 (상품별).
 *
 * 금액 기준은 발주 파일의 공급단가/공급가를 **그대로** 쓴다 —
 * 상품마스터의 컬리 공급가로 재계산하지 않는다(프로모션 할인이 반영된 실제 발주 금액이 파일에 있음).
 * 파일 값은 VAT 별도이므로, 상품마스터의 '과세 구분'을 컬리 마스터 코드로 lookup 해
 * 과세 상품만 ×1.1(원 단위 반올림)한 부가포함 금액을 함께 낸다.
 */
import type { KurlyOrderRow, ProductMaster } from './kurly'
import { norm } from './kurly'

export type ProductSummaryRow = {
  masterCode: string
  name: string // 상품마스터 별칭(없으면 발주 파일 상품명)
  boxes: number
  units: number
  unitPrices: number[] // 파일 공급단가 (VAT 별도, 행마다 다르면 여러 개)
  unitPricesIncl: number[] // 부가포함 공급단가
  supplyTotal: number // 파일 공급가 합 (VAT 별도)
  supplyTotalIncl: number // 부가포함 공급가 합
  taxType: string // 상품마스터 과세 구분 ('' = 미확인)
  taxable: boolean
  taxKnown: boolean // false 면 면세로 처리하고 화면에 '과세구분 미확인' 표시
}

export type OrderSummary = {
  rows: ProductSummaryRow[]
  totalBoxes: number
  totalUnits: number
  totalSupply: number // VAT 별도 합
  totalSupplyIncl: number // 부가포함 합
}

/** 과세면 ×1.1 원 단위 반올림, 면세는 그대로 */
export const withVat = (amount: number, taxable: boolean): number =>
  taxable ? Math.round(amount * 1.1) : amount

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
      const m = masterByCode[key]
      const taxType = m?.taxType || ''
      r = {
        masterCode: o.masterCode,
        name: m?.alias || o.productName || o.masterCode,
        boxes: 0,
        units: 0,
        unitPrices: [],
        unitPricesIncl: [],
        supplyTotal: 0,
        supplyTotalIncl: 0,
        taxType,
        taxable: taxType.includes('과세'), // 마스터 미등록·빈칸이면 면세 취급
        taxKnown: taxType !== '',
      }
      byCode.set(key, r)
    }
    r.boxes += o.boxCount
    r.units += o.totalUnits
    r.supplyTotal += o.supplyTotal
    if (o.supplyUnit > 0 && !r.unitPrices.includes(o.supplyUnit)) r.unitPrices.push(o.supplyUnit)
  }

  const rows = [...byCode.values()]
  // 부가세는 상품별 합계에 한 번만 적용 (행마다 반올림해 합치면 오차가 쌓인다)
  for (const r of rows) {
    r.supplyTotalIncl = withVat(r.supplyTotal, r.taxable)
    r.unitPricesIncl = r.unitPrices.map((p) => withVat(p, r.taxable))
  }
  return {
    rows,
    totalBoxes: rows.reduce((s, r) => s + r.boxes, 0),
    totalUnits: rows.reduce((s, r) => s + r.units, 0),
    totalSupply: rows.reduce((s, r) => s + r.supplyTotal, 0),
    totalSupplyIncl: rows.reduce((s, r) => s + r.supplyTotalIncl, 0),
  }
}
