'use client';
import { fN } from './types';
import type { InsightData, StoreData, GoalSettings } from './types';

interface Props {
  ins: InsightData;
  storeData: StoreData;
  goals: GoalSettings;
}

function KpiCard({ label, value, icon, change, changePos, goalPct, goalColor }: {
  label: string; value: string; icon: string; change: string; changePos: boolean;
  goalPct?: number; goalColor?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-gray-900 mb-2">{value}</div>
      <div className={`text-xs font-semibold mb-2 ${changePos ? 'text-emerald-600' : 'text-red-500'}`}>
        {changePos ? '▲' : '▼'} {change}
      </div>
      {goalPct !== undefined && (
        <>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, goalPct)}%`, background: goalColor }} />
          </div>
          <div className="text-xs text-gray-400 mt-1">목표 대비 {goalPct.toFixed(0)}%</div>
        </>
      )}
    </div>
  );
}

export default function KpiGrid({ ins, storeData, goals }: Props) {
  const imp = parseInt(ins.impressions || '0');
  const clk = parseInt(ins.clicks || '0');
  const spend = parseFloat(ins.spend || '0');
  const ctr = parseFloat(ins.ctr || '0');
  let rev = 0;
  (ins.action_values || []).forEach(av => { if (av.action_type === 'purchase') rev += parseFloat(av.value); });
  const metaRoas = spend > 0 ? rev / spend : 0;
  const storeRoas = spend > 0 && storeData.revenue > 0 ? storeData.revenue / spend : 0;
  const displayRoas = storeRoas > 0 ? storeRoas : metaRoas;

  return (
    <div className="grid grid-cols-5 gap-4 mb-6">
      <KpiCard label="노출수" value={fN(imp)} icon="👁" change="+12.4%" changePos={true} />
      <KpiCard label="총 클릭" value={fN(clk)} icon="🖱" change="+8.1%" changePos={true} />
      <KpiCard
        label="CTR" value={ctr.toFixed(2) + '%'} icon="📌" change="+0.3%" changePos={true}
        goalPct={goals.ctr > 0 ? ctr / goals.ctr * 100 : undefined} goalColor="#10b981"
      />
      <KpiCard label="총 지출" value={'₩' + fN(spend)} icon="💰" change="-3.2%" changePos={false} />
      <KpiCard
        label={storeRoas > 0 ? '실 ROAS ✅' : 'Meta ROAS'}
        value={displayRoas > 0 ? (displayRoas * 100).toFixed(0) + '%' : 'N/A'}
        icon="📈" change="+0.4%" changePos={true}
        goalPct={goals.roas > 0 ? displayRoas * 100 / goals.roas * 100 : undefined} goalColor="#4f46e5"
      />
    </div>
  );
}
