'use client'

import { useState } from 'react'
import {
  parseMarginMaster,
  buildActualPriceMap,
  buildCostBookMap,
  type CostMaster,
  type MarginMasterParseResult,
} from '@/lib/coupang/parsers/marginMaster'

export default function ParserTestPage() {
  const [result, setResult] = useState<MarginMasterParseResult | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [parseTime, setParseTime] = useState<number>(0)

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)

    const buffer = await file.arrayBuffer()
    const t0 = performance.now()
    const r = parseMarginMaster(buffer)
    const t1 = performance.now()
    setParseTime(t1 - t0)
    setResult(r)
  }

  return (
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        마진 마스터 파서 테스트
      </h1>
      <p style={{ color: '#666', marginBottom: 24 }}>
        마진분석.xlsx 업로드 → 파싱 결과 검증
      </p>

      <div style={{
        border: '2px dashed #ccc',
        padding: 32,
        borderRadius: 8,
        textAlign: 'center',
        marginBottom: 24,
        background: '#fafafa'
      }}>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleUpload}
          style={{ marginBottom: 8 }}
        />
        {fileName && (
          <div style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
            파일: <strong>{fileName}</strong> · 파싱 시간: <strong>{parseTime.toFixed(1)}ms</strong>
          </div>
        )}
      </div>

      {result && <ResultView result={result} />}
    </div>
  )
}

