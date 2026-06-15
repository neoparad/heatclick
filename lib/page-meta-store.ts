/**
 * page-meta-store — AppShell topbar に表示する page title + eyebrow を
 * 各 page から差し込むための極小 in-memory store + React hook (続 75 Task A)
 *
 * 親 SSOT: 続 73 (AppShell 配備、topbar に pageTitle slot あり) /
 *          続 74 dispatch Task A (Owner 2026-05-24 09:28 報告: topbar 空白で
 *          各 page のタイトル不明、AIチャットには title すらない)
 *
 * 設計判断:
 *   - `(proof)/layout.tsx` は全 page で共通 AppShell wrap、page 単位で props を
 *     差し替えできない (Next.js App Router の制約)。
 *   - そこで「page 側が <PageMeta title=... /> client コンポーネントを render →
 *     useEffect で本 store に set → AppShell が useSyncExternalStore で subscribe」
 *     という最小カプセル化を採用。zustand 等の追加依存は入れない。
 *   - 同時に複数 page meta が立たない (Next.js は同時に 1 page しか render
 *     しない) ため、store は単一 state で十分。
 *   - PageMeta unmount 時に空 state に戻すことで、route 切替時にちらつかない。
 */

import { useSyncExternalStore } from 'react'

export interface PageMetaState {
  /** topbar の主タイトル (例: 'AIチャット'、'ヒートマップ'、'UGOKIMAP AI') */
  title?: string
  /** title 上に小さく出る eyebrow (例: 'Dashboard · 行動分析') */
  eyebrow?: string
}

const EMPTY: PageMetaState = {}

let current: PageMetaState = EMPTY
const listeners: Set<() => void> = new Set()

function notify(): void {
  for (const l of listeners) l()
}

/** Client から page meta を差し替える (PageMeta コンポーネント経由で呼ばれる) */
export function setPageMeta(next: PageMetaState): void {
  if (current.title === next.title && current.eyebrow === next.eyebrow) return
  current = next
  notify()
}

/** PageMeta unmount 時に呼ばれる。route 切替で stale title が残らない */
export function clearPageMeta(): void {
  if (current === EMPTY) return
  current = EMPTY
  notify()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): PageMetaState {
  return current
}

/**
 * SSR snapshot は常に空 (server では PageMeta は useEffect が走らないので
 * set されない)。hydration mismatch を避けるため初回 render は空。
 */
function getServerSnapshot(): PageMetaState {
  return EMPTY
}

export function usePageMeta(): PageMetaState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** test 用 — production では呼ばない */
export function __resetPageMetaForTest(): void {
  current = EMPTY
  listeners.clear()
}
