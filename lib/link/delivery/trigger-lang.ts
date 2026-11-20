/**
 * UGOKI LINK v2 — Unified Trigger Language AST & 3-Environment Evaluator (§10.4)
 *
 * One AST definition produces identical evaluation results across:
 *   1. Browser SDK (`sdk`)
 *   2. Edge Worker (`edge`)
 *   3. Historical data replay (`replay`)
 *
 * Security invariants:
 *   - Only whitelisted behavioral / context signals are permitted.
 *   - Any reference to User-Agent, IP, automation flags, or actor class is REJECTED AT COMPILE TIME!
 *   - Uses Kleene 3-valued logic (`true | false | 'unknown'`); `unknown` is NEVER treated as `false`.
 */

import { canonicalJson, sha256Hex } from '@/packages/contract/response';

export const ALLOWED_TRIGGER_SIGNALS = [
  'section_reach',
  'focal_dwell_ms',
  'rage_or_dead_click',
  'input_hesitation_ms',
  'exit_intent',
  'site_context',
  'model_score',
] as const;

export type AllowedTriggerSignal = (typeof ALLOWED_TRIGGER_SIGNALS)[number];

const ALLOWED_SIGNAL_SET: ReadonlySet<string> = new Set(ALLOWED_TRIGGER_SIGNALS);

const FORBIDDEN_ACTOR_SIGNAL_SET: ReadonlySet<string> = new Set([
  'user_agent',
  'useragent',
  'ua',
  'ip',
  'client_ip',
  'remote_addr',
  'automation_flag',
  'automation_flags',
  'webdriver',
  'actor_class',
  'actor_kind',
  'is_bot',
  'is_agent',
  'bot_score',
]);

export type TriggerComparator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export interface TriggerLeafNode {
  readonly type: 'signal';
  readonly signal: string;
  readonly op: TriggerComparator;
  readonly value: string | number | boolean | ReadonlyArray<string | number>;
}

export interface TriggerLogicalNode {
  readonly type: 'and' | 'or' | 'not';
  readonly children: ReadonlyArray<TriggerAstNode>;
}

export type TriggerAstNode = TriggerLeafNode | TriggerLogicalNode;

export type TriggerTriValue = true | false | 'unknown';

export type TriggerSignalBag = Readonly<
  Partial<Record<AllowedTriggerSignal, string | number | boolean | null | undefined>>
>;

export class TriggerCompileError extends Error {
  public readonly code: 'FORBIDDEN_ACTOR_SIGNAL' | 'UNKNOWN_SIGNAL' | 'EMPTY_LOGICAL_NODE';
  public readonly offendingSignal?: string;
  constructor(
    code: 'FORBIDDEN_ACTOR_SIGNAL' | 'UNKNOWN_SIGNAL' | 'EMPTY_LOGICAL_NODE',
    message: string,
    offendingSignal?: string
  ) {
    super(message);
    this.name = 'TriggerCompileError';
    this.code = code;
    this.offendingSignal = offendingSignal;
  }
}

export interface CompiledTriggerProgram {
  readonly ast: TriggerAstNode;
  readonly astHash: string;
  readonly referencedSignals: ReadonlyArray<AllowedTriggerSignal>;
}

/**
 * Compiles & validates a Trigger AST once. Throws `TriggerCompileError` immediately
 * if any actor/UA/IP/automation signal or unwhitelisted signal is referenced.
 */
export function compileTriggerAst(ast: TriggerAstNode): CompiledTriggerProgram {
  const referenced = new Set<AllowedTriggerSignal>();

  const validate = (node: TriggerAstNode): void => {
    if (node.type === 'signal') {
      const normalized = node.signal.trim().toLowerCase();
      if (FORBIDDEN_ACTOR_SIGNAL_SET.has(normalized)) {
        throw new TriggerCompileError(
          'FORBIDDEN_ACTOR_SIGNAL',
          `Trigger language forbids actor/identity signal "${node.signal}" (§10.4)`,
          node.signal
        );
      }
      if (!ALLOWED_SIGNAL_SET.has(node.signal)) {
        throw new TriggerCompileError(
          'UNKNOWN_SIGNAL',
          `Signal "${node.signal}" is not in the §10.4 trigger whitelist`,
          node.signal
        );
      }
      referenced.add(node.signal as AllowedTriggerSignal);
      return;
    }

    if (node.children.length === 0) {
      throw new TriggerCompileError(
        'EMPTY_LOGICAL_NODE',
        `Logical node "${node.type}" must have at least one child`
      );
    }
    for (const child of node.children) {
      validate(child);
    }
  };

  validate(ast);

  return {
    ast,
    astHash: sha256Hex(canonicalJson(ast)),
    referencedSignals: [...referenced].sort(),
  };
}

function evalLeaf(node: TriggerLeafNode, bag: TriggerSignalBag): TriggerTriValue {
  const actual = bag[node.signal as AllowedTriggerSignal];
  if (actual === undefined || actual === null) return 'unknown';
  if (typeof actual === 'string' && actual.trim().toLowerCase() === 'unknown') return 'unknown';
  if (typeof actual === 'number' && !Number.isFinite(actual)) return 'unknown';

  switch (node.op) {
    case 'eq':
      return actual === node.value;
    case 'neq':
      return actual !== node.value;
    case 'gt':
      return typeof actual === 'number' && typeof node.value === 'number' ? actual > node.value : 'unknown';
    case 'gte':
      return typeof actual === 'number' && typeof node.value === 'number' ? actual >= node.value : 'unknown';
    case 'lt':
      return typeof actual === 'number' && typeof node.value === 'number' ? actual < node.value : 'unknown';
    case 'lte':
      return typeof actual === 'number' && typeof node.value === 'number' ? actual <= node.value : 'unknown';
    case 'in':
      return Array.isArray(node.value)
        ? (node.value as ReadonlyArray<string | number>).includes(actual as string | number)
        : 'unknown';
  }
}

/**
 * Deterministic 3-valued evaluator shared identically by SDK, Edge, and Historical Replay.
 */
export function evaluateCompiledTrigger(
  program: CompiledTriggerProgram,
  signals: TriggerSignalBag,
  _environment: 'sdk' | 'edge' | 'replay' = 'sdk'
): TriggerTriValue {
  const walk = (node: TriggerAstNode): TriggerTriValue => {
    if (node.type === 'signal') {
      return evalLeaf(node, signals);
    }
    if (node.type === 'not') {
      const r = walk(node.children[0]);
      return r === 'unknown' ? 'unknown' : !r;
    }
    if (node.type === 'and') {
      let hasUnknown = false;
      for (const child of node.children) {
        const r = walk(child);
        if (r === false) return false;
        if (r === 'unknown') hasUnknown = true;
      }
      return hasUnknown ? 'unknown' : true;
    }
    // or
    let hasUnknown = false;
    for (const child of node.children) {
      const r = walk(child);
      if (r === true) return true;
      if (r === 'unknown') hasUnknown = true;
    }
    return hasUnknown ? 'unknown' : false;
  };

  return walk(program.ast);
}
