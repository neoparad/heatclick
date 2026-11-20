import * as fs from 'fs';
import * as path from 'path';
import { generateEd25519KeyPair, sha256Hex } from '../../workers/link-signer';
import {
  WpPluginEngine,
  auditPhpPluginSource,
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
});
