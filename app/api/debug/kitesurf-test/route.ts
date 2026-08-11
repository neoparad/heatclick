/**
 * TEMPORARY debug route — Cloudflare Kitesurf capture experiment.
 * owner/admin only. Not linked from any UI. Delete after the experiment concludes.
 *
 * GET /api/debug/kitesurf-test?url=<https url>&variant=default|kitesurf
 * Returns the raw JPEG bytes so the result can be inspected directly.
 */

import { NextResponse } from 'next/server'

import { getServerSession } from '@/lib/auth/server-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LAZY_SCRIPT =
  "document.querySelectorAll('img').forEach(function(i){i.loading='eager';" +
  'var d=i.dataset||{};var s=d.src||d.lazySrc||d.original||d.lazy;' +
  'var ss=d.srcset||d.lazySrcset;if(s)i.src=s;if(ss)i.srcset=ss;' +
  "i.className=(i.className||'').replace(/lazyload[a-z]*|b-lazy|lozad|lazysizes/g,'');});" +
  "document.querySelectorAll('[data-bg],[data-background]').forEach(function(e){" +
  "var b=e.dataset.bg||e.dataset.background;if(b)e.style.backgroundImage='url('+b+')';});" +
  "window.scrollTo(0,document.body.scrollHeight);window.dispatchEvent(new Event('scroll'));" +
  'window.scrollTo(0,0);'

export async function GET(request: Request) {
  const session = await getServerSession()
  if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const targetUrl = url.searchParams.get('url')
  const variant = url.searchParams.get('variant') === 'kitesurf' ? 'kitesurf' : 'default'
  if (!targetUrl || !targetUrl.startsWith('https://')) {
    return NextResponse.json({ error: 'url query param required (https only)' }, { status: 400 })
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID
  if (!apiToken || !accountId) {
    return NextResponse.json({ error: 'CLOUDFLARE_API_TOKEN/ACCOUNT_ID not configured' }, { status: 500 })
  }

  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/screenshot`
  const endpoint = variant === 'kitesurf' ? `${base}?browser=kitesurf` : base

  const start = Date.now()
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      accept: 'image/jpeg, application/json',
    },
    body: JSON.stringify({
      url: targetUrl,
      viewport: { width: 1280, height: 1920, deviceScaleFactor: 1 },
      screenshotOptions: { fullPage: true, type: 'jpeg', quality: 75 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30_000 },
      addScriptTag: [{ content: LAZY_SCRIPT }],
    }),
  })
  const durationMs = Date.now() - start
  const contentType = res.headers.get('content-type') ?? ''

  if (!res.ok || contentType.includes('application/json')) {
    const text = await res.text()
    return NextResponse.json(
      { variant, status: res.status, durationMs, contentType, body: text.slice(0, 3000) },
      { status: 502 },
    )
  }

  const buf = Buffer.from(await res.arrayBuffer())
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'image/jpeg',
      'X-Variant': variant,
      'X-Duration-Ms': String(durationMs),
      'X-Bytes': String(buf.length),
    },
  })
}
