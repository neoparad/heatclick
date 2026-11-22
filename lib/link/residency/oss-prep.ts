/**
 * UGOKI LINK v2 — Open-Source Release Boundary & License Preparation (§11.11 #12 / D-28)
 *
 * Implements Master Spec §11.11 #12:
 * - Explicit separation manifest between public OSS directories and strictly
 *   proprietary/non-public assets (trained models, cross-tenant pooled stats,
 *   bot/agent detection rules, signing keys, ops configs)
 * - Automated boundary leak auditor (`auditOssExportBoundary`): ensures 0 imports
 *   of proprietary paths, 0 secret/private key literals, and 0 unfixed vulnerability
 *   fact references inside the public release tree
 * - Tier-3 self-hosted capability matrix (explicitly declaring unsupported proprietary
 *   features such as bot-rule classification and cross-tenant pooling)
 * - License template generator (`Apache-2.0`, `MIT`, `FSL-1.1-Apache-2.0`), gated
 *   behind Decision 28 (`D-28`) + legal sign-off (`not_entitled` until recorded)
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';

export type OssLicenseId = 'Apache-2.0' | 'MIT' | 'FSL-1.1-Apache-2.0';

export interface OssDirectoryRule {
  readonly pattern: string;
  readonly scope: 'public_oss' | 'proprietary_private';
  readonly rationale: string;
}

export const OSS_BOUNDARY_MANIFEST: readonly OssDirectoryRule[] = [
  // --- Public OSS Scope (§11.11 #12) ---
  {
    pattern: 'packages/sdk-',
    scope: 'public_oss',
    rationale: 'All language SDKs (browser, 8 server languages, mobile) for customer auditability',
  },
  {
    pattern: 'packages/contract/',
    scope: 'public_oss',
    rationale: 'Single authoritative contract schema, urlkey/2, segmenter, response envelope & ledgers',
  },
  {
    pattern: 'packages/wp-plugin/',
    scope: 'public_oss',
    rationale: 'Auditable WordPress two-key companion plugin',
  },
  {
    pattern: 'workers/link-collector/',
    scope: 'public_oss',
    rationale: 'Standard & Segment-compatible collector runtime (identical to Tier 3 self-hosted core)',
  },
  {
    pattern: 'workers/link-wal/',
    scope: 'public_oss',
    rationale: 'Auditable Tier-3 self-hosted WAL writer and storage adapter contract',
  },
  {
    pattern: 'workers/link-loader/',
    scope: 'public_oss',
    rationale: 'Auditable idempotent PV state merger and sealed rollup builder',
  },
  {
    pattern: 'workers/link-live/',
    scope: 'public_oss',
    rationale: 'Auditable live tail ring buffer for self-hosted Tier 3 verification',
  },
  {
    pattern: 'lib/link/export/destinations-catalog.ts',
    scope: 'public_oss',
    rationale: 'Declarative external destination connector specs',
  },
  {
    pattern: 'lib/link/replay/masker.ts',
    scope: 'public_oss',
    rationale: 'In-browser visual replay default-masking logic so customers can audit privacy hiding',
  },

  // --- Strictly Proprietary / Non-Public Scope (§11.11 #12) ---
  {
    pattern: 'lib/link/actors/',
    scope: 'proprietary_private',
    rationale: 'Bot, stealth-agent, RFC 9421, and origin-kit verdict engines remain closed to prevent evasion',
  },
  {
    pattern: 'lib/link/ai-layer/',
    scope: 'proprietary_private',
    rationale: 'Local AI scoring models, certificates, and actor experiment engines remain closed',
  },
  {
    pattern: 'lib/link/ml/',
    scope: 'proprietary_private',
    rationale: 'Trained ML weights, int8 tree runtime, dataset builders, and LLM/distillation guards remain closed',
  },
  {
    pattern: 'lib/link/models/',
    scope: 'proprietary_private',
    rationale: 'Proprietary recommendation, Plackett-Luce ranking, and bandit selection models remain closed',
  },
  {
    pattern: 'lib/link/autonomy/',
    scope: 'proprietary_private',
    rationale: 'Proprietary autonomous agent publishing & safety gate internals remain closed',
  },
  {
    pattern: 'lib/link/evidence/',
    scope: 'proprietary_private',
    rationale: 'Proprietary LORD++ / mSPRT sequential experimentation engines remain closed',
  },
  {
    pattern: 'lib/link/rollout/',
    scope: 'proprietary_private',
    rationale: 'Proprietary adaptive allocation & replay verification engines remain closed',
  },
  {
    pattern: 'lib/link/heatmap-render/',
    scope: 'proprietary_private',
    rationale: 'Proprietary differential-privacy heatmap rendering & differencing guards remain closed',
  },
  {
    pattern: 'lib/link/revenue/',
    scope: 'proprietary_private',
    rationale: 'Proprietary EC catalog attribution, reconciliation, and member summary engines remain closed',
  },
  {
    pattern: 'lib/link/search/',
    scope: 'proprietary_private',
    rationale: 'Proprietary Fréchet/Manski search & AI citation inference engines remain closed',
  },
  {
    pattern: 'lib/link/ask/',
    scope: 'proprietary_private',
    rationale: 'Proprietary natural-language Ask service and pre-LLM privacy filters remain closed',
  },
  {
    pattern: 'lib/link/pool/',
    scope: 'proprietary_private',
    rationale: 'Cross-tenant pooled statistics remain closed',
  },
  {
    pattern: 'lib/link/oem/',
    scope: 'proprietary_private',
    rationale: 'OEM multi-tenant partner billing & flood-defense heuristics remain closed',
  },
  {
    pattern: 'workers/link-signer/',
    scope: 'proprietary_private',
    rationale: 'Control-plane Ed25519 bundle signer remains strictly private',
  },
  {
    pattern: 'workers/link-decision/',
    scope: 'proprietary_private',
    rationale: 'Proprietary edge decision worker remains closed',
  },
  {
    pattern: 'workers/link-zone/',
    scope: 'proprietary_private',
    rationale: 'Proprietary customer-zone edge proxy worker remains closed',
  },
  {
    pattern: 'config/keys/',
    scope: 'proprietary_private',
    rationale: 'Signing keys, peppers, and KMS references remain strictly private',
  },
  {
    pattern: 'ops/',
    scope: 'proprietary_private',
    rationale: 'Production operational topology and secret deployment configs remain private',
  },
];

export interface OssCandidateFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface OssBoundaryFinding {
  readonly relativePath: string;
  readonly severity: 'blocker';
  readonly code:
    | 'PROPRIETARY_PATH_IN_OSS_BUNDLE'
    | 'UNCLASSIFIED_PATH_IN_OSS_BUNDLE'
    | 'PROPRIETARY_IMPORT_LEAK'
    | 'SECRET_OR_KEY_LITERAL_LEAK'
    | 'UNFIXED_WEAKNESS_DOC_REF';
  readonly detail: string;
}

export interface OssBoundaryAuditResult {
  readonly passed: boolean;
  readonly filesScanned: number;
  readonly findings: readonly OssBoundaryFinding[];
}

export interface SelfHostedCapabilityRow {
  readonly capability: string;
  readonly supportedInSelfHosted: boolean;
  readonly statusWhenUnsupported: 'supported' | 'not_supported_self_hosted';
  readonly note: string;
}

export const SELF_HOSTED_CAPABILITY_MATRIX: readonly SelfHostedCapabilityRow[] = [
  {
    capability: 'standard_telemetry_collection_and_wal',
    supportedInSelfHosted: true,
    statusWhenUnsupported: 'supported',
    note: 'Runs using customer-owned signing keys and trust root (§5.12 Tier 3)',
  },
  {
    capability: 'segment_compatible_ingest_and_custom_events',
    supportedInSelfHosted: true,
    statusWhenUnsupported: 'supported',
    note: 'Full declarative contract validation and local R2/S3/GCS storage',
  },
  {
    capability: 'visual_replay_browser_masker',
    supportedInSelfHosted: true,
    statusWhenUnsupported: 'supported',
    note: 'Auditable client-side default-masking logic',
  },
  {
    capability: 'proprietary_bot_and_stealth_agent_detection_rules',
    supportedInSelfHosted: false,
    statusWhenUnsupported: 'not_supported_self_hosted',
    note: 'Proprietary bot heuristics are excluded from OSS to prevent evasion (§11.11 #12)',
  },
  {
    capability: 'cross_tenant_pooled_benchmarks_and_federated_models',
    supportedInSelfHosted: false,
    statusWhenUnsupported: 'not_supported_self_hosted',
    note: 'Cross-tenant pooling and LINK-trained proprietary models require LINK-hosted service',
  },
];

const PROPRIETARY_PREFIXES = OSS_BOUNDARY_MANIFEST.filter(
  (r) => r.scope === 'proprietary_private'
).map((r) => r.pattern);

const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'private_key_pem', re: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { name: 'ugk_sec_live_key', re: /ugk_sec_live_key_[0-9a-f]{16}_[A-Za-z0-9_-]{8,}/ },
  { name: 'ugk_oem_live_key', re: /ugk_oem_live_oem_[0-9a-f]{16}_[A-Za-z0-9_-]{8,}/ },
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

const UNFIXED_WEAKNESS_PATTERNS: ReadonlyArray<RegExp> = [
  /facts\/repo-saas-[a-z-]+\.md/i,
  /UNFIXED_SECURITY_WEAKNESS/i,
];

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyPathOssScope(
  relativePath: string
): 'public_oss' | 'proprietary_private' | 'unclassified' {
  const norm = normalizePosixPath(relativePath);
  for (const rule of OSS_BOUNDARY_MANIFEST) {
    if (norm.startsWith(rule.pattern) || norm === rule.pattern) {
      return rule.scope;
    }
  }
  return 'unclassified';
}

/**
 * Mechanically audits candidate OSS export files to guarantee:
 * - Zero proprietary paths included in the OSS export bundle
 * - Zero imports/requires referencing proprietary directories
 * - Zero embedded private keys or live secret tokens
 * - Zero references to unfixed vulnerability working files (§11.11 #12)
 */
