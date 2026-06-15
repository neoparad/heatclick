/**
 * PageMeta — page 側から AppShell topbar に title / eyebrow を流し込む
 * 極小 Client コンポーネント (続 75 Task A)
 *
 * 使い方 (各 page.tsx の冒頭で 1 行):
 *   <PageMeta title="ヒートマップ" eyebrow="Behavior · Heatmap" />
 *
 * 親 SSOT: lib/page-meta-store.ts (続 75 配備) / 続 73 AppShell topbar slot
 *
 * 注意:
 *   - 何も render しない (null)。実 UI は AppShell 側で usePageMeta() で読む。
 *   - Server Component の page.tsx からも直接 import 可能 (本 component が
 *     'use client' なので Next.js が自動的に Client boundary を切ってくれる)。
 *   - 同一 page で 2 つ render すると後勝ち (最後に mount/update した方が
 *     state を上書き) になるため、1 page 1 個推奨。
 */

'use client'

import { useEffect } from 'react'

import { clearPageMeta, setPageMeta } from '@/lib/page-meta-store'

interface PageMetaProps {
  title?: string
  eyebrow?: string
}

export function PageMeta({ title, eyebrow }: PageMetaProps): null {
  useEffect(() => {
    setPageMeta({ title, eyebrow })
    return () => {
      clearPageMeta()
    }
  }, [title, eyebrow])
  return null
}
