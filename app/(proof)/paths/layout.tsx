/**
 * /paths route layout — mounts sonner <Toaster /> for the 経路ビルダー save flows.
 *
 * scenarios/layout.tsx と同方針: sonner を /paths スコープに限定して mount し、
 * 他 proof ページ (heatmap / chat 等) への影響を 0 にする。
 */

import type { ReactNode } from 'react'
import { Toaster } from 'sonner'

export default function PathsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" toastOptions={{ style: { fontSize: '13px' } }} />
    </>
  )
}
