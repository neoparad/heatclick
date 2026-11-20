/**
 * UGOKI LINK v2 — 5-Mode Consent Resolution & Pre-Resolution Zero-Storage Guard
 *
 * Implements §4.2, §4.5, TEL M5, TEL A4, TEL A5 #1, tel.G10, tel.G12:
 * - 5 modes: `off | cookieless | stats_exempt | session | full`
 * - Mode × Jurisdiction matrix: every row defaults to strict side until `legalSignedOff`
 *   (Japan defaults to `cookieless` until signed off; EU/EEA defaults to `off`).
 * - Online loader region class can ONLY tighten, NEVER raise above signed site default or origin.
 * - Minors flag caps at `cookieless`; unverified disclosure blocks JP external-transmission
 *   subject sites to `off` (and caps other sites at `cookieless`).
 * - Privacy signal (GPC/DNT) ALWAYS strips `pool`, `ads`, `member_link` across all jurisdictions
 *   and applies jurisdiction-specific caps.
 * - `GuardedStorageAdapter` physically blocks ALL cookie/localStorage/sessionStorage reads & writes
 *   before consent resolution AND in `off`/`cookieless` modes (`tel.G10`).
 */

import type { ConsentMode, ConsentPurpose } from '../contract/schema';
import type {
  ConsentResolutionInput,
  ConsentResolutionResult,
  CookieJarLike,
  JurisdictionRowPolicy,
  RegionClass,
  StorageLike,
} from './types';

export const CONSENT_MODE_RANK: Readonly<Record<ConsentMode, number>> = {
  off: 0,
  cookieless: 1,
  stats_exempt: 2,
  session: 3,
  full: 4,
};

const RANK_TO_MODE: readonly ConsentMode[] = [
  'off',
  'cookieless',
  'stats_exempt',
  'session',
  'full',
];

export function minConsentMode(a: ConsentMode, b: ConsentMode): ConsentMode {
  return CONSENT_MODE_RANK[a] <= CONSENT_MODE_RANK[b] ? a : b;
}

export function stepDownConsentMode(mode: ConsentMode): ConsentMode {
  const idx = CONSENT_MODE_RANK[mode];
  return idx <= 0 ? 'off' : RANK_TO_MODE[idx - 1];
}

/**
 * Default Jurisdiction Matrix (TEL A4):
 * Every row starts with `legalSignedOff: false`, activating the stricter default
 * until formal legal sign-off is recorded (Owner Decision 1 / tel.G10).
 */
export const DEFAULT_JURISDICTION_MATRIX: Readonly<Record<RegionClass, JurisdictionRowPolicy>> = {
  JP: {
    region: 'JP',
    defaultMode: 'cookieless', // §4.5: JP stays cookieless until legal sign-off
    legalSignedOff: false,
    signedOffMode: 'full',
    privacySignalAction: 'cap_cookieless',
  },
  UK: {
    region: 'UK',
    defaultMode: 'off', // Strict until Owner scope decision + legal sign-off
    legalSignedOff: false,
    signedOffMode: 'stats_exempt',
    privacySignalAction: 'off',
  },
  FR: {
    region: 'FR',
    defaultMode: 'off',
    legalSignedOff: false,
    signedOffMode: 'stats_exempt',
    privacySignalAction: 'off',
  },
  EU_EEA: {
    region: 'EU_EEA',
    defaultMode: 'off',
    legalSignedOff: false,
    signedOffMode: 'off',
    privacySignalAction: 'off',
  },
  US_OPTOUT: {
    region: 'US_OPTOUT',
    defaultMode: 'cookieless',
    legalSignedOff: false,
    signedOffMode: 'full',
    privacySignalAction: 'optout_sale_only',
  },
  UNKNOWN: {
    region: 'UNKNOWN',
    defaultMode: 'cookieless',
    legalSignedOff: false,
    signedOffMode: 'session',
    privacySignalAction: 'cap_cookieless',
  },
};

const MODE_DISALLOWED_PURPOSES: Readonly<Record<ConsentMode, ReadonlySet<ConsentPurpose>>> = {
  off: new Set<ConsentPurpose>([
    'member_link',
    'timeline',
    'page_content',
    'site_search',
    'ads',
    'automation_detection',
    'pool',
    'experiment',
    'personalise',
    'screen_replay',
  ]),
  cookieless: new Set<ConsentPurpose>(['member_link', 'timeline', 'ads', 'screen_replay']),
  stats_exempt: new Set<ConsentPurpose>([
    'member_link',
    'timeline',
    'ads',
    'pool',
    'personalise',
    'screen_replay',
  ]),
  session: new Set<ConsentPurpose>(['member_link']),
  full: new Set<ConsentPurpose>([]),
};

