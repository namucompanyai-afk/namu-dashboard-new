import { NextResponse } from "next/server";
import { getData, saveData, deleteData, listByPrefix, listIdsByPrefix } from "@/lib/supabase";

/**
 * 진단 결과 저장 API v3
 *
 * 변경: 분석 목록을 개별 키로 분리 저장 (확장성)
 *
 * 키 패턴:
 * - coupang_diagnosis_last           : 마지막 분석 1개 (자동 저장, 덮어쓰기)
 * - coupang_diagnosis_item__{id}     : 명시 저장된 분석 (각각 별개 row)
 */

const KEY_LAST = 'coupang_diagnosis_last';
const KEY_ITEM_PREFIX = 'coupang_diagnosis_item__';
// raw 데이터 (adRows/sellerStats) 별도 저장 — 메인 row 4.5MB Vercel limit 회피
const KEY_RAW_PREFIX = 'coupang_diagnosis_raw__';
// 옛날 묶음 키 (마이그레이션용)
const KEY_LIST_OLD = 'coupang_diagnosis_list';

interface DiagnosisSnapshot {
  id?: string;
  label?: string;
  monthKey?: string | null;
  weekKey?: string | null;
  trendType?: 'weekly' | 'monthly' | null;
  includeInTrend?: boolean;

  adFileName?: string;
  sellerFileName?: string;
  adRows: any[];
  sellerStats: any[];

  periodStartDate?: string;
  periodEndDate?: string;
  periodDays: number;
  sellerPeriodDays?: number;

  summary: any;
  createdAt?: string;
}

