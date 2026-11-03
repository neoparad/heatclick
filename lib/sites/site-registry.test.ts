import { listTenantSites, resolveTenantSite } from './site-registry'

describe('Fusion Site Registry (lib/sites/site-registry)', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...origEnv }
    delete process.env.USER_REGISTRY
    delete process.env.FUSION_SITE_REGISTRY_JSON
    delete process.env.LINKSCRAWL_JOB_ID
    delete process.env.AIRECEIPT_SITE_ID
    delete process.env.AIRECEIPT_INSTALL_ID
    delete process.env.GSC_PROPERTY
    delete process.env.CLOUDFLARE_ZONE_ID
  })

  afterAll(() => {
    process.env = origEnv
  })

  it('lists dogfood sites for linkth_internal and returns empty for unknown tenant', async () => {
    const internalSites = await listTenantSites('linkth_internal')
    expect(internalSites.length).toBeGreaterThanOrEqual(6)
    expect(internalSites.some((s) => s.siteId === 'CIP_EcwUTHEZdIOAUqum')).toBe(true)

    const otherTenantSites = await listTenantSites('tnt_external_other')
    expect(otherTenantSites).toEqual([])
  })

  it('resolves the same site record across ugokimap siteId, linkscrawl host/jobId, AIreceipt siteId/installId, and GSC property', async () => {
    process.env.LINKSCRAWL_JOB_ID = 'job_bihada_202611'
    process.env.AIRECEIPT_SITE_ID = 'site_bihada_abc'
    process.env.AIRECEIPT_INSTALL_ID = 'inst_bihada_999'

    const byUgoki = await resolveTenantSite('linkth_internal', 'CIP_EcwUTHEZdIOAUqum')
    const byHost = await resolveTenantSite('linkth_internal', 'https://www.bihadashop.jp/column/test')
    const byJob = await resolveTenantSite('linkth_internal', 'job_bihada_202611')
    const byAireceiptSite = await resolveTenantSite('linkth_internal', 'site_bihada_abc')
    const byAireceiptInst = await resolveTenantSite('linkth_internal', 'inst_bihada_999')
    const byGsc = await resolveTenantSite('linkth_internal', 'sc-domain:bihadashop.jp')

    expect(byUgoki).not.toBeNull()
    expect(byUgoki?.siteId).toBe('CIP_EcwUTHEZdIOAUqum')
    expect(byUgoki?.canonicalHost).toBe('bihadashop.jp')
    expect(byUgoki?.linkscrawlHost).toBe('bihadashop.jp')
    expect(byUgoki?.linkscrawlJobId).toBe('job_bihada_202611')
    expect(byUgoki?.aireceiptSiteId).toBe('site_bihada_abc')
    expect(byUgoki?.aireceiptInstallId).toBe('inst_bihada_999')

    expect(byHost).toEqual(byUgoki)
    expect(byJob).toEqual(byUgoki)
    expect(byAireceiptSite).toEqual(byUgoki)
    expect(byAireceiptInst).toEqual(byUgoki)
    expect(byGsc).toEqual(byUgoki)
  })

  it('strictly enforces tenant isolation (cannot resolve another tenant site)', async () => {
    process.env.AIRECEIPT_SITE_ID = 'site_bihada_abc'
    const leakAttempt = await resolveTenantSite('tnt_other', 'CIP_EcwUTHEZdIOAUqum')
    const leakByHost = await resolveTenantSite('tnt_other', 'bihadashop.jp')
    const leakByAireceipt = await resolveTenantSite('tnt_other', 'site_bihada_abc')

    expect(leakAttempt).toBeNull()
    expect(leakByHost).toBeNull()
    expect(leakByAireceipt).toBeNull()
  })

  it('supports FUSION_SITE_REGISTRY_JSON overrides for multi-site configuration', async () => {
    process.env.FUSION_SITE_REGISTRY_JSON = JSON.stringify([
      {
        tenantId: 'linkth_internal',
        siteId: 'CIP_E3xzSWfXcXx6GaTL',
        aireceiptSiteId: 'site_linkth_corp',
        linkscrawlJobId: 'job_linkth_001',
      },
    ])

    const resolved = await resolveTenantSite('linkth_internal', 'site_linkth_corp')
    expect(resolved).not.toBeNull()
    expect(resolved?.siteId).toBe('CIP_E3xzSWfXcXx6GaTL')
    expect(resolved?.canonicalHost).toBe('link-th.co.jp')
    expect(resolved?.linkscrawlJobId).toBe('job_linkth_001')
  })
})
