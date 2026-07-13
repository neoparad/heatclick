const URL_BASE = 'https://paths.invalid'

function removeTrailingSlash(pathname: string): string {
  if (pathname === '/') return pathname
  return pathname.replace(/\/+$/, '') || '/'
}

/**
 * Normalizes a path DSL value for comparison with ClickHouse's path(url).
 * Both absolute URLs and site-relative paths are accepted; origin, query, and
 * fragment are deliberately excluded from the matching contract.
 */
export function toPathnameForMatch(value: string): string | null {
  const input = value.trim()
  if (!input || (!input.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(input))) {
    return null
  }

  try {
    const parsed = new URL(input, URL_BASE)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return removeTrailingSlash(parsed.pathname)
  } catch {
    return null
  }
}

/** Converts a trailing /* DSL value into a normalized pathname prefix. */
export function toPathnameGlobPrefix(value: string): string | null {
  const input = value.trim()
  if (!input || (!input.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(input))) {
    return null
  }

  try {
    const parsed = new URL(input, URL_BASE)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.pathname.endsWith('/*')
    ) {
      return null
    }
    const pathname = removeTrailingSlash(parsed.pathname.slice(0, -1))
    return pathname === '/' ? '/' : `${pathname}/`
  } catch {
    return null
  }
}

/**
 * Keep the SQL contract aligned with toPathnameForMatch: path(url), with all
 * trailing slashes removed except on the root path. The column name is static
 * application code, never a user-supplied value.
 */
export function pathnameMatchSql(column = 'url'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error('Path match SQL column must be a simple identifier')
  }

  const pathname = `ifNull(path(${column}), '')`
  return `if(${pathname} = '/', '/', replaceRegexpOne(${pathname}, '/+$', ''))`
}
