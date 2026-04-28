import { NextResponse } from "next/server";
import { getData, saveData, deleteData, listByPrefix } from "@/lib/supabase";

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
      const rows = await listByPrefix(KEY_ITEM_PREFIX);
      const fromIndividual = rows
        .map((r: any) => r.data as DiagnosisSnapshot)
        .filter(Boolean)
        .map((d: any) => {
          const { adRows, sellerStats, ...meta } = d;
          return { ...meta, _hasRaw: !!(adRows?.length || sellerStats?.length) };
        });

      // 2) 옛날 묶음 키도 조회 (마이그레이션 안 된 데이터)
      const old = await getData(KEY_LIST_OLD);
      const fromOld: DiagnosisSnapshot[] = old?.diagnoses || [];

      // 머지: 개별 키 우선, 그 외 옛날 키
      const seenIds = new Set(fromIndividual.map((d: any) => d.id).filter(Boolean));
      const merged = [
        ...fromIndividual,
        ...fromOld.filter((d: any) => d.id && !seenIds.has(d.id)),
      ];

      return NextResponse.json({ diagnoses: merged });
    }

    if (type === 'item') {
      const id = searchParams.get('id');
      if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
      const data = await getData(`${KEY_ITEM_PREFIX}${id}`);
      return NextResponse.json(data || null);
    }
    return NextResponse.json({ error: 'type=last|list|item' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** POST — 자동 저장 또는 명시 저장 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, snapshot } = body as { type: 'last' | 'explicit'; snapshot: DiagnosisSnapshot };

    if (!snapshot) {
      return NextResponse.json({ error: 'snapshot 필요' }, { status: 400 });
    }

    // 1) 마지막 분석 자동 저장 (덮어쓰기)
    if (type === 'last') {
      await saveData(KEY_LAST, snapshot);
      return NextResponse.json({ ok: true, type: 'last' });
    }

    // 2) 명시 저장 — 개별 키로 저장
    if (type === 'explicit') {
      const newId = snapshot.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newSnapshot: DiagnosisSnapshot = {
        ...snapshot,
        id: newId,
        createdAt: snapshot.createdAt || new Date().toISOString(),
      };

      // 같은 키(주별/월별)이고 includeInTrend=true이면 → 기존 거 삭제 후 저장
      if (newSnapshot.includeInTrend) {
        const allRows = await listByPrefix(KEY_ITEM_PREFIX);
        const conflicts = allRows.filter((r: any) => {
          const d = r.data as DiagnosisSnapshot;
          if (!d?.includeInTrend) return false;
          // weekKey 충돌
          if (newSnapshot.weekKey && d.weekKey === newSnapshot.weekKey) return true;
          // monthKey 충돌 (월별만)
          if (
            newSnapshot.monthKey &&
            d.monthKey === newSnapshot.monthKey &&
            (d.trendType !== 'weekly') &&
            (newSnapshot.trendType !== 'weekly')
          ) return true;
          return false;
        });
        for (const c of conflicts) {
          await deleteData(c.id);
        }
      }

      // 개별 키로 저장 — 1개 row만 쓰면 됨!
      const itemKey = `${KEY_ITEM_PREFIX}${newId}`;
      await saveData(itemKey, newSnapshot);

      // 클라이언트 optimistic 업데이트용 메타 (list endpoint와 동일한 형태)
      const { adRows, sellerStats, ...meta } = newSnapshot as any;
      const snapshotMeta = {
        ...meta,
        _hasRaw: !!(adRows?.length || sellerStats?.length),
      };

      return NextResponse.json({ ok: true, type: 'explicit', id: newId, snapshotMeta });
    }

    return NextResponse.json({ error: 'type=last|explicit' }, { status: 400 });
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

    // 모든 진단 데이터 일괄 폐기 — 개별 키 + legacy bundle + last 슬롯
    if (purgeAll) {
      const result: any = { ok: true, purgedAll: true, deleted: { individual: 0, legacy: 0, last: 0 }, errors: [] as string[] };
      // 개별 키 모두
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
      } catch (e) { result.errors.push(`listByPrefix: ${String(e)}`); }
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

    // 1) 새 방식: 개별 키 삭제 시도
    let deletedCount = 0;
    let individualError: string | null = null;
    try {
      deletedCount = await deleteData(`${KEY_ITEM_PREFIX}${id}`);
    } catch (e) {
      individualError = String(e);
      console.error('[diagnoses DELETE] 개별 키 삭제 실패:', id, e);
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

    return NextResponse.json({ ok: true, deleted: id, deletedCount, oldRemoved, oldRewriteError });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
