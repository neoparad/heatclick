/**
 * HeatmapSidePanel — 右側パネル (4 tab: hotspots / signals / summary / sessions)
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.hm-side`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 6
 *
 * 動作:
 *   - tab 切替で view を切替 (signals tab を開くと自動で `signalsOn=true`)
 *   - hotspot card クリックで onSelectHotspot (heat-tag scroll + highlight)
 *   - signal card クリックで onToggleSignal (canvas marker visibility)
 *
 * 既存 testid: `hotspot-rankings-panel` を維持し、新 testid (`hm-side-tab-*`,
 * `hotspot-card-N`, `signal-card-*`) を追加する。
 */

'use client'

import { useId, useRef } from 'react'

import { EMOTION_BAR_BG, SIDE_TABS, SIGNALS } from '@/lib/heatmap/mockup-spec'
import type {
  EmotionDistribution,
  EmotionKey,
  HotspotCard,
  SideTab,
  SignalCard,
  SignalKey,
} from '@/lib/heatmap/types'

interface HeatmapSidePanelProps {
  activeTab: SideTab
  onTabChange: (t: SideTab) => void
  emotionSummary: EmotionDistribution
  hotspotCards: HotspotCard[]
  signalCards: SignalCard[]
  enabledSignals: ReadonlySet<SignalKey>
  onToggleSignal: (key: SignalKey) => void
  onSelectHotspot?: (cardId: string) => void
}

