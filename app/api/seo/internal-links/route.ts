import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { generateInternalLinksMock } from '@/lib/seo/mock'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { site } = active

  const sp = req.nextUrl.searchParams
  const jobId =
    sp.get('job_id') ||
    site.linkscrawlJobId ||
    process.env.LINKSCRAWL_DEFAULT_JOB_ID ||
    'demo-job-link-th'
  const baseUrl = (process.env.LINKSCRAWL_API_URL || '').replace(/\/+$/, '')

  if (!baseUrl || sp.get('mock') === '1') {
    return NextResponse.json(generateInternalLinksMock(jobId))
  }

  try {
    const headers: Record<string, string> = {}
    if (process.env.LINKSCRAWL_API_KEY) {
      headers['X-API-Key'] = process.env.LINKSCRAWL_API_KEY
    }
    const [structRes, issuesRes] = await Promise.all([
      fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/structure`, {
        headers,
        cache: 'no-store',
      }),
      fetch(
        `${baseUrl}/v1/internal-links/issues/${encodeURIComponent(jobId)}?issue_type=orphan_page&limit=200`,
        {
          headers,
          cache: 'no-store',
        }
      ),
    ])

    if (!structRes.ok) {
      throw new Error(`linkscrawl structure ${structRes.status}: ${await structRes.text()}`)
    }
    const structure = await structRes.json()
    const issues = issuesRes.ok ? await issuesRes.json() : { issues: [] }

    return NextResponse.json({
      source: 'linkscrawl',
      jobId,
      structure,
      orphans: issues.issues || [],
    })
  } catch (err) {
    return NextResponse.json({
      ...generateInternalLinksMock(jobId),
      source: 'mock-fallback',
      error: (err as Error)?.message || String(err),
    })
  }
}
