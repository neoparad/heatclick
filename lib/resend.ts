/**
 * Resend (Email) client + テンプレート
 *
 * 親 SSOT §6.3 S0-08 (W0-07 既存 ugokimap.com ドメイン認証済)
 * Sprint 0 S0-08 skeleton + 基本 4 テンプレ。
 */

import { Resend } from 'resend'

let _resend: Resend | null = null

export function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) {
      throw new Error('RESEND_API_KEY environment variable is required')
    }
    _resend = new Resend(key)
  }
  return _resend
}

const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@ugokimap.com'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ugokimap.com'

interface SendResult {
  success: boolean
  id?: string
  error?: string
}

async function sendEmail(args: {
  to: string
  subject: string
  html: string
  text?: string
}): Promise<SendResult> {
  try {
    const result = await getResend().emails.send({
      from: EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    })
    if (result.error) {
      return { success: false, error: result.error.message }
    }
    return { success: true, id: result.data?.id }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

// ===== Email テンプレート 4 種 =====

export async function sendMagicLinkEmail(args: {
  to: string
  magic_link_url: string
  expires_in_minutes: number
}): Promise<SendResult> {
  return sendEmail({
    to: args.to,
    subject: 'UGOKI MAP — サインインリンク',
    html: `
      <h2>UGOKI MAP にサインイン</h2>
      <p>下のリンクをクリックしてサインインしてください (${args.expires_in_minutes} 分間有効):</p>
      <p><a href="${args.magic_link_url}" style="background:#4F6BFF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">サインイン</a></p>
      <p>このリンクをクリックしなかった場合は無視してください。</p>
      <hr>
      <p style="color:#888;font-size:12px;">UGOKI MAP / LINKTH</p>
    `,
    text: `UGOKI MAP にサインイン: ${args.magic_link_url} (${args.expires_in_minutes} 分間有効)`,
  })
}

export async function sendVerifyEmail(args: {
  to: string
  verify_url: string
}): Promise<SendResult> {
  return sendEmail({
    to: args.to,
    subject: 'UGOKI MAP — メールアドレスの確認',
    html: `
      <h2>メールアドレスを確認してください</h2>
      <p>下のリンクをクリックしてメールアドレスを確認してください:</p>
      <p><a href="${args.verify_url}" style="background:#4F6BFF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">確認する</a></p>
    `,
    text: `メール確認: ${args.verify_url}`,
  })
}

export async function sendWelcomeEmail(args: {
  to: string
  user_name: string
  plan: string
}): Promise<SendResult> {
  return sendEmail({
    to: args.to,
    subject: `${args.user_name} さん、UGOKI MAP へようこそ`,
    html: `
      <h2>UGOKI MAP へようこそ</h2>
      <p>${args.user_name} さん、UGOKI MAP (${args.plan} プラン) へのご登録ありがとうございます。</p>
      <p>まずは tracking.js を設置してください:</p>
      <p><a href="${APP_URL}/onboarding/install" style="background:#4F6BFF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">設置ガイドへ</a></p>
    `,
    text: `UGOKI MAP へようこそ。設置ガイド: ${APP_URL}/onboarding/install`,
  })
}

export async function sendDeleteRequestConfirmation(args: {
  to: string
  request_id: string
  scheduled_deletion_at: string
}): Promise<SendResult> {
  return sendEmail({
    to: args.to,
    subject: 'UGOKI MAP — 削除請求を受け付けました',
    html: `
      <h2>削除請求を受け付けました</h2>
      <p>リクエスト ID: <code>${args.request_id}</code></p>
      <p>削除完了予定日: <strong>${args.scheduled_deletion_at}</strong></p>
      <p>14 日以内に完全削除を完了します (§3.8.3 整合)。</p>
      <p>ご質問がある場合は ${process.env.EMAIL_SUPPORT ?? 'support@ugokimap.com'} までご連絡ください。</p>
    `,
    text: `削除請求受付。Request ID: ${args.request_id}、完了予定: ${args.scheduled_deletion_at}`,
  })
}