function ResultView({ result }: { result: MarginMasterParseResult }) {
  if (result.error) {
    return (
      <div style={{
        padding: 16,
        background: '#fee',
        border: '1px solid #f99',
        borderRadius: 8,
        color: '#c00'
      }}>
        <strong>❌ 파싱 실패:</strong> {result.error}
      </div>
    )
  }

  const m = result.master!

  return (
    <div>
      {/* 통계 */}
      <Section title="📊 통계">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Stat label="원가표 상품" value={`${result.stats.costBookRows}개`} />
          <Stat label="마진계산 옵션" value={`${result.stats.marginRows}개`} />
          <Stat label="비용 테이블" value={result.stats.hasConstants ? '✓ 있음' : '⚠ 기본값'} />
        </div>
        {result.warnings.length > 0 && (
          <div style={{ marginTop: 12, padding: 8, background: '#fff8e1', borderRadius: 4, fontSize: 13 }}>
            {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}
      </Section>

      {/* 비용 상수 */}
      <Section title="⚙️ 비용 상수">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            <Row label="봉투비" value={`${m.constants.bagFee}원/봉`} />
            <Row label="기본 수수료율" value={`${(m.constants.defaultFeeRate * 100).toFixed(1)}%`} />
          </tbody>
        </table>
      </Section>

      {/* 그로스 1kg 가격대 */}
      <Section title="📦 그로스 1kg 입고 기준">
        <table style={tableStyle}>
          <thead>
            <tr><th style={th}>가격대</th><th style={th}>배송비</th><th style={th}>입출고비</th></tr>
          </thead>
          <tbody>
            {Object.entries(m.constants.gross1kgTable).map(([band, v]) => (
              <tr key={band}>
                <td style={td}>{Number(band).toLocaleString()}</td>
                <td style={td}>{v.ship.toLocaleString()}</td>
                <td style={td}>{v.inout.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 그로스 2kg */}
      <Section title="📦 그로스 2kg 입고 기준">
        <table style={tableStyle}>
          <thead>
            <tr><th style={th}>가격대</th><th style={th}>2kg 배송단가</th></tr>
          </thead>
          <tbody>
            {Object.entries(m.constants.gross2kgShipTable).map(([band, ship]) => (
              <tr key={band}>
                <td style={td}>{Number(band).toLocaleString()}</td>
                <td style={td}>{ship.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 윙 박스·택배 */}
      <Section title="🚚 윙 박스·택배">
        <table style={tableStyle}>
          <thead>
            <tr><th style={th}>분류</th><th style={th}>최소kg</th><th style={th}>최대kg</th><th style={th}>박스</th><th style={th}>택배</th></tr>
          </thead>
          <tbody>
            {Object.entries(m.constants.wingBoxShipTable).map(([cat, v]) => (
              <tr key={cat}>
                <td style={td}>{cat}</td>
                <td style={td}>{v.minKg}</td>
                <td style={td}>{v.maxKg}</td>
                <td style={td}>{v.box.toLocaleString()}</td>
                <td style={td}>{v.ship.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 창고 입고비 */}
      <Section title="🏭 그로스 창고 입고비 (봉당)">
        {Object.keys(m.constants.warehouseFee).length === 0 ? (
          <div style={{ color: '#c00', padding: 8 }}>⚠ 비어있음</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr><th style={th}>제조사 | 단위</th><th style={th}>봉당 입고비</th></tr>
            </thead>
            <tbody>
              {Object.entries(m.constants.warehouseFee).map(([key, fee]) => (
                <tr key={key}>
                  <td style={td}>{key}</td>
                  <td style={td}>{fee.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* 원가표 샘플 */}
      <Section title={`📋 원가표 (${m.costBook.length}개) - 처음 10개`}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>노출ID</th>
              <th style={th}>별칭</th>
              <th style={th}>채널</th>
              <th style={th}>기준</th>
              <th style={th}>원곡가</th>
              <th style={th}>윙작업</th>
              <th style={th}>그로스작업</th>
              <th style={th}>혼합비</th>
              <th style={th}>제조사</th>
              <th style={th}>과세</th>
              <th style={th}>봉투비</th>
            </tr>
          </thead>
          <tbody>
            {m.costBook.slice(0, 10).map((r) => (
              <tr key={r.exposureId}>
                <td style={td}>{r.exposureId}</td>
                <td style={td}>{r.alias}</td>
                <td style={td}>{r.channel}</td>
                <td style={td}>{r.baseVolume}</td>
                <td style={td}>{r.rawCost.toLocaleString()}</td>
                <td style={td}>{r.wingWorkFee.toLocaleString()}</td>
                <td style={td}>{r.growthWorkFee.toLocaleString()}</td>
                <td style={td}>{r.mixFee.toLocaleString()}</td>
                <td style={td}>{r.manufacturer}</td>
                <td style={td}>{r.taxType}</td>
                <td style={td}>{r.needsBag}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 마진계산 샘플 */}
      <Section title={`💰 마진계산 (${m.marginRows.length}개) - 처음 10개`}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>옵션ID</th>
              <th style={th}>별칭</th>
              <th style={th}>옵션명</th>
              <th style={th}>채널</th>
              <th style={th}>정가</th>
              <th style={th}>실판매가</th>
              <th style={th}>순이익</th>
              <th style={th}>마진율</th>
              <th style={th}>BEP ROAS</th>
            </tr>
          </thead>
          <tbody>
            {m.marginRows.slice(0, 10).map((r) => (
              <tr key={r.optionId}>
                <td style={td}>{r.optionId}</td>
                <td style={td}>{r.alias}</td>
                <td style={td}>{r.optionName}</td>
                <td style={td}>{r.channel}</td>
                <td style={td}>{r.listPrice.toLocaleString()}</td>
                <td style={td}>
                  <strong>{r.actualPrice.toLocaleString()}</strong>
                  {r.listPrice !== r.actualPrice && (
                    <span style={{ color: '#c33', fontSize: 11, marginLeft: 4 }}>
                      ({(((r.actualPrice / r.listPrice) - 1) * 100).toFixed(1)}%)
                    </span>
                  )}
                </td>
                <td style={td}>{r.netProfit?.toLocaleString() ?? '-'}</td>
                <td style={td}>{r.marginRate != null ? `${(r.marginRate * 100).toFixed(1)}%` : '-'}</td>
                <td style={td}>{r.bepRoas != null ? `${(r.bepRoas * 100).toFixed(0)}%` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 무프 적용 옵션 */}
      <Section title="🏷️ 무프 적용 옵션 (정가 ≠ 실판매가)">
        <MupromoCheck rows={m.marginRows} />
      </Section>
    </div>
  )
}

function MupromoCheck({ rows }: { rows: CostMaster['marginRows'] }) {
  const mupromo = rows.filter(r => r.actualPrice < r.listPrice)
  if (mupromo.length === 0) {
    return <div style={{ padding: 8, color: '#666' }}>무프 적용 옵션 없음</div>
  }
  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        총 <strong>{mupromo.length}개</strong> 옵션이 무프 적용됨 (정가 대비 평균 할인율: <strong>
          {(mupromo.reduce((s, r) => s + (1 - r.actualPrice / r.listPrice), 0) / mupromo.length * 100).toFixed(1)}%
        </strong>)
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>옵션ID</th>
            <th style={th}>별칭</th>
            <th style={th}>옵션명</th>
            <th style={th}>정가</th>
            <th style={th}>실판매가</th>
            <th style={th}>할인율</th>
          </tr>
        </thead>
        <tbody>
          {mupromo.slice(0, 30).map((r) => (
            <tr key={r.optionId}>
              <td style={td}>{r.optionId}</td>
              <td style={td}>{r.alias}</td>
              <td style={td}>{r.optionName}</td>
              <td style={td}>{r.listPrice.toLocaleString()}</td>
              <td style={td}>{r.actualPrice.toLocaleString()}</td>
              <td style={{ ...td, color: '#c33', fontWeight: 600 }}>
                -{((1 - r.actualPrice / r.listPrice) * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mupromo.length > 30 && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
          ... 그 외 {mupromo.length - 30}개 더
        </div>
      )}
    </div>
  )
}

// ─── UI 부속 ───
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 24,
      padding: 20,
      border: '1px solid #e0e0e0',
      borderRadius: 8,
      background: '#fff',
    }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{title}</h2>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 12, background: '#f5f5f5', borderRadius: 6 }}>
      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr style={{ borderBottom: '1px solid #eee' }}>
      <td style={{ padding: '6px 0', color: '#666', width: 200 }}>{label}</td>
      <td style={{ padding: '6px 0', fontFamily: 'monospace' }}>{value}</td>
    </tr>
  )
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  fontFamily: 'monospace',
}
const th: React.CSSProperties = {
  padding: '6px 8px',
  background: '#f5f5f5',
  border: '1px solid #ddd',
  textAlign: 'left',
  fontWeight: 600,
}
const td: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #eee',
}
