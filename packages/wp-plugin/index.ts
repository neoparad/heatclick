/**
 * UGOKI LINK v2 — WordPress Companion Plugin Contract & Conformance Engine (`packages/wp-plugin`)
 */

export {
  sanitizeWpKsesPost,
  signWpCommand,
  WpPluginEngine,
  auditPhpPluginSource,
  type WpCommandKind,
  type WpOwnerLocalPolicy,
  type WpPostRecord,
  type WpPreImageRecord,
  type WpCommandPayload,
  type SignedWpCommandEnvelope,
  type WpCommandResult,
  type PhpStaticAuditResult,
} from './contract';
