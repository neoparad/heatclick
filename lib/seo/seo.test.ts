import { dirOf, filterPages, filterQueries, groupDirectories, pathnameOf, rollupTotals } from './filter'
import { generateInternalLinksMock, generateSeoAccessMock, generateSitemapMock } from './mock'

describe('lib/seo/filter', () => {
  it('extracts canonical pathname and top-level directory using normalizeUrlFull', () => {
    expect(pathnameOf('https://WWW.Link-TH.com/entry/internal-link-optimization/?utm_source=nl')).toBe(
      '/entry/internal-link-optimization'
    )
    expect(dirOf('https://link-th.com/entry/internal-link-optimization')).toBe('/entry/')
    expect(dirOf('https://link-th.com/')).toBe('/')
  })

  it('groups pages by directory and calculates weighted CTR and position', () => {
    const pages = [
      { page: 'https://link-th.com/entry/a', clicks: 100, impressions: 1000, position: 2.0 },
      { page: 'https://link-th.com/entry/b', clicks: 50, impressions: 1000, position: 4.0 },
      { page: 'https://link-th.com/column/c', clicks: 20, impressions: 500, position: 6.0 },
    ]
    const dirs = groupDirectories(pages)
    expect(dirs).toHaveLength(2)
    expect(dirs[0]).toEqual({
      dir: '/entry/',
      pages: 2,
      clicks: 150,
      impressions: 2000,
      ctr: 0.075,
      position: 3.0,
    })
    expect(dirs[1]).toEqual({
      dir: '/column/',
      pages: 1,
      clicks: 20,
      impressions: 500,
      ctr: 0.04,
      position: 6.0,
    })
  })

  it('filters pages and queries by directory and search keyword', () => {
    const mock = generateSeoAccessMock(28)
    const entryPages = filterPages(mock.pages, { dir: '/entry/', q: 'internal' })
    expect(entryPages).toHaveLength(1)
    expect(entryPages[0].page).toContain('internal-link-optimization')

    const filteredQueries = filterQueries(mock.queries, {
      dir: '/entry/',
      pairs: mock.pairs,
    })
    expect(filteredQueries.length).toBeGreaterThan(0)
    expect(filteredQueries[0].clicks).toBeGreaterThan(0)

    const totals = rollupTotals(entryPages)
    expect(totals.clicks).toBe(entryPages[0].clicks)
  })

  it('generates deterministic mocks for sitemap and internal links', () => {
    const sm = generateSitemapMock()
    expect(sm.summary.sitemapSubmitted).toBe(148)
    expect(sm.pages.length).toBe(20)

    const il = generateInternalLinksMock('job-123')
    expect(il.jobId).toBe('job-123')
    expect(il.structure.total_pages).toBe(48)
    expect(il.orphans).toHaveLength(3)
  })
})
