/**
 * /scenarios route layout — Stage 2 (続 M-9): mounts sonner <Toaster /> for the
 * scenarios editor / new-form save flows (lazy-load, client-only).
 *
 * Why a sub-layout instead of (proof)/layout.tsx:
 *   - sonner Toaster wraps the whole document body in a portal; mounting once
 *     per /scenarios route scope keeps blast radius zero for other proof pages
 *     (heatmap / chat / etc.) until they need it.
 *
 * Reference: 続 M-9 §1.2 (sonner toast 統合)
 */

import type { ReactNode } from 'react'
import { Toaster } from 'sonner'

export default function ScenariosLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: { fontSize: '13px' },
        }}
      />
    </>
  )
}