export function auditOssExportBoundary(
  candidateFiles: readonly OssCandidateFile[]
): OssBoundaryAuditResult {
  const findings: OssBoundaryFinding[] = [];

  for (const file of candidateFiles) {
    const normPath = normalizePosixPath(file.relativePath);
    const scope = classifyPathOssScope(normPath);

    if (scope === 'proprietary_private') {
      findings.push({
        relativePath: normPath,
        severity: 'blocker',
        code: 'PROPRIETARY_PATH_IN_OSS_BUNDLE',
        detail: `File "${normPath}" belongs to proprietary_private scope and must not be exported to OSS`,
      });
    } else if (scope === 'unclassified') {
      findings.push({
        relativePath: normPath,
        severity: 'blocker',
        code: 'UNCLASSIFIED_PATH_IN_OSS_BUNDLE',
        detail: `File "${normPath}" is unclassified in OSS_BOUNDARY_MANIFEST; fail-closed default-deny blocks unreviewed paths from OSS export`,
      });
    }

    // Scan import / require specifiers for proprietary path leaks
    const importRegex = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m: RegExpExecArray | null = importRegex.exec(file.content);
    while (m !== null) {
      const spec = (m[1] ?? m[2] ?? '').replace(/\\/g, '/');
      for (const propPrefix of PROPRIETARY_PREFIXES) {
        const cleanPrefix = propPrefix.replace(/\/$/, '');
        if (spec.includes(cleanPrefix)) {
          findings.push({
            relativePath: normPath,
            severity: 'blocker',
            code: 'PROPRIETARY_IMPORT_LEAK',
            detail: `Public OSS file "${normPath}" imports proprietary module "${spec}"`,
          });
        }
      }
      m = importRegex.exec(file.content);
    }

    // Scan for secret/private-key literals
    for (const sp of SECRET_PATTERNS) {
      if (sp.re.test(file.content)) {
        findings.push({
          relativePath: normPath,
          severity: 'blocker',
          code: 'SECRET_OR_KEY_LITERAL_LEAK',
          detail: `Detected potential secret/key material (${sp.name}) in "${normPath}"`,
        });
      }
    }

    // Scan for unfixed weakness report pointers
    for (const wp of UNFIXED_WEAKNESS_PATTERNS) {
      if (wp.test(file.content)) {
        findings.push({
          relativePath: normPath,
          severity: 'blocker',
          code: 'UNFIXED_WEAKNESS_DOC_REF',
          detail: `File "${normPath}" references internal vulnerability fact document; resolve & scrub before OSS publish`,
        });
      }
    }
  }

  return {
    passed: findings.length === 0,
    filesScanned: candidateFiles.length,
    findings,
  };
}

