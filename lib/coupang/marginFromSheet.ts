/**
 * 나무_마스터 '마진계산'·'단가DB' 시트 값 → 광고 분석용 마진마스터 (marginRows · onePRows).
 *
 * /api/coupang-margin-master 와 맥 자동 업로드 스크립트(scripts/ad-weekly-upload)가 같이 쓴다 —
 * 두 곳이 같은 숫자를 내도록 변환은 여기 한 곳에만 둔다. 열 대응·단위 설명은 라우트 주석 참조.
 * 입력은 values.batchGet(valueRenderOption: UNFORMATTED_VALUE) 결과 그대로:
 *   margin = '마진계산'!A2:AD · price = '단가DB'!A2:J
 */
import type { MarginCalcRow, OnePMarginRow } from './parsers/marginMaster'

export const MARGIN_TAB = '마진계산'
export const PRICE_TAB = '단가DB'
const CHANNEL = '쿠팡 3P'

export type SheetCell = string | number | boolean | null | undefined
type Cell = SheetCell

const str = (v: Cell) => (v == null ? '' : String(v).trim())
const num = (v: Cell) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')))

export function marginMasterFromSheet(
  margin: Cell[][],
  price: Cell[][],
): { marginRows: MarginCalcRow[]; onePRows: OnePMarginRow[] } {
  const gramOf = new Map(price.map((r) => [str(r[0]), num(r[5])]));
  const taxOf = new Map(price.map((r) => [str(r[0]), str(r[9])]));

  const marginRows: MarginCalcRow[] = [];
  for (const r of margin) {
    if (str(r[0]) !== CHANNEL) continue;
    const optionId = str(r[23]);
    if (!optionId || !/^\d+$/.test(optionId)) continue;
    const actualPrice = num(r[3]);
    if (!Number.isFinite(actualPrice) || actualPrice <= 0) continue;

    const alias = str(r[1]);
    const bagCount = num(r[2]) || 1;
    const g = gramOf.get(alias);
    const kgPerBag = g && Number.isFinite(g) && g > 0 ? g / 1000 : 1;
    const fin = (v: Cell) => (Number.isFinite(num(v)) && str(v) !== '' ? num(v) : NaN);
    const netProfit = fin(r[14]);
    const marginRate = fin(r[15]);
    const feePct = fin(r[10]);

    marginRows.push({
      exposureId: str(r[22]),
      optionId,
      alias,
      optionName: `${alias}, ${bagCount}개`,
      coupangOptionName: str(r[29]) || undefined,
      totalKg: 0,
      bagCount,
      kgPerBag,
      listPrice: actualPrice,
      actualPrice,
      perUnitPrice: actualPrice,
      priceBand: '',
      autoChannel: '',
      manualChannel: '',
      channel: '윙',
      size: str(r[7]),
      costPrice: fin(r[5]) || 0,
      bagFee: fin(r[6]) || 0,
      boxFee: fin(r[8]) || 0,
      shipFee: fin(r[9]) || 0,
      warehouseFee: 0,
      grossShipFee: 0,
      inoutFee: 0,
      feeRate: Number.isFinite(feePct) ? feePct / 100 : 0,
      packagingFee: 0,
      coupangFee: fin(r[11]) || 0,
      totalCost: fin(r[13]) || 0,
      netProfit: Number.isFinite(netProfit) ? netProfit : null,
      marginRate: Number.isFinite(marginRate) ? marginRate : null,
      bepRoas: Number.isFinite(netProfit) && netProfit > 0 ? actualPrice / netProfit : null,
      taxable: taxOf.get(alias) === '과세',
    });
  }
  // ── 쿠팡 1P 행 ──
  const oneP: OnePMarginRow[] = [];
  for (const r of margin) {
    if (str(r[0]) !== '쿠팡 1P') continue;
    const alias = str(r[1]);
    const sku = str(r[24]);
    if (!alias && !sku) continue;
    const bagCount = num(r[2]) || 1;
    const m = Number.isFinite(num(r[14])) && str(r[14]) !== '' ? num(r[14]) : null;
    const ship = Number.isFinite(num(r[9])) && str(r[9]) !== '' ? num(r[9]) : null; // J 택배 (추정 운송비)
    const supply = Number.isFinite(num(r[25])) && str(r[25]) !== '' ? num(r[25]) : null; // Z 1P 납품가(부가포함)
    oneP.push({
      optionId: /^\d+$/.test(str(r[23])) ? str(r[23]) : '',
      sku,
      alias,
      bagCount,
      margin: m,
      perBagMargin: null,
      perBagShip: ship,
      perBagSupplyPrice: supply,
      taxable: taxOf.get(alias) === '과세',
      coupangOptionName: str(r[29]),
    });
  }
  // 1봉당 마진: 같은 SKU 의 1봉 행 O 우선, 없으면 O ÷ 봉수
  const oneBagBySku = new Map<string, number>();
  const oneBagShipBySku = new Map<string, number>();
  for (const x of oneP) if (x.bagCount === 1 && x.margin != null && x.sku) oneBagBySku.set(x.sku, x.margin);
  for (const x of oneP) if (x.bagCount === 1 && x.perBagShip != null && x.sku) oneBagShipBySku.set(x.sku, x.perBagShip);
  const oneBagSupplyBySku = new Map<string, number>();
  for (const x of oneP) if (x.bagCount === 1 && x.perBagSupplyPrice != null && x.sku) oneBagSupplyBySku.set(x.sku, x.perBagSupplyPrice);
  for (const x of oneP) {
    x.perBagMargin = (x.sku && oneBagBySku.has(x.sku)) ? oneBagBySku.get(x.sku)! : x.margin != null ? x.margin / x.bagCount : null;
    // 1봉당 추정 운송비 — 1봉 행 J, 없으면 J ÷ 봉수 (perBagMargin 과 같은 기준 행)
    x.perBagShip = (x.sku && oneBagShipBySku.has(x.sku)) ? oneBagShipBySku.get(x.sku)! : x.perBagShip != null ? x.perBagShip / x.bagCount : null;
    // 1봉 납품가 — 실제 매입가(발주서·원장)와 비교 알림용
    x.perBagSupplyPrice = (x.sku && oneBagSupplyBySku.has(x.sku)) ? oneBagSupplyBySku.get(x.sku)! : x.perBagSupplyPrice != null ? x.perBagSupplyPrice / x.bagCount : null;
  }
  return { marginRows, onePRows: oneP }
}