function modeForRegion(
  region: RegionClass,
  policies: Readonly<Partial<Record<RegionClass, JurisdictionRowPolicy>>>
): ConsentMode {
  const row = policies[region] ?? DEFAULT_JURISDICTION_MATRIX[region];
  if (row.legalSignedOff && row.signedOffMode) {
    return row.signedOffMode;
  }
  return row.defaultMode;
}

/**
 * Resolves effective consent mode and allowed purposes strictly BEFORE any storage touch.
 */
export function resolveBrowserConsent(input: ConsentResolutionInput): ConsentResolutionResult {
  const policies: Readonly<Partial<Record<RegionClass, JurisdictionRowPolicy>>> = {
    ...DEFAULT_JURISDICTION_MATRIX,
    ...(input.jurisdictionPolicies ?? {}),
  };

  let cappedReason: string | null = null;

  // 1. Explicit opt-out always resolves to `off`
  if (input.optedOut) {
    return {
      resolved: true,
      mode: 'off',
      purposes: [],
      effectiveRegion: input.originRegionClass ?? input.loaderRegionClass ?? 'UNKNOWN',
      storageAllowed: false,
      sessionStorageAllowed: false,
      persistentStorageAllowed: false,
      telemetryAllowed: false,
      cappedReason: 'opted_out',
    };
  }

  // 2. Explicit CMP / `ugk.consent()` state (`unknown` -> `off`, TEL A4)
  if (input.explicitConsentMode === 'unknown') {
    return {
      resolved: true,
      mode: 'off',
      purposes: [],
      effectiveRegion: input.originRegionClass ?? input.loaderRegionClass ?? 'UNKNOWN',
      storageAllowed: false,
      sessionStorageAllowed: false,
      persistentStorageAllowed: false,
      telemetryAllowed: false,
      cappedReason: 'cmp_unknown',
    };
  }

  // 3. Determine strictest region class across (origin, loader)
  const originRegion = input.originRegionClass ?? null;
  const loaderRegion = input.loaderRegionClass ?? null;
  let effectiveRegion: RegionClass = originRegion ?? loaderRegion ?? 'UNKNOWN';

  let mode: ConsentMode;
  if (input.explicitConsentMode !== undefined && input.explicitConsentMode !== null) {
    mode = input.explicitConsentMode;
    // Still never exceed minors / disclosure / privacy-signal guardrails below
  } else {
    // Strictest across (signed site default, origin region mode, loader region mode) (§4.2)
    mode = input.siteDefaultMode;
    if (originRegion) {
      const originMode = modeForRegion(originRegion, policies);
      if (CONSENT_MODE_RANK[originMode] < CONSENT_MODE_RANK[mode]) {
        mode = originMode;
        effectiveRegion = originRegion;
      }
    }
    if (loaderRegion) {
      const loaderMode = modeForRegion(loaderRegion, policies);
      if (CONSENT_MODE_RANK[loaderMode] < CONSENT_MODE_RANK[mode]) {
        mode = loaderMode;
        effectiveRegion = loaderRegion;
      }
    }
    if (!originRegion && !loaderRegion) {
      mode = minConsentMode(mode, modeForRegion('UNKNOWN', policies));
    }
  }

  // 4. Disclosure verification check (§4.5 / tel.G12)
  const isJpSubject = input.jpExternalTransmissionSubject ?? effectiveRegion === 'JP';
  if (input.disclosureStatus !== 'verified') {
    if (isJpSubject) {
      mode = 'off';
      cappedReason = 'unverified_disclosure_jp';
    } else if (CONSENT_MODE_RANK[mode] > CONSENT_MODE_RANK.cookieless) {
      mode = 'cookieless';
      cappedReason = 'unverified_disclosure';
    }
  }

  // 5. Minors site caps at `cookieless` (§4.5)
  if (input.minorsSite && CONSENT_MODE_RANK[mode] > CONSENT_MODE_RANK.cookieless) {
    mode = 'cookieless';
    cappedReason = 'minors_site_cap';
  }

  // 6. Opt-out durability cap: script-only 7d Safari cookie caps mode 1 tier lower (§4.5)
  if (input.optOutDurability === 'capped_7d' && CONSENT_MODE_RANK[mode] > CONSENT_MODE_RANK.cookieless) {
    mode = stepDownConsentMode(mode);
    cappedReason = cappedReason ?? 'optout_durability_capped_7d';
  }

  // 7. Browser privacy signal (GPC/DNT) per jurisdiction row (TEL A4)
  const rowPolicy = policies[effectiveRegion] ?? DEFAULT_JURISDICTION_MATRIX[effectiveRegion];
  if (input.privacySignal) {
    if (rowPolicy.privacySignalAction === 'off') {
      mode = 'off';
      cappedReason = 'privacy_signal_off';
    } else if (
      rowPolicy.privacySignalAction === 'cap_cookieless' &&
      CONSENT_MODE_RANK[mode] > CONSENT_MODE_RANK.cookieless
    ) {
      mode = 'cookieless';
      cappedReason = 'privacy_signal_cookieless';
    } else if (
      rowPolicy.privacySignalAction === 'cap_session' &&
      CONSENT_MODE_RANK[mode] > CONSENT_MODE_RANK.session
    ) {
      mode = 'session';
      cappedReason = 'privacy_signal_session';
    }
  }

  // 8. Filter purposes against mode & privacy signal
  const disallowed = MODE_DISALLOWED_PURPOSES[mode];
  const requestedPurposes = input.explicitPurposes ?? [];
  const filteredPurposes: ConsentPurpose[] = [];
  for (const p of requestedPurposes) {
    if (disallowed.has(p)) continue;
    // Privacy signal ALWAYS strips pool, ads, and member_link across ALL jurisdictions (§4.5)
    if (input.privacySignal && (p === 'pool' || p === 'ads' || p === 'member_link')) {
      continue;
    }
    if (!filteredPurposes.includes(p)) {
      filteredPurposes.push(p);
    }
  }

  const storageAllowed = CONSENT_MODE_RANK[mode] >= CONSENT_MODE_RANK.stats_exempt;
  const sessionStorageAllowed = CONSENT_MODE_RANK[mode] >= CONSENT_MODE_RANK.session;
  const persistentStorageAllowed = mode === 'full';

  return {
    resolved: true,
    mode,
    purposes: filteredPurposes,
    effectiveRegion,
    storageAllowed,
    sessionStorageAllowed,
    persistentStorageAllowed,
    telemetryAllowed: mode !== 'off',
    cappedReason,
  };
}

