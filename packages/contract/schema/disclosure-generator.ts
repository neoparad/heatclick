/**
 * Generator #5: Japanese External Transmission Rule Privacy Disclosure Generator
 *
 * Automatically assembles the per-site disclosure record required under Japan's
 * Telecommunications Business Act (電気通信事業法・外部送信規律) and §4.5 / TEL M5 / D-30:
 *   1. 送信される利用者に関する情報の内容（送信項目）
 *   2. 送信先（送り先・情報を取り扱う者の氏名又は名称）
 *   3. 利用目的（送信元・送信先双方の利用目的）
 * plus consent mode breakdown (5 modes), pre-resolution loader notice,
 * cookieless 35-day prefix/ASN & scoped network pseudonym transparency,
 * opt-out method, and 14-day deletion guarantee.
 */

import { canonicalJsonStringify, sha256Hex } from './hash';
import { assertValidContractSchema } from './invariants';
import type {
  ConsentMode,
  ConsentPurpose,
  ContractSchema,
  JurisdictionCode,
  PiiClass,
  RetentionPolicy,
} from './types';

export interface DisclosureOptions {
  readonly siteName?: string;
  readonly legalRecipientName?: string;
  readonly senderName?: string;
  readonly optOutUrl?: string;
  readonly retentionMonths?: number;
  readonly additionalRecipients?: readonly {
    readonly name: string;
    readonly purposeJa: string;
    readonly itemsJa: readonly string[];
  }[];
}

export interface DisclosureTransmittedItem {
  readonly fieldName: string;
  readonly jaLabel: string;
  readonly enLabel: string;
  readonly purposeJa: string;
  readonly consentMin: ConsentMode;
  readonly requiredPurposes: readonly ConsentPurpose[];
  readonly piiClass: PiiClass;
  readonly retentionPolicy: RetentionPolicy;
}

