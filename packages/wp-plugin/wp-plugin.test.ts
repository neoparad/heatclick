import * as fs from 'fs';
import * as path from 'path';
import { generateEd25519KeyPair, sha256Hex } from '../../workers/link-signer';
import {
  WpPluginEngine,
  auditPhpPluginSource,
  computeWpLocalApprovalDigest,
  extractIndexableSeoSignature,
  normalizeWpHomeUrl,
  sanitizeWpKsesPost,
  signWpCommand,
} from './contract';

describe('packages/wp-plugin — WordPress Companion Plugin Protocol & del.D20 Conformance', () => {
  const futureIso = new Date(Date.now() + 3600_000).toISOString();

  test('static audit passes cleanly on ugokilink-companion.php and catches unsafe PHP constructs', () => {
    const phpPath = path.join(__dirname, 'ugokilink-companion.php');
    const phpSource = fs.readFileSync(phpPath, 'utf8');
    const audit = auditPhpPluginSource(phpSource);
    expect(audit.errors).toEqual([]);
    expect(audit.passed).toBe(true);

    // Negative check: dangerous constructs must fail audit
    const badEval = auditPhpPluginSource(`${phpSource}\n<?php eval($_POST['x']); ?>`);
    expect(badEval.passed).toBe(false);
    expect(badEval.errors.some((e) => e.includes('eval()'))).toBe(true);

    const badKses = auditPhpPluginSource(`${phpSource}\n<?php kses_remove_filters(); ?>`);
    expect(badKses.passed).toBe(false);
    expect(badKses.errors.some((e) => e.includes('KSES'))).toBe(true);
  });

  test('verifies offline-pinned Ed25519 signature, rejects unknown kid, expired commands, and seq replay', async () => {
    const keyPair = await generateEd25519KeyPair();
    const attacker = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['ugk-wp-2026', keyPair.publicKey]]),
    });

    // Unknown kid -> 401
    const unknownKidEnv = await signWpCommand(
      { command: 'capabilities', seq: 1, not_after: futureIso },
      keyPair.privateKey,
      'unknown-kid'
    );
    expect((await engine.handleSignedCommand(unknownKidEnv)).status).toBe(401);

    // Wrong signing key -> 401
    const badSigEnv = await signWpCommand(
      { command: 'capabilities', seq: 1, not_after: futureIso },
      attacker.privateKey,
      'ugk-wp-2026'
    );
    expect((await engine.handleSignedCommand(badSigEnv)).status).toBe(401);

    // Expired command -> 401
    const expiredEnv = await signWpCommand(
      { command: 'capabilities', seq: 1, not_after: new Date(Date.now() - 1000).toISOString() },
      keyPair.privateKey,
      'ugk-wp-2026'
    );
    const expiredRes = await engine.handleSignedCommand(expiredEnv);
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.error).toBe('command_expired');

    // Valid seq=5 -> 200
    const okEnv = await signWpCommand(
      { command: 'capabilities', seq: 5, not_after: futureIso },
      keyPair.privateKey,
      'ugk-wp-2026'
    );
    expect((await engine.handleSignedCommand(okEnv)).status).toBe(200);

    // Replayed seq=5 or lower seq=4 -> 409 seq_replay_rejected
    const replayRes = await engine.handleSignedCommand(okEnv);
    expect(replayRes.status).toBe(409);
    expect(replayRes.error).toBe('seq_replay_rejected');

    const lowerSeqEnv = await signWpCommand(
      { command: 'capabilities', seq: 4, not_after: futureIso },
      keyPair.privateKey,
      'ugk-wp-2026'
    );
    expect((await engine.handleSignedCommand(lowerSeqEnv)).error).toBe('seq_replay_rejected');
  });

  test('enforces two-key Owner Local Policy (§10.9): UGOKI credentials can NEVER exceed wp-admin policy', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 1,
        require_admin_confirmation_classes: ['price', 'indexable_major'],
      },
    });

    const content = '<p>Buy now</p>';
    const sha = await sha256Hex(content);
    const mod = '2026-11-20T00:00:00.000Z';
    engine.seedPost({
      post_id: 101,
      permalink: '/post-101/',
      content,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    // 1. Class requiring admin confirmation rejected without confirmation
    const priceEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        post_id: 101,
        change_class: 'price',
        expected_content_sha256: sha,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: 10,
        replacement_html: 'Sale 50% off',
      },
      keyPair.privateKey,
      'k1'
    );
    const priceRes = await engine.handleSignedCommand(priceEnv);
    expect(priceRes.status).toBe(403);
    expect(priceRes.error).toBe('owner_local_policy_requires_admin_confirmation');

    // 2. Unlisted change_class rejected
    const unlistedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 2,
        not_after: futureIso,
        post_id: 101,
        change_class: 'layout_structural',
        expected_content_sha256: sha,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: 10,
        replacement_html: 'Order today',
      },
      keyPair.privateKey,
      'k1'
    );
    const unlistedRes = await engine.handleSignedCommand(unlistedEnv);
    expect(unlistedRes.status).toBe(403);
    expect(unlistedRes.error).toBe('change_class_not_in_owner_local_policy');

    // 3. Allowed auto class succeeds (uses 1 of 1 daily cap)
    const okEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 3,
        not_after: futureIso,
        post_id: 101,
        promotion_id: 'promo_1',
        change_class: 'cta_copy',
        expected_content_sha256: sha,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: 10,
        replacement_html: 'Order today',
      },
      keyPair.privateKey,
      'k1'
    );
    const okRes = await engine.handleSignedCommand(okEnv);
    expect(okRes.status).toBe(200);
    expect(engine.getPost(101)?.content).toBe('<p>Order today</p>');

    // 4. Second apply exceeds daily_apply_cap -> 429
    const postAfter = engine.getPost(101)!;
    const capEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 4,
        not_after: futureIso,
        post_id: 101,
        change_class: 'cta_copy',
        expected_content_sha256: await sha256Hex(postAfter.content),
        expected_modified_gmt: postAfter.modified_gmt,
        byte_start: 3,
        byte_end: 14,
        replacement_html: 'Get started',
      },
      keyPair.privateKey,
      'k1'
    );
    const capRes = await engine.handleSignedCommand(capEnv);
    expect(capRes.status).toBe(429);
    expect(capRes.error).toBe('owner_daily_apply_cap_exceeded');

    // 5. Local stop toggled in wp-admin blocks everything immediately
    engine.setOwnerLocalPolicyFromWpAdmin({ local_stop: true, daily_apply_cap: 100 });
    const stoppedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 5,
        not_after: futureIso,
        post_id: 101,
        change_class: 'cta_copy',
        owner_wp_admin_confirmed: true,
        expected_content_sha256: await sha256Hex(postAfter.content),
        expected_modified_gmt: postAfter.modified_gmt,
        byte_start: 3,
        byte_end: 14,
        replacement_html: 'Should fail',
      },
      keyPair.privateKey,
      'k1'
    );
    const stoppedRes = await engine.handleSignedCommand(stoppedEnv);
    expect(stoppedRes.status).toBe(403);
    expect(stoppedRes.error).toBe('owner_local_stop_active');
  });

  test('refuses apply/restore under edit lock, enforces CAS + KSES sanitization, and handles 409 rollback_conflict', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      ownerPolicy: { allowed_auto_classes: ['cta_copy'], daily_apply_cap: 50 },
    });

    const original = '<div class="cta"><a href="/go">Click Here</a></div>';
    const origSha = await sha256Hex(original);
    const origMod = '2026-11-20T01:00:00.000Z';
    engine.seedPost({
      post_id: 202,
      permalink: '/post-202/',
      content: original,
      modified_gmt: origMod,
      edit_lock_user_id: 7, // human editor active!
    });

    // Edit lock active -> 409
    const lockedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        post_id: 202,
        promotion_id: 'p1',
        change_class: 'cta_copy',
        expected_content_sha256: origSha,
        expected_modified_gmt: origMod,
        byte_start: 31,
        byte_end: 41,
        replacement_html: 'Start Free',
      },
      keyPair.privateKey,
      'k1'
    );
    const lockedRes = await engine.handleSignedCommand(lockedEnv);
    expect(lockedRes.status).toBe(409);
    expect(lockedRes.error).toBe('edit_lock_active');
    expect(engine.getPost(202)?.content).toBe(original);

    // Unlock, test CAS mismatch on modified_gmt
    engine.setPostEditLock(202, null);
    const badModEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 2,
        not_after: futureIso,
        post_id: 202,
        promotion_id: 'p1',
        change_class: 'cta_copy',
        expected_content_sha256: origSha,
        expected_modified_gmt: '2025-01-01T00:00:00.000Z',
        byte_start: 31,
        byte_end: 41,
        replacement_html: 'Start Free',
      },
      keyPair.privateKey,
      'k1'
    );
    expect((await engine.handleSignedCommand(badModEnv)).error).toBe('modified_gmt_mismatch');

    // Apply with injected XSS -> mandatory KSES sanitization strips script & handler
    const xssApplyEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 3,
        not_after: futureIso,
        post_id: 202,
        promotion_id: 'p_xss',
        change_class: 'cta_copy',
        expected_content_sha256: origSha,
        expected_modified_gmt: origMod,
        byte_start: 31,
        byte_end: 41,
        replacement_html: 'Start Free<script>alert(1)</script><img src=x onerror="steal()">',
      },
      keyPair.privateKey,
      'k1'
    );
    const xssRes = await engine.handleSignedCommand(xssApplyEnv);
    expect(xssRes.status).toBe(200);
    const afterApply = engine.getPost(202)!.content;
    expect(afterApply).not.toContain('<script');
    expect(afterApply).not.toContain('onerror');
    expect(afterApply).toContain('Start Free');
    expect(sanitizeWpKsesPost('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');

    // Verify endpoint matches post-image SHA
    const verifyEnv = await signWpCommand(
      {
        command: 'verify',
        seq: 4,
        not_after: futureIso,
        post_id: 202,
        expected_sha256: xssRes.post_image_sha256,
      },
      keyPair.privateKey,
      'k1'
    );
    expect((await engine.handleSignedCommand(verifyEnv)).origin_ok).toBe(true);

    // Concurrent human edit after apply -> restore MUST return 409 rollback_conflict with 3-way merge
    await engine.humanEditPost(
      202,
      '<div class="cta"><a href="/go">Human Revised CTA</a></div>',
      '2026-11-20T02:00:00.000Z'
    );
    expect(engine.publishedEvents).toHaveLength(1);
    expect(engine.publishedEvents[0].event).toBe('content.changed');

    const conflictRestoreEnv = await signWpCommand(
      {
        command: 'restore',
        seq: 5,
        not_after: futureIso,
        post_id: 202,
        promotion_id: 'p_xss',
      },
      keyPair.privateKey,
      'k1'
    );
    const conflictRes = await engine.handleSignedCommand(conflictRestoreEnv);
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.error).toBe('rollback_conflict');
    expect(conflictRes.three_way_merge?.pre_image).toBe(original);
    expect(conflictRes.three_way_merge?.current_image).toContain('Human Revised CTA');
    // Human edit is preserved!
    expect(engine.getPost(202)?.content).toContain('Human Revised CTA');
  });

  test('supports manifest.put, filter_patch lifecycle, and ctl clear_all_filter_patches', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
    });

    const manifestEnv = await signWpCommand(
      { command: 'manifest.put', seq: 1, not_after: futureIso, manifest: { bundle_ver: 42 } },
      keyPair.privateKey,
      'k1'
    );
    expect((await engine.handleSignedCommand(manifestEnv)).status).toBe(200);
    expect(engine.getInlineManifestJson()).toBe('{"bundle_ver":42}');

    const putPatch = await signWpCommand(
      {
        command: 'filter_patch.put',
        seq: 2,
        not_after: futureIso,
        patch_id: 'fp_1',
        url_path: '/guide/',
        fragment_html: '<p>Safe patch<script>evil()</script></p>',
      },
      keyPair.privateKey,
      'k1'
    );
    expect((await engine.handleSignedCommand(putPatch)).status).toBe(200);
    expect(engine.getActiveFilterPatchCount()).toBe(1);

    const ctlClear = await signWpCommand(
      { command: 'ctl', seq: 3, not_after: futureIso, clear_all_filter_patches: true },
      keyPair.privateKey,
      'k1'
    );
    expect((await engine.handleSignedCommand(ctlClear)).status).toBe(200);
    expect(engine.getActiveFilterPatchCount()).toBe(0);
  });

  test('del.D20 conformance: 59-cycle concurrent-edit stress test yields 0 lost human edits & 100% hash-equal restores', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 200,
        require_admin_confirmation_classes: [],
      },
    });

    const postId = 590;
    const baseContent = '<!-- wp:paragraph --><p>Headline CTA: [SLOT]</p><!-- /wp:paragraph -->';
    engine.seedPost({
      post_id: postId,
      permalink: '/conformance-59/',
      content: baseContent,
      modified_gmt: '2026-11-20T00:00:00.000Z',
      edit_lock_user_id: null,
    });

    let seq = 0;
    let exactRestores = 0;
    let humanEditConflictsCaught = 0;
    let lockRefusals = 0;
    let humanEditsTotal = 0;
    let humanEditsPreserved = 0;

    for (let cycle = 1; cycle <= 59; cycle++) {
      const prePost = engine.getPost(postId)!;
      const preSha = await sha256Hex(prePost.content);
      const slotIdx = prePost.content.indexOf('[SLOT');
      const slotEnd = prePost.content.indexOf(']', slotIdx) + 1;
      const promoId = `promo_cycle_${cycle}`;

      // Every 10th cycle: simulate concurrent editor lock before apply -> must refuse cleanly
      if (cycle % 10 === 0) {
        engine.setPostEditLock(postId, 42);
        seq += 1;
        const lockedApply = await engine.handleSignedCommand(
          await signWpCommand(
            {
              command: 'apply',
              seq,
              not_after: futureIso,
              post_id: postId,
              promotion_id: promoId,
              change_class: 'cta_copy',
              expected_content_sha256: preSha,
              expected_modified_gmt: prePost.modified_gmt,
              byte_start: slotIdx,
              byte_end: slotEnd,
              replacement_html: `[SLOT_${cycle}]`,
            },
            keyPair.privateKey,
            'k1'
          )
        );
        expect(lockedApply.status).toBe(409);
        expect(lockedApply.error).toBe('edit_lock_active');
        expect(await sha256Hex(engine.getPost(postId)!.content)).toBe(preSha);
        engine.setPostEditLock(postId, null);
        lockRefusals += 1;
        continue;
      }

      // Apply promotion
      seq += 1;
      const applyRes = await engine.handleSignedCommand(
        await signWpCommand(
          {
            command: 'apply',
            seq,
            not_after: futureIso,
            post_id: postId,
            promotion_id: promoId,
            change_class: 'cta_copy',
            expected_content_sha256: preSha,
            expected_modified_gmt: prePost.modified_gmt,
            byte_start: slotIdx,
            byte_end: slotEnd,
            replacement_html: `[SLOT_${cycle}]`,
          },
          keyPair.privateKey,
          'k1'
        )
      );
      expect(applyRes.status).toBe(200);
      expect(applyRes.pre_image_sha256).toBe(preSha);

      // Verify origin content hash matches post_image_sha256
      seq += 1;
      const verifyRes = await engine.handleSignedCommand(
        await signWpCommand(
          {
            command: 'verify',
            seq,
            not_after: futureIso,
            post_id: postId,
            expected_sha256: applyRes.post_image_sha256,
          },
          keyPair.privateKey,
          'k1'
        )
      );
      expect(verifyRes.origin_ok).toBe(true);

      // Every 7th cycle: simulate a human editor editing the post concurrently before rollback
      if (cycle % 7 === 0) {
        const humanMarker = `HUMAN_EDIT_${cycle}`;
        const humanNewContent = `<!-- wp:paragraph --><p>${humanMarker} [SLOT]</p><!-- /wp:paragraph -->`;
        humanEditsTotal += 1;
        await engine.humanEditPost(
          postId,
          humanNewContent,
          new Date(Date.now() + cycle * 1000).toISOString()
        );

        seq += 1;
        const restoreRes = await engine.handleSignedCommand(
          await signWpCommand(
            {
              command: 'restore',
              seq,
              not_after: futureIso,
              post_id: postId,
              promotion_id: promoId,
            },
            keyPair.privateKey,
            'k1'
          )
        );
        expect(restoreRes.status).toBe(409);
        expect(restoreRes.error).toBe('rollback_conflict');
        expect(restoreRes.three_way_merge?.pre_image).toBe(prePost.content);
        expect(engine.getPost(postId)!.content).toContain(humanMarker);
        humanEditsPreserved += 1;
        humanEditConflictsCaught += 1;
      } else {
        // Clean rollback -> MUST be exact SHA-256 match with pre-image!
        seq += 1;
        const restoreRes = await engine.handleSignedCommand(
          await signWpCommand(
            {
              command: 'restore',
              seq,
              not_after: futureIso,
              post_id: postId,
              promotion_id: promoId,
            },
            keyPair.privateKey,
            'k1'
          )
        );
        expect(restoreRes.status).toBe(200);
        expect(restoreRes.restored_sha256).toBe(preSha);
        expect(await sha256Hex(engine.getPost(postId)!.content)).toBe(preSha);
        exactRestores += 1;
      }
    }

    expect(lockRefusals).toBe(5);
    expect(humanEditsTotal).toBeGreaterThan(0);
    expect(humanEditsPreserved).toBe(humanEditsTotal); // 0 lost human edits
    expect(humanEditConflictsCaught).toBe(humanEditsTotal);
    expect(exactRestores + humanEditConflictsCaught + lockRefusals).toBe(59);
  });

  test('[C-17] rejects cloud self-asserted owner_wp_admin_confirmed and requires unconsumed local wp_options approval digest within TTL', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_c17',
      siteId: 'site_c17',
      homeUrl: 'https://shop.example.jp/',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 10,
        require_admin_confirmation_classes: ['touch_indexable_seo', 'change_outbound_hosts', 'price'],
      },
    });

    const beforeHtml = '<p><a href="https://shop.example.jp/item">公式を見る</a></p>';
    const beforeSha = await sha256Hex(beforeHtml);
    const mod = '2026-11-20T00:00:00.000Z';
    engine.seedPost({
      post_id: 777,
      permalink: '/item-777/',
      content: beforeHtml,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    // 1. Compromised cloud payload sets `owner_wp_admin_confirmed: true` AND claims `cta_copy`
    // while changing outbound host to an external site -> MUST BE REJECTED (403)!
    const replacement = '<a href="https://evil-affiliate.example.org/steal">公式を見る</a>';
    const afterHtml = `<p>${replacement}</p>`;
    const afterSha = await sha256Hex(afterHtml);

    const cloudBypassEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_c17',
        site_id: 'site_c17',
        home_url: 'https://shop.example.jp',
        post_id: 777,
        promotion_id: 'promo_c17_bypass',
        change_class: 'cta_copy',
        owner_wp_admin_confirmed: true, // cloud self-assertion MUST NOT be trusted!
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: beforeHtml.length - 4,
        replacement_html: replacement,
      },
      keyPair.privateKey,
      'k1'
    );
    const bypassRes = await engine.handleSignedCommand(cloudBypassEnv);
    expect(bypassRes.status).toBe(403);
    expect(bypassRes.error).toBe('owner_local_policy_requires_admin_confirmation');
    expect(engine.getPost(777)?.content).toBe(beforeHtml);

    // 2. Local approval without manage_options or without WP nonce -> rejected
    expect(
      (
        await engine.recordLocalWpAdminApproval({
          hasManageOptionsCapability: false,
          wpAdminNonceVerified: true,
          postId: 777,
          beforeSha256: beforeSha,
          afterSha256: afterSha,
          commandSeq: 2,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await engine.recordLocalWpAdminApproval({
          hasManageOptionsCapability: true,
          wpAdminNonceVerified: false,
          postId: 777,
          beforeSha256: beforeSha,
          afterSha256: afterSha,
          commandSeq: 2,
        })
      ).ok
    ).toBe(false);

    // 3. Genuine local WP-Admin approval (manage_options + WP nonce) for seq=2 + exact before/after SHA-256 -> succeeds once!
    const nowMs = Date.now();
    const localApprove = await engine.recordLocalWpAdminApproval({
      hasManageOptionsCapability: true,
      wpAdminNonceVerified: true,
      postId: 777,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      commandSeq: 2,
      ttlMs: 300_000,
      nowMs,
    });
    expect(localApprove.ok).toBe(true);
    expect(localApprove.digest).toBe(
      await computeWpLocalApprovalDigest({
        siteId: 'site_c17',
        postId: 777,
        beforeSha256: beforeSha,
        afterSha256: afterSha,
        commandSeq: 2,
      })
    );

    const approvedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 2,
        not_after: futureIso,
        tenant_id: 'ten_c17',
        site_id: 'site_c17',
        home_url: 'https://shop.example.jp',
        post_id: 777,
        promotion_id: 'promo_c17_2key',
        change_class: 'change_outbound_hosts',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: beforeHtml.length - 4,
        replacement_html: replacement,
      },
      keyPair.privateKey,
      'k1'
    );
    const approvedRes = await engine.handleSignedCommand(approvedEnv, nowMs + 1000);
    expect(approvedRes.status).toBe(200);
    expect(engine.getPost(777)?.content).toBe(afterHtml);

    // 4. Static PHP audit rejects any re-introduction of `$payload['owner_wp_admin_confirmed']`
    const phpPath = path.join(__dirname, 'ugokilink-companion.php');
    const phpSource = fs.readFileSync(phpPath, 'utf8');
    const poisonedPhp = `${phpSource}\n<?php $x = $payload['owner_wp_admin_confirmed']; ?>`;
    expect(auditPhpPluginSource(poisonedPhp).passed).toBe(false);
  });

  test('[H-08] verifies site_id/home_url BEFORE advancing seq, enforces canonical JSON & 64-byte sig guard, preserves human edit locks, and resets daily_apply_cap per UTC day', async () => {
    const keyPair = await generateEd25519KeyPair();
    const siteB = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_1',
      siteId: 'site_b',
      homeUrl: 'https://SiteB.Example.jp/',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 1,
        require_admin_confirmation_classes: [],
      },
    });
    expect(normalizeWpHomeUrl('https://SiteB.Example.jp/')).toBe('https://siteb.example.jp');

    // 1. Cross-site replay with huge seq=999999 signed by valid key MUST fail 403 BEFORE advancing Site B's lastSeq!
    const crossSiteEnv = await signWpCommand(
      {
        command: 'capabilities',
        seq: 999_999,
        not_after: futureIso,
        tenant_id: 'ten_1',
        site_id: 'site_a',
        home_url: 'https://sitea.example.jp',
      },
      keyPair.privateKey,
      'k1'
    );
    const crossRes = await siteB.handleSignedCommand(crossSiteEnv);
    expect(crossRes.status).toBe(403);
    expect(crossRes.error).toBe('site_binding_mismatch');
    expect(siteB.getLastSeq()).toBe(0); // NOT poisoned to 999999!

    // 2. Malformed short/corrupt signature returns 401 (never 500 throw)
    const shortSigRes = await siteB.handleSignedCommand({
      ...crossSiteEnv,
      signature_b64: 'YWJj', // 3 bytes != 64 bytes
    });
    expect(shortSigRes.status).toBe(401);
    expect(shortSigRes.error).toBe('malformed_signature');

    // 3. Site B's legitimate seq=1 still works because cross-site replay did not advance lastSeq
    const html = '<p>Hello</p>';
    const sha = await sha256Hex(html);
    siteB.seedPost({
      post_id: 88,
      permalink: '/p88/',
      content: html,
      modified_gmt: '2026-11-20T00:00:00.000Z',
      edit_lock_user_id: 99, // Human editor #99 holds lock!
    });

    // Human editor's lock MUST NOT be deleted when apply refuses with 409 edit_lock_active
    const lockedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_1',
        site_id: 'site_b',
        home_url: 'https://siteb.example.jp/',
        post_id: 88,
        change_class: 'cta_copy',
        expected_content_sha256: sha,
        expected_modified_gmt: '2026-11-20T00:00:00.000Z',
        byte_start: 3,
        byte_end: 8,
        replacement_html: 'World',
      },
      keyPair.privateKey,
      'k1'
    );
    const lockRes = await siteB.handleSignedCommand(lockedEnv, Date.parse('2026-11-20T10:00:00Z'));
    expect(lockRes.status).toBe(409);
    expect(siteB.getPost(88)?.edit_lock_user_id).toBe(99); // Human lock intact!

    // Release human lock, apply on UTC Day 1 (uses 1/1 daily_apply_cap), 2nd apply on Day 1 -> 429, next UTC Day 2 -> 200!
    siteB.setPostEditLock(88, null);
    const day1Apply = await signWpCommand(
      {
        command: 'apply',
        seq: 2,
        not_after: '2026-11-25T00:00:00.000Z',
        tenant_id: 'ten_1',
        site_id: 'site_b',
        home_url: 'https://siteb.example.jp',
        post_id: 88,
        change_class: 'cta_copy',
        expected_content_sha256: sha,
        expected_modified_gmt: '2026-11-20T00:00:00.000Z',
        byte_start: 3,
        byte_end: 8,
        replacement_html: 'World',
      },
      keyPair.privateKey,
      'k1'
    );
    expect(
      (await siteB.handleSignedCommand(day1Apply, Date.parse('2026-11-20T12:00:00Z'))).status
    ).toBe(200);

    const postDay1 = siteB.getPost(88)!;
    const day1OverCap = await signWpCommand(
      {
        command: 'apply',
        seq: 3,
        not_after: '2026-11-25T00:00:00.000Z',
        tenant_id: 'ten_1',
        site_id: 'site_b',
        home_url: 'https://siteb.example.jp',
        post_id: 88,
        change_class: 'cta_copy',
        expected_content_sha256: await sha256Hex(postDay1.content),
        expected_modified_gmt: postDay1.modified_gmt,
        byte_start: 3,
        byte_end: 8,
        replacement_html: 'Again',
      },
      keyPair.privateKey,
      'k1'
    );
    expect(
      (await siteB.handleSignedCommand(day1OverCap, Date.parse('2026-11-20T18:00:00Z'))).status
    ).toBe(429);

    const day2Apply = await signWpCommand(
      {
        command: 'apply',
        seq: 4,
        not_after: '2026-11-25T00:00:00.000Z',
        tenant_id: 'ten_1',
        site_id: 'site_b',
        home_url: 'https://siteb.example.jp',
        post_id: 88,
        change_class: 'cta_copy',
        expected_content_sha256: await sha256Hex(postDay1.content),
        expected_modified_gmt: postDay1.modified_gmt,
        byte_start: 3,
        byte_end: 8,
        replacement_html: 'Day2!',
      },
      keyPair.privateKey,
      'k1'
    );
    expect(
      (await siteB.handleSignedCommand(day2Apply, Date.parse('2026-11-21T01:00:00Z'))).status
    ).toBe(200);
  });

  test('[#6] full before/after HTML document comparison catches text-only <h1> edit as touch_indexable_seo and requires local WP 2-key approval', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_seo',
      siteId: 'site_seo',
      homeUrl: 'https://seo.example.jp',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 10,
        require_admin_confirmation_classes: ['touch_indexable_seo'],
      },
    });

    const beforeHtml = '<article><h1>Old Title</h1><p>Body paragraph</p></article>';
    const byteStart = beforeHtml.indexOf('Old Title');
    const byteEnd = byteStart + 'Old Title'.length;
    const afterHtml = '<article><h1>New Title</h1><p>Body paragraph</p></article>';
    const beforeSha = await sha256Hex(beforeHtml);
    const afterSha = await sha256Hex(afterHtml);
    const mod = '2026-11-20T00:00:00.000Z';

    engine.seedPost({
      post_id: 601,
      permalink: '/seo-post/',
      content: beforeHtml,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    // Text-only fragment "New Title" replacing "Old Title" inside <h1>...</h1> has NO HTML tags in slice,
    // yet full-document comparison MUST detect <h1> change and reject without local WP 2-key approval!
    const unapprovedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_seo',
        site_id: 'site_seo',
        home_url: 'https://seo.example.jp',
        post_id: 601,
        promotion_id: 'promo_h1_text_only',
        change_class: 'cta_copy',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: byteStart,
        byte_end: byteEnd,
        replacement_html: 'New Title',
      },
      keyPair.privateKey,
      'k1'
    );
    const rejected = await engine.handleSignedCommand(unapprovedEnv);
    expect(rejected.status).toBe(403);
    expect(rejected.error).toBe('owner_local_policy_requires_admin_confirmation');
    expect(engine.getPost(601)?.content).toBe(beforeHtml);

    // With genuine local WP-Admin 2-key approval for seq=2, the exact same edit succeeds
    const nowMs = Date.now();
    const localApprove = await engine.recordLocalWpAdminApproval({
      hasManageOptionsCapability: true,
      wpAdminNonceVerified: true,
      postId: 601,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      commandSeq: 2,
      nowMs,
    });
    expect(localApprove.ok).toBe(true);

    const approvedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 2,
        not_after: futureIso,
        tenant_id: 'ten_seo',
        site_id: 'site_seo',
        home_url: 'https://seo.example.jp',
        post_id: 601,
        promotion_id: 'promo_h1_text_only_ok',
        change_class: 'cta_copy',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: byteStart,
        byte_end: byteEnd,
        replacement_html: 'New Title',
      },
      keyPair.privateKey,
      'k1'
    );
    const okRes = await engine.handleSignedCommand(approvedEnv, nowMs + 1000);
    expect(okRes.status).toBe(200);
    expect(engine.getPost(601)?.content).toBe(afterHtml);
  });

  test('[#7] atomic approval claim prevents concurrent double-consumption and rolls back to unused on wp_update_post failure for clean retry', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_atom',
      siteId: 'site_atom',
      homeUrl: 'https://atom.example.jp',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 10,
        require_admin_confirmation_classes: ['touch_indexable_seo'],
      },
    });

    const beforeHtml = '<h1>Original Heading</h1>';
    const byteStart = beforeHtml.indexOf('Original Heading');
    const byteEnd = byteStart + 'Original Heading'.length;
    const afterHtml = '<h1>Updated Heading</h1>';
    const beforeSha = await sha256Hex(beforeHtml);
    const afterSha = await sha256Hex(afterHtml);
    const mod = '2026-11-20T00:00:00.000Z';

    engine.seedPost({
      post_id: 701,
      permalink: '/atomic-post/',
      content: beforeHtml,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    const nowMs = Date.now();
    const approved = await engine.recordLocalWpAdminApproval({
      hasManageOptionsCapability: true,
      wpAdminNonceVerified: true,
      postId: 701,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      commandSeq: 1,
      nowMs,
    });
    expect(approved.ok).toBe(true);
    const digest = approved.digest!;
    expect(engine.getLocalApprovalState(digest)).toBe('unused');

    const cmdEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_atom',
        site_id: 'site_atom',
        home_url: 'https://atom.example.jp',
        post_id: 701,
        promotion_id: 'promo_atomic_1',
        change_class: 'touch_indexable_seo',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: byteStart,
        byte_end: byteEnd,
        replacement_html: 'Updated Heading',
      },
      keyPair.privateKey,
      'k1'
    );

    // (b) Simulate wp_update_post failure: approval transitions unused -> claimed -> unused (rolled back!)
    let observedInFlightState: string | null = null;
    let concurrentClaimWhileInFlight: string | null = 'not_tested';
    engine.setPostUpdateHook(async () => {
      observedInFlightState = engine.getLocalApprovalState(digest);
      // While claimed in-flight, a concurrent claim on the same digest MUST be rejected (null)
      concurrentClaimWhileInFlight = engine.claimLocalWpAdminApproval(digest, nowMs + 500);
      throw new Error('simulated_db_write_error');
    });

    const failedRes = await engine.handleSignedCommand(cmdEnv, nowMs + 500);
    expect(failedRes.status).toBe(500);
    expect(failedRes.error).toBe('wp_update_post_failed');
    expect(observedInFlightState).toBe('claimed');
    expect(concurrentClaimWhileInFlight).toBeNull();
    // Rolled back to unused & post unchanged!
    expect(engine.getLocalApprovalState(digest)).toBe('unused');
    expect(engine.getPost(701)?.content).toBe(beforeHtml);

    // (a) Clean retry with concurrent duplicate delivery: ONLY 1 succeeds (200), second is rejected!
    engine.setPostUpdateHook(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const [resA, resB] = await Promise.all([
      engine.handleSignedCommand(cmdEnv, nowMs + 1000),
      engine.handleSignedCommand(cmdEnv, nowMs + 1000),
    ]);
    const okCount = [resA, resB].filter((r) => r.status === 200).length;
    const rejectedCount = [resA, resB].filter((r) => r.status !== 200).length;
    expect(okCount).toBe(1);
    expect(rejectedCount).toBe(1);
    expect(engine.getPost(701)?.content).toBe(afterHtml);
    expect(engine.getLocalApprovalState(digest)).toBe('consumed');
  });

  test('[#6] quote-aware HTML parser detects edits after ">" inside quoted <meta> attribute values and fails closed on unclosed HTML', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_quote',
      siteId: 'site_quote',
      homeUrl: 'https://quote.example.jp',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 10,
        require_admin_confirmation_classes: ['touch_indexable_seo'],
      },
    });

    const beforeHtml = '<head><meta name="description" content="fast > slow old"></head><p>Body</p>';
    const afterHtml = '<head><meta name="description" content="fast > slow new"></head><p>Body</p>';

    // Direct quote-aware signature comparison MUST detect the edit after `>`!
    const beforeSig = extractIndexableSeoSignature(beforeHtml);
    const afterSig = extractIndexableSeoSignature(afterHtml);
    expect(beforeSig).not.toBeNull();
    expect(afterSig).not.toBeNull();
    expect(beforeSig).not.toBe(afterSig);

    // Unclosed / malformed HTML MUST return null (fail closed)
    expect(extractIndexableSeoSignature('<meta name="description" content="unclosed')).toBeNull();
    expect(extractIndexableSeoSignature('<h1>Unclosed heading')).toBeNull();

    const byteStart = beforeHtml.indexOf('old');
    const byteEnd = byteStart + 'old'.length;
    const beforeSha = await sha256Hex(beforeHtml);
    const mod = '2026-11-20T00:00:00.000Z';
    engine.seedPost({
      post_id: 602,
      permalink: '/meta-quote/',
      content: beforeHtml,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    const unapprovedEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_quote',
        site_id: 'site_quote',
        home_url: 'https://quote.example.jp',
        post_id: 602,
        promotion_id: 'promo_meta_gt_edit',
        change_class: 'cta_copy',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: byteStart,
        byte_end: byteEnd,
        replacement_html: 'new',
      },
      keyPair.privateKey,
      'k1'
    );
    const rejected = await engine.handleSignedCommand(unapprovedEnv);
    expect(rejected.status).toBe(403);
    expect(rejected.error).toBe('owner_local_policy_requires_admin_confirmation');
    expect(engine.getPost(602)?.content).toBe(beforeHtml);
  });

  test('[#7] recoverable pending-command journal commits approval after crash-after-update and CAS seq rollback never clobbers a concurrent newer seq', async () => {
    const keyPair = await generateEd25519KeyPair();
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['k1', keyPair.publicKey]]),
      tenantId: 'ten_rec',
      siteId: 'site_rec',
      homeUrl: 'https://rec.example.jp',
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['cta_copy'],
        daily_apply_cap: 10,
        require_admin_confirmation_classes: ['touch_indexable_seo'],
      },
    });

    const beforeHtml = '<h1>Before Crash</h1>';
    const afterHtml = '<h1>After Crash</h1>';
    const byteStart = beforeHtml.indexOf('Before Crash');
    const byteEnd = byteStart + 'Before Crash'.length;
    const beforeSha = await sha256Hex(beforeHtml);
    const afterSha = await sha256Hex(afterHtml);
    const mod = '2026-11-20T00:00:00.000Z';

    engine.seedPost({
      post_id: 702,
      permalink: '/crash-recovery/',
      content: beforeHtml,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    const nowMs = Date.now();
    const approved = await engine.recordLocalWpAdminApproval({
      hasManageOptionsCapability: true,
      wpAdminNonceVerified: true,
      postId: 702,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      commandSeq: 1,
      nowMs,
    });
    expect(approved.ok).toBe(true);
    const digest = approved.digest!;

    // (a) Simulate crash AFTER post update persisted and BEFORE approval commit
    engine.setAfterPostUpdateBeforeCommitHook(() => {
      throw new Error('simulated_process_crash_before_commit');
    });

    const crashEnv = await signWpCommand(
      {
        command: 'apply',
        seq: 1,
        not_after: futureIso,
        tenant_id: 'ten_rec',
        site_id: 'site_rec',
        home_url: 'https://rec.example.jp',
        post_id: 702,
        promotion_id: 'promo_crash_1',
        change_class: 'touch_indexable_seo',
        expected_content_sha256: beforeSha,
        expected_modified_gmt: mod,
        byte_start: byteStart,
        byte_end: byteEnd,
        replacement_html: 'After Crash',
      },
      keyPair.privateKey,
      'k1'
    );

    await expect(engine.handleSignedCommand(crashEnv, nowMs + 100)).rejects.toThrow(
      'simulated_process_crash_before_commit'
    );

    // Post WAS updated, approval is still `claimed`, and journal holds the `in_progress` record
    expect(engine.getPost(702)?.content).toBe(afterHtml);
    expect(engine.getLocalApprovalState(digest)).toBe('claimed');
    expect(engine.getPendingCommandJournal()).toHaveLength(1);

    // Reconcile pending commands -> finishes committing `claimed -> consumed` and clears journal!
    engine.setAfterPostUpdateBeforeCommitHook(undefined);
    await engine.reconcilePendingCommands();
    expect(engine.getLocalApprovalState(digest)).toBe('consumed');
    expect(engine.getPendingCommandJournal()).toHaveLength(0);
    // Approval cannot be reclaimed/reused
    expect(engine.claimLocalWpAdminApproval(digest, nowMs + 200)).toBeNull();

    // (b) Conditional CAS lastSeq rollback NEVER clobbers a concurrent newer seq!
    const html2 = '<p>Safe Body</p>';
    const sha2 = await sha256Hex(html2);
    engine.seedPost({
      post_id: 703,
      permalink: '/cas-seq/',
      content: html2,
      modified_gmt: mod,
      edit_lock_user_id: null,
    });

    const concurrentNewerCmd = await signWpCommand(
      {
        command: 'capabilities',
        seq: 20,
        not_after: futureIso,
        tenant_id: 'ten_rec',
        site_id: 'site_rec',
        home_url: 'https://rec.example.jp',
      },
      keyPair.privateKey,
      'k1'
    );

    // During seq=10 post update, a concurrent seq=20 command arrives and advances lastSeq to 20,
    // then seq=10 fails -> CAS rollback MUST NOT overwrite lastSeq=20 back to 1!
    engine.setPostUpdateHook(async () => {
      const capRes = await engine.handleSignedCommand(concurrentNewerCmd, nowMs + 300);
      expect(capRes.status).toBe(200);
      expect(engine.getLastSeq()).toBe(20);
      throw new Error('simulated_db_failure_after_newer_seq');
    });

    const failingSeq10Env = await signWpCommand(
      {
        command: 'apply',
        seq: 10,
        not_after: futureIso,
        tenant_id: 'ten_rec',
        site_id: 'site_rec',
        home_url: 'https://rec.example.jp',
        post_id: 703,
        promotion_id: 'promo_cas_10',
        change_class: 'cta_copy',
        expected_content_sha256: sha2,
        expected_modified_gmt: mod,
        byte_start: 3,
        byte_end: 12,
        replacement_html: 'New Body',
      },
      keyPair.privateKey,
      'k1'
    );

    const failRes = await engine.handleSignedCommand(failingSeq10Env, nowMs + 250);
    expect(failRes.status).toBe(500);
    expect(failRes.error).toBe('wp_update_post_failed');
    // lastSeq MUST remain 20 (never clobbered to 1)!
    expect(engine.getLastSeq()).toBe(20);
  });
});
