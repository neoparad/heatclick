/**
 * UGOKI LINK v2 — Signer Service & Unified Signed Config Bundle (`workers/link-signer`)
 */

export * from './types';
export {
  canonicalJson,
  sha256Bytes,
  sha256Hex,
  sha256Sri,
  generateEd25519KeyPair,
  importEd25519PublicKey,
  signEd25519Bytes,
  verifyEd25519Bytes,
  signCanonicalObject,
  verifyCanonicalObject,
  bytesToBase64,
  base64ToBytes,
  type Ed25519KeyPairHandle,
} from './crypto';
export {
  ALLOWED_INSERTABLE_TAGS,
  FORBIDDEN_HOST_TAGS,
  ALLOWED_SET_ATTR_NAMES,
  ALLOWED_INSERT_ATTR_NAMES,
  ALLOWED_STYLE_PROPERTIES,
  validateClosedGrammarAction,
  validateAffiliateBindingsAgainstOfflineAllowlist,
  detectPrivacyRelaxation,
  resolveEffectiveConsentMode,
  type GrammarValidationResult,
  type PrivacyRelaxationCheck,
} from './grammar-validator';
export {
  SignerPolicyError,
  SignerCasConflictError,
  InMemoryBundleStateStore,
  SignerService,
  computeRelaxationDiffSha256,
  createSignedRelaxationApproval,
  signReleaseManifest,
  verifyReleaseManifest,
  signConfigBundle,
  verifyConfigBundle,
} from './signer';
export { createSignerWorkerHandler, type SignerWorkerDeps } from './worker';
