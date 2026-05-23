/**
 * Agency UI Dashboard
 *
 * Sprint 5 S5-01 で完成予定。Sprint 0 では skeleton のみ。
 * 親 SSOT §6.7 Sprint 5 / Part II §2.4.4 Agency 専用 UI
 */

export default function AgencyDashboardPage() {
  return (
    <main className="p-8">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-wider text-text-3">Agency Dashboard</p>
        <h1 className="text-3xl font-bold">代理店 KPI</h1>
        <p className="mt-2 text-sm text-text-2">
          全クライアント横断 KPI + MRR + multi-client workspace switcher
        </p>
      </header>

      {/* TODO Sprint 5: Agency 専用 KPI (client 数 / MRR / 全クライアント横断 KPI) */}
      {/* TODO Sprint 5: client workspace switcher (左サイドバー上部) */}
      {/* TODO Sprint 5: white-label 表示 (ロゴ / カラー差替) */}

      <div className="rounded-lg border border-border bg-card p-6 text-text-2">
        Sprint 0 skeleton。Sprint 5 S5-01 で完成。
      </div>
    </main>
  )
}