export function HeatmapSidePanel({
  activeTab,
  onTabChange,
  emotionSummary,
  hotspotCards,
  signalCards,
  enabledSignals,
  onToggleSignal,
  onSelectHotspot,
}: HeatmapSidePanelProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  function handleTabKey(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    // WAI-ARIA tabs roving keyboard pattern (Codex review MEDIUM fix)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const next = (idx + dir + SIDE_TABS.length) % SIDE_TABS.length
      tabRefs.current[next]?.focus()
      onTabChange(SIDE_TABS[next].key)
    } else if (e.key === 'Home') {
      e.preventDefault()
      tabRefs.current[0]?.focus()
      onTabChange(SIDE_TABS[0].key)
    } else if (e.key === 'End') {
      e.preventDefault()
      const last = SIDE_TABS.length - 1
      tabRefs.current[last]?.focus()
      onTabChange(SIDE_TABS[last].key)
    }
  }

  return (
    <aside
      data-testid="hotspot-rankings-panel"
      className="hm-side flex w-[360px] shrink-0 flex-col overflow-hidden rounded-md border border-[var(--ug-border)] bg-white shadow-sm"
      role="region"
      aria-label="ヒートマップ サイドパネル"
    >
      <div
        className="hm-side-tabs flex border-b border-[var(--ug-border)] px-3"
        style={{ background: 'var(--ug-panel-2, #fbfbfc)' }}
        role="tablist"
        aria-label="ヒートマップ サイドパネル タブ"
      >
        {SIDE_TABS.map((t, i) => {
          const active = activeTab === t.key
          const count =
            t.key === 'hotspots'
              ? hotspotCards.length
              : t.key === 'signals'
                ? signalCards.length
                : 0
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${t.key}`}
              aria-selected={active}
              aria-controls={`${tabsId}-panel-${t.key}`}
              tabIndex={active ? 0 : -1}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              data-testid={`hm-side-tab-${t.key}`}
              onClick={() => onTabChange(t.key)}
              onKeyDown={(e) => handleTabKey(e, i)}
              className={
                'hm-side-tab border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition ' +
                (active
                  ? 'active border-[var(--ug-brand-1)] font-semibold text-[var(--ug-text)]'
                  : 'border-transparent text-[var(--ug-text-3)] hover:text-[var(--ug-text-1)]')
              }
            >
              {t.label}
              {count > 0 ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>

      <div
        className="hm-side-body flex-1 overflow-y-auto p-4"
        role="tabpanel"
        id={`${tabsId}-panel-${activeTab}`}
        aria-labelledby={`${tabsId}-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === 'hotspots' ? (
          <HotspotsView
            emotionSummary={emotionSummary}
            hotspotCards={hotspotCards}
            onSelectHotspot={onSelectHotspot}
          />
        ) : null}
        {activeTab === 'signals' ? (
          <SignalsView
            signalCards={signalCards}
            enabledSignals={enabledSignals}
            onToggleSignal={onToggleSignal}
          />
        ) : null}
        {activeTab === 'summary' ? <SummaryView emotionSummary={emotionSummary} /> : null}
        {activeTab === 'sessions' ? <SessionsView /> : null}
      </div>
    </aside>
  )
}

function HotspotsView({
  emotionSummary,
  hotspotCards,
  onSelectHotspot,
}: {
  emotionSummary: EmotionDistribution
  hotspotCards: HotspotCard[]
  onSelectHotspot?: (id: string) => void
}) {
  return (
    <>
      <EmotionSummary summary={emotionSummary} />

      <div className="mb-2.5 mt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        ホットスポット (強度順)
      </div>

      <ol className="space-y-2">
        {hotspotCards.map((c) => (
          <li key={c.id}>
            <HotspotCardRow card={c} onClick={onSelectHotspot ? () => onSelectHotspot(c.id) : undefined} />
          </li>
        ))}
      </ol>

      <AIPromptCta
        title="UGOKIMAP AI に聞く"
        body="このページのカート追加CTAの離脱率を下げる施策を、データを見ながら提案させます。"
        cta="このページの分析を依頼 →"
      />
    </>
  )
}

function HotspotCardRow({ card, onClick }: { card: HotspotCard; onClick?: () => void }) {
  const intentBorder =
    card.intent === 'warn' ? '#d64545' : card.intent === 'win' ? '#39a169' : 'transparent'
  // emotion 未推論 (real mode Phase 1) では emotion badge / bar を出さない。
  // emotionPercents の有無で判定する (fixture は必ず複数 entry を持つ)。
  const emotionInferred = card.emotionPercents.length > 0
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`hotspot-card-${card.rank}`}
      className="w-full rounded-md border border-[var(--ug-border)] bg-[var(--ug-panel-2,#fbfbfc)] p-3 text-left transition hover:border-[var(--ug-brand-1)] hover:bg-[var(--ug-accent-bg,rgba(79,107,255,.09))]"
      style={card.intent !== 'neutral' ? { borderLeft: `3px solid ${intentBorder}` } : undefined}
      aria-label={`ホットスポット ${card.rank}: ${card.name}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] font-bold text-white"
          style={{
            background:
              card.intent === 'warn'
                ? '#d64545'
                : card.intent === 'win'
                  ? '#39a169'
                  : '#4F6BFF',
          }}
        >
          {card.rank}
        </span>
        <span className="text-[12.5px] font-semibold text-[var(--ug-text)] tracking-tight">
          {card.name}
        </span>
        {emotionInferred ? <EmotionTag emotion={card.emotionLabel} /> : null}
      </div>
      <div className="font-mono text-[10.5px] text-[var(--ug-text-3)]">{card.selector}</div>
      {emotionInferred ? (
        <div className="mt-1.5 flex h-1 overflow-hidden rounded bg-[var(--ug-bg-2,#f4f5f7)]">
          {card.emotionPercents.map((e) => (
            <i
              key={e.key}
              style={{ width: `${e.pct}%`, background: EMOTION_BAR_BG[e.key] }}
              aria-hidden
            />
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex gap-2.5 border-t border-dashed border-[var(--ug-border-2,#eef0f3)] pt-2 font-mono text-[10.5px] text-[var(--ug-text-3)]">
        {card.stats.map((s, i) => (
          <span key={i}>
            {s.label}{' '}
            <b
              className="font-semibold"
              style={{
                color:
                  s.tone === 'neg'
                    ? 'var(--ug-red,#d64545)'
                    : s.tone === 'pos'
                      ? 'var(--ug-green,#39a169)'
                      : 'var(--ug-text,#0a0b0d)',
              }}
            >
              {s.value}
            </b>
          </span>
        ))}
      </div>
    </button>
  )
}

function EmotionTag({ emotion }: { emotion: EmotionKey | 'cmp' }) {
  const color = EMOTION_BAR_BG[emotion as EmotionKey]
  return (
    <span
      className="ml-auto rounded border px-1.5 py-px font-mono text-[9.5px] font-semibold"
      style={{
        color,
        background: `${color}14`,
        borderColor: `${color}38`,
      }}
    >
      {emotion === 'hes'
        ? 'hesitation'
        : emotion === 'eng'
          ? 'engagement'
          : emotion === 'cmp'
            ? 'comparison'
            : emotion === 'frust'
              ? 'frustration'
              : emotion === 'anx'
                ? 'anxiety'
                : 'confidence'}
    </span>
  )
}

function SignalsView({
  signalCards,
  enabledSignals,
  onToggleSignal,
}: {
  signalCards: SignalCard[]
  enabledSignals: ReadonlySet<SignalKey>
  onToggleSignal: (key: SignalKey) => void
}) {
  return (
    <>
      <div className="mb-3 border-b border-[var(--ug-border-2,#eef0f3)] pb-3">
        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
          UGOKI MAP 独自 6 シグナル
        </div>
        <div className="text-[11.5px] leading-snug text-[var(--ug-text-2)]">
          他ツールでは取得できない 6 種の行動シグナル。各行をクリックすると左のキャンバスにマーカー表示。
        </div>
      </div>
      <ul className="space-y-2">
        {signalCards.map((c) => {
          const active = enabledSignals.has(c.type)
          return (
            <li key={c.id}>
              <button
                type="button"
                data-testid={`signal-card-${c.type}`}
                onClick={() => onToggleSignal(c.type)}
                aria-pressed={active}
                className={
                  'w-full rounded-md border p-3 text-left transition ' +
                  (active
                    ? 'border-[var(--ug-brand-1)] bg-white shadow-[0_0_0_3px_var(--ug-accent-bg,rgba(79,107,255,.09))]'
                    : 'border-[var(--ug-border)] bg-[var(--ug-panel-2,#fbfbfc)] hover:border-[var(--ug-brand-1)]')
                }
              >
                <div className="mb-1 flex items-center gap-2">
                  <SignalDot type={c.type} />
                  <span className="text-[12.5px] font-semibold text-[var(--ug-text)]">{c.name}</span>
                  <span className="ml-auto font-mono text-[11.5px] font-bold text-[var(--ug-text-1)]">
                    {c.count.toLocaleString()}
                  </span>
                  {c.uniqueBadge ? (
                    <span
                      className="rounded px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.04em] text-white"
                      style={{ background: 'linear-gradient(135deg, #4F6BFF, #A855F7)' }}
                    >
                      UGOKY ONLY
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-[11.5px] leading-snug text-[var(--ug-text-2)]">
                  {c.description}
                </div>
                <div className="mt-1.5 border-t border-dashed border-[var(--ug-border-2,#eef0f3)] pt-1.5 font-mono text-[10.5px] leading-snug text-[var(--ug-text-3)]">
                  {c.whereLabel}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
      <AIPromptCta
        title="シグナルから施策を生成"
        body="これら 6 シグナルを統合した PROP-002 の AI 施策提案に起票済み。詳細を確認できます。"
        cta="AI 施策提案を開く ↗"
      />
    </>
  )
}

function SignalDot({ type }: { type: SignalKey }) {
  const map = SIGNALS.find((s) => s.key === type)
  void map
  switch (type) {
    case 'rage':
      return (
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: '#d64545', boxShadow: '0 0 0 2px rgba(214,69,69,.18)' }}
        />
      )
    case 'dead':
      return <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: '#6c6e75' }} />
    case 'hover':
      return (
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: 'transparent', border: '2px dashed #4F6BFF' }}
        />
      )
    case 'copy':
      return <span className="h-2 w-3 shrink-0 rounded-[2px]" style={{ background: '#c9911a' }} />
    case 'backscroll':
      return <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: '#39a169' }} />
    case 'hesitation':
      return (
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: '#c9911a', boxShadow: '0 0 0 3px rgba(201,145,26,.18)' }}
        />
      )
  }
}

function SummaryView({ emotionSummary }: { emotionSummary: EmotionDistribution }) {
  return (
    <div data-testid="hm-side-summary">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        サマリー
      </div>
      <EmotionSummary summary={emotionSummary} />
      <div className="mt-3 text-[12px] leading-relaxed text-[var(--ug-text-2)]">
        サマリーパネルは流入元 / デバイス比 / 時間帯ヒートを集計表示します
        (個別セッション再生は §1.7 で禁止)。
      </div>
    </div>
  )
}

function SessionsView() {
  // §1.7 Anti-Features: セッション録画 / pixel-level reconstruction / 再生は禁止。
  // 集計属性 (デバイス比 / 流入元 / 経過時間ヒスト) のみ表示する。
  return (
    <div data-testid="hm-side-sessions">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        該当セッション (集計)
      </div>
      <div className="text-[12px] leading-relaxed text-[var(--ug-text-2)]">
        現在の filter / layer に合致するセッションの集計属性 (デバイス比 / 流入元 / 経過時間
        ヒスト) を表示します。
      </div>
      <div className="mt-2 font-mono text-[11px] text-[var(--ug-text-3)]">
        個別セッションの DOM / 動画は親 SSOT §1.7 で禁止。集計のみ表示。
      </div>
    </div>
  )
}

function EmotionSummary({ summary }: { summary: EmotionDistribution }) {
  const order: Array<{ key: EmotionKey; label: string }> = [
    { key: 'hes', label: 'hesitation' },
    { key: 'eng', label: 'engagement' },
    { key: 'cmp', label: 'comparison' },
    { key: 'frust', label: 'frustration' },
    { key: 'anx', label: 'anxiety' },
    { key: 'conf', label: 'confidence' },
  ]
  // 続123: real mode は感情推論 (ML) 未実装で全 0。空バー + 0% の羅列は「壊れて見える」
  // ため、正直に「準備中」を表示する (D-07: 無いデータを有るように見せない)。
  const total = order.reduce((s, o) => s + summary[o.key], 0)
  if (total === 0) {
    return (
      <div data-testid="emotion-summary">
        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
          このページの感情分布
        </div>
        <div className="rounded-md border border-dashed border-[var(--ug-border)] bg-[var(--ug-panel-2,#fbfbfc)] px-3 py-2.5 text-[11px] leading-snug text-[var(--ug-text-3)]">
          感情推論 (ML) は準備中です。現在は観測ベースの指標 — クリック / シグナル / 到達率 — をご利用ください。
        </div>
      </div>
    )
  }
  return (
    <div data-testid="emotion-summary">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        このページの感情分布
      </div>
      <div className="mb-2 flex h-2.5 overflow-hidden rounded border border-[var(--ug-border-2,#eef0f3)] bg-[var(--ug-bg-2,#f4f5f7)]">
        {order.map((o) => (
          <i
            key={o.key}
            style={{ width: `${summary[o.key]}%`, background: EMOTION_BAR_BG[o.key] }}
            aria-hidden
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10.5px] text-[var(--ug-text-2)]">
        {order.slice(0, 4).map((o) => (
          <span key={o.key} className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: EMOTION_BAR_BG[o.key] }}
              aria-hidden
            />
            {o.label}
            <b className="ml-auto font-semibold text-[var(--ug-text)]">{summary[o.key]}%</b>
          </span>
        ))}
      </div>
    </div>
  )
}

function AIPromptCta({ title, body, cta }: { title: string; body: string; cta: string }) {
  return (
    <div
      className="mt-4 rounded-md border p-3.5"
      style={{
        borderColor: 'rgba(79,107,255,.25)',
        background:
          'linear-gradient(180deg, rgba(79,107,255,.04) 0%, rgba(168,85,247,.04) 100%)',
      }}
    >
      <h4 className="mb-1 flex items-center gap-1.5 text-[12px] font-bold tracking-tight text-[var(--ug-text)]">
        <span
          className="inline-flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] text-white"
          style={{ background: 'linear-gradient(135deg, #4F6BFF, #A855F7)' }}
          aria-hidden
        >
          A
        </span>
        {title}
      </h4>
      <p className="mb-2 text-[11.5px] leading-snug text-[var(--ug-text-2)]">{body}</p>
      <button
        type="button"
        disabled
        className="w-full rounded-md px-3 py-1.5 text-[12px] font-medium text-white"
        style={{
          background: 'linear-gradient(135deg, #4F6BFF, #A855F7)',
          boxShadow:
            '0 1px 2px rgba(15,17,23,.08), 0 0 0 1px rgba(79,107,255,.35) inset',
        }}
      >
        {cta}
      </button>
    </div>
  )
}