export interface OssReleasePrepResult {
  readonly releaseEntitled: boolean;
  readonly status: 'ok' | 'not_entitled';
  readonly reason: string;
  readonly licenseId: OssLicenseId;
  readonly licenseHeaderTemplate: string;
  readonly boundaryAudit: OssBoundaryAuditResult;
  readonly selfHostedCapabilities: readonly SelfHostedCapabilityRow[];
}

export function generateOssLicenseHeader(
  licenseId: OssLicenseId,
  copyrightHolder = 'UGOKI LINK Contributors',
  year = 2026
): string {
  if (licenseId === 'MIT') {
    return `// SPDX-License-Identifier: MIT\n// Copyright (c) ${year} ${copyrightHolder}`;
  }
  if (licenseId === 'FSL-1.1-Apache-2.0') {
    return `// SPDX-License-Identifier: FSL-1.1-Apache-2.0\n// Copyright (c) ${year} ${copyrightHolder} — Converts to Apache-2.0 after 2 years.`;
  }
  return `// SPDX-License-Identifier: Apache-2.0\n// Copyright (c) ${year} ${copyrightHolder}`;
}

/**
 * Evaluates full OSS release readiness: requires Decision 28 (`D-28`) + legal
 * sign-off AND clean `auditOssExportBoundary` AND `allKnownWeaknessesFixed === true`.
 */