/**
 * Storage & Cookie firewall enforcing TEL A5 #1 & tel.G10:
 * ZERO reads or writes touch the underlying cookieJar / sessionStorage / localStorage
 * before consent is resolved OR while in `off` / `cookieless` mode.
 */
export class GuardedStorageAdapter {
  private consent: ConsentResolutionResult | null = null;
  private readonly cookieJar?: CookieJarLike;
  private readonly sessionStorage?: StorageLike;
  private readonly localStorage?: StorageLike;
  public blockedAccessCount = 0;

  constructor(deps: {
    readonly cookieJar?: CookieJarLike;
    readonly sessionStorage?: StorageLike;
    readonly localStorage?: StorageLike;
  }) {
    this.cookieJar = deps.cookieJar;
    this.sessionStorage = deps.sessionStorage;
    this.localStorage = deps.localStorage;
  }

  public setResolvedConsent(result: ConsentResolutionResult): void {
    this.consent = result;
  }

  public isResolved(): boolean {
    return this.consent !== null && this.consent.resolved;
  }

  public getCookie(name: string): string | null {
    if (!this.consent || !this.consent.storageAllowed) {
      this.blockedAccessCount += 1;
      return null;
    }
    return this.cookieJar?.getCookie(name) ?? null;
  }

  public setCookie(name: string, value: string, maxAgeSec: number): boolean {
    if (!this.consent || !this.consent.storageAllowed) {
      this.blockedAccessCount += 1;
      return false;
    }
    // Cap script-accessible cookies at 30 min in session mode, 13 months in full/stats_exempt
    const maxAllowedSec = this.consent.mode === 'session' ? 1800 : 34_128_000;
    const boundedAge = Math.min(maxAgeSec, maxAllowedSec);
    this.cookieJar?.setCookie(name, value, boundedAge);
    return true;
  }

  public readSessionWal(key: string): string | null {
    if (!this.consent || !this.consent.sessionStorageAllowed) {
      this.blockedAccessCount += 1;
      return null;
    }
    return this.sessionStorage?.getItem(key) ?? null;
  }

  public writeSessionWal(key: string, value: string): boolean {
    if (!this.consent || !this.consent.sessionStorageAllowed) {
      this.blockedAccessCount += 1;
      return false;
    }
    this.sessionStorage?.setItem(key, value);
    return true;
  }

  public clearSessionWal(key: string): void {
    if (!this.consent || !this.consent.sessionStorageAllowed) return;
    this.sessionStorage?.removeItem(key);
  }

  public readPersistentWal(key: string): string | null {
    if (!this.consent || !this.consent.persistentStorageAllowed) {
      this.blockedAccessCount += 1;
      return null;
    }
    return this.localStorage?.getItem(key) ?? null;
  }

  public writePersistentWal(key: string, value: string): boolean {
    if (!this.consent || !this.consent.persistentStorageAllowed) {
      this.blockedAccessCount += 1;
      return false;
    }
    this.localStorage?.setItem(key, value);
    return true;
  }

  public clearPersistentWal(key: string): void {
    if (!this.consent || !this.consent.persistentStorageAllowed) return;
    this.localStorage?.removeItem(key);
  }
}
