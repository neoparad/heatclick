/**
 * Client fetch helper for `/api/heatmap/screenshot`.
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay Phase 2
 */

import type { HeatmapDevice, HeatmapUnderlayCapture } from '@/lib/heatmap/types'

export interface HeatmapUnderlayResponse {
  success: true
  data: HeatmapUnderlayCapture
}

export interface HeatmapUnderlayErrorBody {
  success: false
  error: { code: string; message: string }
}

export type HeatmapUnderlayResult = HeatmapUnderlayResponse | HeatmapUnderlayErrorBody

export async function fetchHeatmapUnderlay(input: {
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  signal?: AbortSignal
}): Promise<HeatmapUnderlayResult> {
  const params = new URLSearchParams({
    site_id: input.siteId,
    page_url: input.pageUrl,
    device: input.device,
  })
  const res = await fetch(`/api/heatmap/screenshot?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
    signal: input.signal,
  })

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return body as HeatmapUnderlayErrorBody
    }
    return {
      success: false,
      error: { code: 'INTERNAL', message: `HTTP ${res.status}` },
    }
  }

  return (await res.json()) as HeatmapUnderlayResult
}