/** GET — 마지막 분석 또는 목록 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'last';

    if (type === 'last') {
      const saved = await getData(KEY_LAST);
      return NextResponse.json(saved || null);
    }

    if (type === 'list') {
      // 1) 새 방식: 개별 키 모두 조회 (목록은 가벼운 메타만)
      //    raw 키는 id 만 가볍게 긁어서 _hasRaw 보강 (메인 row 의 adRows 는 explicit 저장 시 빈 배열 마커라 단독 판정 불가)
      const [rows, rawIds, old] = await Promise.all([
        listByPrefix(KEY_ITEM_PREFIX),
        listIdsByPrefix(KEY_RAW_PREFIX),
        getData(KEY_LIST_OLD),
      ]);
      const rawIdSet = new Set(rawIds.map((k) => k.replace(KEY_RAW_PREFIX, '')));

      const fromIndividual = rows
        .map((r: any) => r.data as DiagnosisSnapshot)
        .filter(Boolean)
        .map((d: any) => {
          const { adRows, sellerStats, ...meta } = d;
          return {
            ...meta,
            _hasRaw: !!(adRows?.length || sellerStats?.length || (d.id && rawIdSet.has(d.id))),
          };
        });

      // 2) 옛날 묶음 키도 조회 (마이그레이션 안 된 데이터)
      const fromOld: DiagnosisSnapshot[] = old?.diagnoses || [];

      // 머지: 개별 키 우선, 그 외 옛날 키
      const seenIds = new Set(fromIndividual.map((d: any) => d.id).filter(Boolean));
      const merged = [
        ...fromIndividual,
        ...fromOld
          .filter((d: any) => d.id && !seenIds.has(d.id))
          .map((d: any) => ({
            ...d,
            _hasRaw: !!(d.adRows?.length || d.sellerStats?.length || (d.id && rawIdSet.has(d.id))),
          })),
      ];

      return NextResponse.json({ diagnoses: merged });
    }

    if (type === 'item') {
      const id = searchParams.get('id');
      if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
      const data = await getData(`${KEY_ITEM_PREFIX}${id}`);
      return NextResponse.json(data || null);
    }

    // raw 데이터 (adRows/sellerStats) 별도 조회. 디버깅/재계산용 — frozen view 에서는 호출 안 함.
    if (type === 'raw') {
      const id = searchParams.get('id');
      if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
      const data = await getData(`${KEY_RAW_PREFIX}${id}`);
      return NextResponse.json(data || null);
    }
    return NextResponse.json({ error: 'type=last|list|item|raw' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** POST — 자동 저장(last) / 명시 저장(explicit, 메인 row만) / raw(별도 row, raw 만) */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type } = body as { type: 'last' | 'explicit' | 'raw' };

    // 1) 마지막 분석 자동 저장 (덮어쓰기)
    if (type === 'last') {
      const { snapshot } = body as { snapshot: DiagnosisSnapshot };
      if (!snapshot) return NextResponse.json({ error: 'snapshot 필요' }, { status: 400 });
      await saveData(KEY_LAST, snapshot);
      return NextResponse.json({ ok: true, type: 'last' });
    }

    // 2) 명시 저장 — 메인 row 만 (raw 박혀있으면 분리해서 raw key 에도 저장)
    if (type === 'explicit') {
      const { snapshot } = body as { snapshot: DiagnosisSnapshot };
      if (!snapshot) return NextResponse.json({ error: 'snapshot 필요' }, { status: 400 });

      const newId = snapshot.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // raw 분리 — 메인 row 에서 빼고 별도로 저장 (4.5MB Vercel body limit 회피)
      const { adRows, sellerStats, ...mainSnapshot } = snapshot as any;
      const newMain: DiagnosisSnapshot = {
        ...mainSnapshot,
        id: newId,
        createdAt: snapshot.createdAt || new Date().toISOString(),
        // 메인 row 에는 raw 빈 배열로 마커 (호환성 — list endpoint 의 _hasRaw 판정 등)
        adRows: [],
        sellerStats: [],
      };

      // 같은 키(주별/월별)이고 includeInTrend=true이면 → 기존 거 메인+raw 삭제 후 저장
      if (newMain.includeInTrend) {
        const allRows = await listByPrefix(KEY_ITEM_PREFIX);
        const conflicts = allRows.filter((r: any) => {
          const d = r.data as DiagnosisSnapshot;
          if (!d?.includeInTrend) return false;
          if (newMain.weekKey && d.weekKey === newMain.weekKey) return true;
          if (
            newMain.monthKey &&
            d.monthKey === newMain.monthKey &&
            (d.trendType !== 'weekly') &&
            (newMain.trendType !== 'weekly')
          ) return true;
          return false;
        });
        for (const c of conflicts) {
          const cId = (c.data as any)?.id;
          await deleteData(c.id);
          if (cId) { try { await deleteData(`${KEY_RAW_PREFIX}${cId}`); } catch {} }
        }
      }

      // 메인 row 저장
      await saveData(`${KEY_ITEM_PREFIX}${newId}`, newMain);

      // raw 가 같이 들어왔으면 함께 저장 (옛 클라이언트 호환). 분리 클라이언트는 type='raw' 로 별도 호출.
      let rawSaved = false;
      if ((adRows?.length || 0) > 0 || (sellerStats?.length || 0) > 0) {
        try {
          await saveData(`${KEY_RAW_PREFIX}${newId}`, { id: newId, adRows: adRows || [], sellerStats: sellerStats || [] });
          rawSaved = true;
        } catch (e) {
          // raw 실패해도 메인은 살아있음 → frozen view 동작
          console.error('[diagnoses POST explicit] raw 저장 실패:', e);
        }
      }

      const snapshotMeta = { ...newMain, _hasRaw: rawSaved };
      return NextResponse.json({ ok: true, type: 'explicit', id: newId, snapshotMeta, rawSaved });
    }

    // 3) raw 별도 저장 — 클라이언트가 explicit 후 두 번째로 호출. 페이로드는 raw 만.
    if (type === 'raw') {
      const { id, adRows, sellerStats } = body as { id: string; adRows: any[]; sellerStats: any[] };
      if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
      await saveData(`${KEY_RAW_PREFIX}${id}`, { id, adRows: adRows || [], sellerStats: sellerStats || [] });
      return NextResponse.json({ ok: true, type: 'raw', id });
    }

    return NextResponse.json({ error: 'type=last|explicit|raw' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** DELETE — 명시 저장 삭제. ?purgeLegacyBundle=1 이면 옛 묶음 row 통째 폐기.
 *  ?purgeAll=1 이면 모든 진단 데이터 (개별 키 + 옛 묶음 + last 슬롯) 일괄 폐기 — 새 저장 포맷 마이그레이션용. */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const purgeLegacy = searchParams.get('purgeLegacyBundle') === '1';
    const purgeAll = searchParams.get('purgeAll') === '1';

    // 모든 진단 데이터 일괄 폐기 — 개별 키 + raw 키 + legacy bundle + last 슬롯
    if (purgeAll) {
      const result: any = { ok: true, purgedAll: true, deleted: { individual: 0, raw: 0, legacy: 0, last: 0 }, errors: [] as string[] };
      // 개별 메인 키 모두
      try {
        const rows = await listByPrefix(KEY_ITEM_PREFIX);
        for (const r of rows as any[]) {
          try {
            const cnt = await deleteData(r.id);
            result.deleted.individual += cnt;
          } catch (e) {
            result.errors.push(`item ${r.id}: ${String(e)}`);
          }
        }
      } catch (e) { result.errors.push(`listByPrefix item: ${String(e)}`); }
      // raw 키 모두
      try {
        const rawRows = await listByPrefix(KEY_RAW_PREFIX);
        for (const r of rawRows as any[]) {
          try {
            const cnt = await deleteData(r.id);
            result.deleted.raw += cnt;
          } catch (e) {
            result.errors.push(`raw ${r.id}: ${String(e)}`);
          }
        }
      } catch (e) { result.errors.push(`listByPrefix raw: ${String(e)}`); }
      // legacy 묶음
      try { result.deleted.legacy = await deleteData(KEY_LIST_OLD); } catch (e) { result.errors.push(`legacy: ${String(e)}`); }
      // last 자동 저장 슬롯
      try { result.deleted.last = await deleteData(KEY_LAST); } catch (e) { result.errors.push(`last: ${String(e)}`); }
      return NextResponse.json(result);
    }

    // 옛 묶음 row 통째 삭제 (legacy 정리). raw 가 박힌 거대 JSONB 를 rewrite 하면
    // 크기/타임아웃에 걸려 실패하므로 row 자체를 drop.
    if (purgeLegacy) {
      let removed = 0;
      try {
        removed = await deleteData(KEY_LIST_OLD);
      } catch (e) {
        return NextResponse.json({ error: `legacy purge 실패: ${String(e)}` }, { status: 500 });
      }
      return NextResponse.json({ ok: true, purgedLegacyBundle: true, removed });
    }

    if (!id) {
      return NextResponse.json({ error: 'id 파라미터 필요' }, { status: 400 });
    }

    // 1) 새 방식: 개별 키 삭제 시도 (메인 + raw 둘 다)
    let deletedCount = 0;
    let individualError: string | null = null;
    try {
      deletedCount = await deleteData(`${KEY_ITEM_PREFIX}${id}`);
    } catch (e) {
      individualError = String(e);
      console.error('[diagnoses DELETE] 개별 키 삭제 실패:', id, e);
    }
    let rawDeletedCount = 0;
    try {
      rawDeletedCount = await deleteData(`${KEY_RAW_PREFIX}${id}`);
    } catch (e) {
      console.error('[diagnoses DELETE] raw 키 삭제 실패:', id, e);
    }

    // 2) 옛날 묶음 키에서도 삭제 (마이그레이션 안 된 거).
    //    묶음 rewrite 실패는 전체 응답을 500 으로 만들지 않음 — 개별 키 삭제는 이미 성공했을 수 있음.
    let oldRemoved = false;
    let oldRewriteError: string | null = null;
    try {
      const existing = await getData(KEY_LIST_OLD);
      if (existing?.diagnoses) {
        const list: DiagnosisSnapshot[] = existing.diagnoses;
        const updated = list.filter(d => String(d.id) !== String(id));
        if (updated.length !== list.length) {
          await saveData(KEY_LIST_OLD, { diagnoses: updated });
          oldRemoved = true;
        }
      }
    } catch (e) {
      oldRewriteError = String(e);
      console.error('[diagnoses DELETE] 옛 묶음 rewrite 실패:', id, e);
    }

    // 둘 다 실패한 경우만 500
    if (individualError && !oldRemoved && oldRewriteError) {
      return NextResponse.json({ error: individualError, oldRewriteError }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: id, deletedCount, rawDeletedCount, oldRemoved, oldRewriteError });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