export interface PrivacyDisclosureRecord {
  readonly schemaVersion: string;
  readonly legalFramework: 'JP_TELECOMMUNICATIONS_BUSINESS_ACT_ART_27_12';
  readonly siteName: string;
  readonly senderName: string;
  readonly legalRecipientName: string;
  readonly optOutUrl: string;
  readonly retentionMonths: number;
  readonly deletionDeadlineDays: number;
  readonly preResolutionNoticeJa: string;
  readonly cookielessServerNoticeJa: string;
  readonly transmittedItems: readonly DisclosureTransmittedItem[];
  readonly consentModeSummaries: readonly {
    readonly mode: ConsentMode;
    readonly summaryJa: string;
  }[];
  readonly jurisdictionDefaults: readonly {
    readonly jurisdiction: JurisdictionCode;
    readonly labelJa: string;
    readonly effectiveMode: ConsentMode;
    readonly legalSignedOff: boolean;
    readonly legalBasisJa: string;
  }[];
  readonly additionalRecipients: readonly {
    readonly name: string;
    readonly purposeJa: string;
    readonly itemsJa: readonly string[];
  }[];
  readonly markdownJa: string;
  readonly htmlJa: string;
  readonly contentSha256: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generatePrivacyDisclosure(
  schema: ContractSchema,
  options?: DisclosureOptions
): PrivacyDisclosureRecord {
  assertValidContractSchema(schema);

  const siteName = options?.siteName ?? '対象ウェブサイト（サイト管理者）';
  const senderName = options?.senderName ?? '当サイト運営者（ファーストパーティ利用目的）';
  const legalRecipientName =
    options?.legalRecipientName ?? 'UGOKI LINK 計測基盤（データ処理受託者）';
  const optOutUrl = options?.optOutUrl ?? '/privacy#ugokilink-optout';
  const retentionMonths = options?.retentionMonths ?? schema.defaultRetentionMonths;
  const additionalRecipients = options?.additionalRecipients ?? [];

  const transmittedItems: DisclosureTransmittedItem[] = schema.fields
    .filter((f) => f.disclosure.transmittedFromBrowser)
    .map((f) => ({
      fieldName: f.name,
      jaLabel: f.disclosure.jaLabel,
      enLabel: f.disclosure.enLabel,
      purposeJa: f.disclosure.purposeJa,
      consentMin: f.consentMin,
      requiredPurposes: [...f.requiredPurposes],
      piiClass: f.piiClass,
      retentionPolicy: f.retentionPolicy,
    }))
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName));

  const preResolutionNoticeJa =
    '同意モードの判定前であっても、HTMLに設置された固定ファイルおよび設定データ取得のため、1回のみUGOKI LINKエンドポイントへ通信が発生します（IPアドレスおよびUser-Agentが通信ヘッダーとして到達します）。地域区分がoffと判定された場合、自動操作の証拠がある行のみ記録し、一般訪問者の計測フレームは一切送信・保存しません。';

  const cookielessServerNoticeJa =
    'cookielessモードでは利用者の端末（Cookie・localStorage等）に識別子を一切保存しません。サーバー側ではネットワーク上位プレフィックスとASNを最長35日保持します（前後120秒の受け渡し照合完了後にPVとの紐付けを破棄）。用途別の短命ネットワーク仮名（日次上限用・実験用・定足数用）は用途をまたいで結合されません。';

  const consentModeSummaries = schema.consentModes.map((m) => ({
    mode: m.mode,
    summaryJa: m.summaryJa,
  }));

  const jurisdictionDefaults = schema.jurisdictionMatrix.map((row) => ({
    jurisdiction: row.jurisdiction,
    labelJa: row.labelJa,
    effectiveMode: row.legalSignedOff
      ? row.proposedDefaultModeAfterSignoff
      : row.defaultModeBeforeSignoff,
    legalSignedOff: row.legalSignedOff,
    legalBasisJa: row.legalBasisJa,
  }));

  // Build deterministic Japanese Markdown disclosure
  const mdLines: string[] = [
    `# 外部送信規律に基づく情報送信の公表（${siteName}）`,
    '',
    `- 契約スキーマ版: \`v${schema.meta.schemaVersion}\``,
    `- 情報を取り扱う送信先（送り先）: ${legalRecipientName}`,
    `- 送信元での利用目的管理主体: ${senderName}`,
    `- データ保持期間: 最大 ${retentionMonths} か月（削除依頼から ${schema.deletionDeadlines.certifiedWithinDays} 日以内に完全削除証明を発行）`,
    `- オプトアウト（計測停止・削除請求）: ${optOutUrl} またはブラウザ関数 \`ugk.optOut()\``,
    '',
    '## 1. 送信先（送り先）および利用目的',
    `- **送り先**: ${legalRecipientName}`,
    `- **利用目的**: ページ閲覧状況・区画到達・操作摩擦の計測、表示速度および不具合の監視、無作為化実験によるサイト改善、ならびに自動操作（ボット・AIクローラー）の判別。利用者が入力フォームに記入した文字・パスワード・選択内容・クリップボード内容は送信しません。`,
  ];

  for (const extra of additionalRecipients) {
    mdLines.push(
      `- **追加送り先（${extra.name}）**: ${extra.purposeJa}（送信項目: ${extra.itemsJa.join('、')}）`
    );
  }

  mdLines.push(
    '',
    '## 2. 送信される利用者に関する情報（送信項目一覧）',
    '',
    '| 項目キー | 送信項目の内容 | 利用目的 | 最小同意モード | 必要目的タグ |',
    '|---|---|---|---|---|'
  );

  for (const item of transmittedItems) {
    const purposesText =
      item.requiredPurposes.length > 0 ? item.requiredPurposes.join(', ') : '標準計測';
    mdLines.push(
      `| \`${item.fieldName}\` | ${item.jaLabel} | ${item.purposeJa} | \`${item.consentMin}\` | ${purposesText} |`
    );
  }

  mdLines.push(
    '',
    '## 3. 同意モード（5区分）と事前通信・cookielessの取り扱い',
    '',
    `- **事前通信の明示（offモード含む）**: ${preResolutionNoticeJa}`,
    `- **cookielessモードの正確な意味**: ${cookielessServerNoticeJa}`,
    ''
  );

  for (const m of consentModeSummaries) {
    mdLines.push(`- **\`${m.mode}\`**: ${m.summaryJa}`);
  }

  mdLines.push(
    '',
    '## 4. 法域別の既定動作（法務署名状態）',
    '',
    '| 法域 | 現在の適用既定モード | 法務署名 | 根拠・注記 |',
    '|---|---|---|---|'
  );

  for (const j of jurisdictionDefaults) {
    mdLines.push(
      `| ${j.labelJa} (\`${j.jurisdiction}\`) | \`${j.effectiveMode}\` | ${j.legalSignedOff ? '署名済' : '未署名（厳格側既定）'} | ${j.legalBasisJa} |`
    );
  }

  const markdownJa = `${mdLines.join('\n')}\n`;

  // Build deterministic Japanese HTML snippet for direct policy-page embedding (tel.G12 hash check)
  const htmlRows = transmittedItems
    .map((item) => {
      const purposesText =
        item.requiredPurposes.length > 0 ? item.requiredPurposes.join(', ') : '標準計測';
      return [
        '      <tr>',
        `        <td><code>${escapeHtml(item.fieldName)}</code></td>`,
        `        <td>${escapeHtml(item.jaLabel)}</td>`,
        `        <td>${escapeHtml(item.purposeJa)}</td>`,
        `        <td><code>${escapeHtml(item.consentMin)}</code></td>`,
        `        <td>${escapeHtml(purposesText)}</td>`,
        '      </tr>',
      ].join('\n');
    })
    .join('\n');

  const htmlModes = consentModeSummaries
    .map(
      (m) =>
        `    <li><strong><code>${escapeHtml(m.mode)}</code></strong>: ${escapeHtml(m.summaryJa)}</li>`
    )
    .join('\n');

  const htmlBodyWithoutHash = [
    `<section data-ugk-disclosure-schema="${escapeHtml(schema.meta.schemaVersion)}">`,
    `  <h2>外部送信規律に基づく情報送信の公表（${escapeHtml(siteName)}）</h2>`,
    '  <dl>',
    `    <dt>送信先（送り先）</dt><dd>${escapeHtml(legalRecipientName)}</dd>`,
    `    <dt>利用目的管理主体</dt><dd>${escapeHtml(senderName)}</dd>`,
    `    <dt>保持期間・削除期限</dt><dd>最大${retentionMonths}か月／削除請求から${schema.deletionDeadlines.certifiedWithinDays}日以内に完全削除証明発行</dd>`,
    `    <dt>オプトアウト</dt><dd><a href="${escapeHtml(optOutUrl)}">${escapeHtml(optOutUrl)}</a></dd>`,
    '  </dl>',
    `  <p>${escapeHtml(preResolutionNoticeJa)}</p>`,
    `  <p>${escapeHtml(cookielessServerNoticeJa)}</p>`,
    '  <h3>送信項目・利用目的</h3>',
    '  <table>',
    '    <thead><tr><th>項目キー</th><th>送信項目</th><th>利用目的</th><th>最小同意モード</th><th>必要目的タグ</th></tr></thead>',
    '    <tbody>',
    htmlRows,
    '    </tbody>',
    '  </table>',
    '  <h3>同意モード一覧</h3>',
    '  <ul>',
    htmlModes,
    '  </ul>',
    '</section>',
  ].join('\n');

  const corePayload = {
    schemaVersion: schema.meta.schemaVersion,
    legalFramework: 'JP_TELECOMMUNICATIONS_BUSINESS_ACT_ART_27_12' as const,
    siteName,
    senderName,
    legalRecipientName,
    optOutUrl,
    retentionMonths,
    deletionDeadlineDays: schema.deletionDeadlines.certifiedWithinDays,
    preResolutionNoticeJa,
    cookielessServerNoticeJa,
    transmittedItems,
    consentModeSummaries,
    jurisdictionDefaults,
    additionalRecipients,
  };

  const contentSha256 = sha256Hex(canonicalJsonStringify(corePayload));
  const htmlJa = `<!-- ugokilink-disclosure-sha256:${contentSha256} -->\n${htmlBodyWithoutHash}\n`;

  return {
    ...corePayload,
    markdownJa,
    htmlJa,
    contentSha256,
  };
}