export function evaluateOssReleaseReadiness(args: {
  readonly candidateFiles: readonly OssCandidateFile[];
  readonly licenseId: OssLicenseId;
  readonly allKnownWeaknessesFixed: boolean;
  readonly decision28ApprovedOverride?: boolean;
  readonly legalSignOffOverride?: boolean;
}): OssReleasePrepResult {
  const boundaryAudit = auditOssExportBoundary(args.candidateFiles);
  const licenseHeaderTemplate = generateOssLicenseHeader(args.licenseId);

  const ledgerD28 = requireDecisionEntitled('D-28', { enforceLegalSignOff: true });
  const d28Ok =
    args.decision28ApprovedOverride !== undefined &&
    args.legalSignOffOverride !== undefined
      ? args.decision28ApprovedOverride && args.legalSignOffOverride
      : ledgerD28.entitled;

  if (!d28Ok) {
    return {
      releaseEntitled: false,
      status: 'not_entitled',
      reason: 'decision_28_and_legal_signoff_required_before_oss_release',
      licenseId: args.licenseId,
      licenseHeaderTemplate,
      boundaryAudit,
      selfHostedCapabilities: SELF_HOSTED_CAPABILITY_MATRIX,
    };
  }

  if (!args.allKnownWeaknessesFixed) {
    return {
      releaseEntitled: false,
      status: 'not_entitled',
      reason: 'known_pre_release_weaknesses_must_be_fixed_first (§11.11 #12)',
      licenseId: args.licenseId,
      licenseHeaderTemplate,
      boundaryAudit,
      selfHostedCapabilities: SELF_HOSTED_CAPABILITY_MATRIX,
    };
  }

  if (!boundaryAudit.passed) {
    return {
      releaseEntitled: false,
      status: 'not_entitled',
      reason: `oss_boundary_audit_failed:${boundaryAudit.findings.length}_findings`,
      licenseId: args.licenseId,
      licenseHeaderTemplate,
      boundaryAudit,
      selfHostedCapabilities: SELF_HOSTED_CAPABILITY_MATRIX,
    };
  }

  return {
    releaseEntitled: true,
    status: 'ok',
    reason: 'oss_release_ready',
    licenseId: args.licenseId,
    licenseHeaderTemplate,
    boundaryAudit,
    selfHostedCapabilities: SELF_HOSTED_CAPABILITY_MATRIX,
  };
}
