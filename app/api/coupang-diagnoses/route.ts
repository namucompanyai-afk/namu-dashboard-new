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

      return NextResponse.json({ ok: true, type: 'explicit', id: newId });
    }

    return NextResponse.json({ error: 'type=last|explicit' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** DELETE — 명시 저장 삭제 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id 파라미터 필요' }, { status: 400 });
    }

    // 1) 새 방식: 개별 키 삭제 시도
    try {
      await deleteData(`${KEY_ITEM_PREFIX}${id}`);
    } catch (e) {
      // 무시 (옛날 데이터일 수 있음)
    }

    // 2) 옛날 묶음 키에서도 삭제 (마이그레이션 안 된 거)
    const existing = await getData(KEY_LIST_OLD);
    if (existing?.diagnoses) {
      const list: DiagnosisSnapshot[] = existing.diagnoses;
      const updated = list.filter(d => d.id !== id);
      if (updated.length !== list.length) {
        await saveData(KEY_LIST_OLD, { diagnoses: updated });
      }
    }

    return NextResponse.json({ ok: true, deleted: id });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
