/**
 * Unit tests for src/visitor-cookie.ts (第一者 visitor_id Set-Cookie 化の純関数)
 *
 * 設計書: docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md v3 §3-1 / §6
 *
 * 他の test ファイルの「等価実装」方式とは異なり、Node 24 の TypeScript type-stripping で
 * **実コードを直接 import** して検証する (等価実装は実装と乖離しても検出できないため)。
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/visitor-cookie.test.mjs
 *
 * Node 22.6+ (type stripping)。Node 24 では既定で有効。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VISITOR_ID_COOKIE,
  VISITOR_ID_MAX_AGE_SEC,
  VISITOR_ID_RE,
  buildVisitorIdSetCookie,
  isValidVisitorId,
  parseVisitorIdCookie,
  pickPayloadVisitorId,
  resolveCanonicalVisitorId,
} from '../src/visitor-cookie.ts';

const OK_VID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const OK_VID_2 = 'zzzzzzzz-0000-1111-2222-333333333333';

// ── isValidVisitorId / VISITOR_ID_RE ─────────────────────────────────

test('isValidVisitorId: accepts UUID-like and 8..64 [A-Za-z0-9_-]', () => {
  assert.equal(isValidVisitorId(OK_VID), true);
  assert.equal(isValidVisitorId('abcdefgh'), true, '8 chars = lower bound');
  assert.equal(isValidVisitorId('a'.repeat(64)), true, '64 chars = upper bound');
  assert.equal(isValidVisitorId('A-Z_09'.padEnd(12, 'x')), true);
});

test('isValidVisitorId: rejects too short/long, non-string, and attribute-injection characters', () => {
  assert.equal(isValidVisitorId('abcdefg'), false, '7 chars');
  assert.equal(isValidVisitorId('a'.repeat(65)), false, '65 chars');
  assert.equal(isValidVisitorId(''), false);
  assert.equal(isValidVisitorId(null), false);
  assert.equal(isValidVisitorId(undefined), false);
  assert.equal(isValidVisitorId(12345678), false);
  // Cookie 属性注入の典型
  assert.equal(isValidVisitorId('abcdefgh; Domain=evil.com'), false);
  assert.equal(isValidVisitorId('abcdefgh; HttpOnly'), false);
  assert.equal(isValidVisitorId('abcd\r\nSet-Cookie: x=y'), false, 'CRLF header injection');
  assert.equal(isValidVisitorId('abcdefgh=1'), false, '= is not allowed');
  assert.equal(isValidVisitorId('"abcdefgh"'), false, 'quoted value is rejected (treated as absent)');
  assert.equal(isValidVisitorId('abcd efgh'), false, 'whitespace');
  assert.equal(isValidVisitorId('あいうえおかきく'), false, 'non-ASCII');
});

// ── parseVisitorIdCookie ─────────────────────────────────────────────

test('parseVisitorIdCookie: absent header / absent cookie → null, not duplicate, not invalid', () => {
  assert.deepEqual(parseVisitorIdCookie(null), { value: null, duplicate: false, invalid: false });
  assert.deepEqual(parseVisitorIdCookie(undefined), { value: null, duplicate: false, invalid: false });
  assert.deepEqual(parseVisitorIdCookie(''), { value: null, duplicate: false, invalid: false });
  assert.deepEqual(parseVisitorIdCookie('foo=bar; sess=abc'), { value: null, duplicate: false, invalid: false });
});

test('parseVisitorIdCookie: single valid cookie among others is extracted (whitespace tolerant)', () => {
  const header = `sess=SESSIONTOKEN;  ${VISITOR_ID_COOKIE}=${OK_VID} ; other=1`;
  assert.deepEqual(parseVisitorIdCookie(header), { value: OK_VID, duplicate: false, invalid: false });
});

test('parseVisitorIdCookie: name must match exactly (no prefix/suffix confusion)', () => {
  assert.equal(parseVisitorIdCookie(`x${VISITOR_ID_COOKIE}=${OK_VID}`).value, null);
  assert.equal(parseVisitorIdCookie(`${VISITOR_ID_COOKIE}x=${OK_VID}`).value, null);
  assert.equal(parseVisitorIdCookie(`${VISITOR_ID_COOKIE.toUpperCase()}=${OK_VID}`).value, null);
});

test('parseVisitorIdCookie: duplicate same-name cookies → value null + duplicate=true (cookie tossing absorption)', () => {
  const header = `${VISITOR_ID_COOKIE}=${OK_VID}; ${VISITOR_ID_COOKIE}=${OK_VID_2}`;
  const r = parseVisitorIdCookie(header);
  assert.equal(r.value, null);
  assert.equal(r.duplicate, true);
  assert.equal(r.invalid, false);
  // even if both values are identical, duplicates are still refused (deterministic rule)
  const same = parseVisitorIdCookie(`${VISITOR_ID_COOKIE}=${OK_VID}; ${VISITOR_ID_COOKIE}=${OK_VID}`);
  assert.equal(same.value, null);
  assert.equal(same.duplicate, true);
});

test('parseVisitorIdCookie: single but malformed cookie → value null + invalid=true', () => {
  const r = parseVisitorIdCookie(`${VISITOR_ID_COOKIE}=bad; Domain=evil.com`);
  // ';' splits the attribute off, leaving "bad" (3 chars) → invalid by length
  assert.equal(r.value, null);
  assert.equal(r.invalid, true);
  assert.equal(r.duplicate, false);
  const r2 = parseVisitorIdCookie(`${VISITOR_ID_COOKIE}=${'x'.repeat(65)}`);
  assert.equal(r2.value, null);
  assert.equal(r2.invalid, true);
});

// ── resolveCanonicalVisitorId (priority: cookie > payload > mint) ────

test('resolveCanonicalVisitorId: valid cookie wins over payload', () => {
  const r = resolveCanonicalVisitorId({
    cookieHeader: `${VISITOR_ID_COOKIE}=${OK_VID}`,
    payloadVisitorId: OK_VID_2,
  });
  assert.deepEqual(r, { vid: OK_VID, source: 'cookie' });
});

test('resolveCanonicalVisitorId: no cookie → valid payload (existing JS-issued vid continuity)', () => {
  const r = resolveCanonicalVisitorId({ cookieHeader: null, payloadVisitorId: OK_VID_2 });
  assert.deepEqual(r, { vid: OK_VID_2, source: 'payload' });
});

test('resolveCanonicalVisitorId: duplicate cookie → falls back to payload', () => {
  const r = resolveCanonicalVisitorId({
    cookieHeader: `${VISITOR_ID_COOKIE}=${OK_VID}; ${VISITOR_ID_COOKIE}=${OK_VID_2}`,
    payloadVisitorId: OK_VID_2,
  });
  assert.deepEqual(r, { vid: OK_VID_2, source: 'payload' });
});

test('resolveCanonicalVisitorId: invalid cookie AND invalid payload → mint (never adopt an unvalidated value)', () => {
  const mint = () => 'minted-0000-1111-2222-333333333333';
  const r = resolveCanonicalVisitorId({
    cookieHeader: `${VISITOR_ID_COOKIE}=nope`,
    payloadVisitorId: 'evil; Domain=evil.com',
    mint,
  });
  assert.deepEqual(r, { vid: 'minted-0000-1111-2222-333333333333', source: 'mint' });
});

test('resolveCanonicalVisitorId: default mint produces a value that passes the same regex', () => {
  const r = resolveCanonicalVisitorId({ cookieHeader: null, payloadVisitorId: undefined });
  assert.equal(r.source, 'mint');
  assert.match(r.vid, VISITOR_ID_RE);
});

// ── buildVisitorIdSetCookie ──────────────────────────────────────────

test('buildVisitorIdSetCookie: exact attribute set (host-only, no Domain, no HttpOnly, Lax, Secure, 400d)', () => {
  const h = buildVisitorIdSetCookie(OK_VID);
  assert.equal(h, `${VISITOR_ID_COOKIE}=${OK_VID}; Max-Age=${VISITOR_ID_MAX_AGE_SEC}; Path=/; Secure; SameSite=Lax`);
  assert.equal(VISITOR_ID_MAX_AGE_SEC, 400 * 24 * 60 * 60, 'Max-Age = 400 days exactly');
  assert.doesNotMatch(h, /Domain=/i, 'Domain must be absent (host-only) so the JS cookie is replaced, not duplicated');
  assert.doesNotMatch(h, /HttpOnly/i, 'HttpOnly must be absent (scenario-runtime reads document.cookie)');
  assert.doesNotMatch(h, /SameSite=None/i, 'SameSite=None is forbidden (design D-3)');
});

test('buildVisitorIdSetCookie: refuses to serialize an unvalidated value (last line of defense against attribute injection)', () => {
  assert.throws(() => buildVisitorIdSetCookie('abcdefgh; Domain=evil.com'));
  assert.throws(() => buildVisitorIdSetCookie(''));
});

// ── pickPayloadVisitorId ─────────────────────────────────────────────

test('pickPayloadVisitorId: first valid visitor_id among events; skips invalid/missing', () => {
  assert.equal(pickPayloadVisitorId([]), null);
  assert.equal(pickPayloadVisitorId([{ event_type: 'pageview' }]), null);
  assert.equal(pickPayloadVisitorId([{ visitor_id: 'bad' }, { visitor_id: OK_VID }]), OK_VID);
  assert.equal(pickPayloadVisitorId([{ visitor_id: 'x; Domain=evil.com' }]), null);
});
