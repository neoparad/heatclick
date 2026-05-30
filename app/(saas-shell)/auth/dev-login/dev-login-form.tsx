/**
 * Owner / dogfood 専用・メール不要ログイン client form (続 119)
 *
 * email + 合言葉 (secret) を POST /api/auth/dev-login し、成功したら redirect 先へ遷移。
 * secret は HTTPS POST body でのみ送信 (URL に載せない)。
 */

'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, KeyRound, ShieldAlert, ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const schema = z.object({
  email: z.string().email('メールアドレスの形式が正しくありません'),
  secret: z.string().min(1, '合言葉を入力してください'),
})

type FormValues = z.infer<typeof schema>

interface DevLoginFormProps {
  redirect?: string
}

type Status =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success' }
  | { phase: 'error'; message: string }

export function DevLoginForm({ redirect }: DevLoginFormProps) {
  const [status, setStatus] = useState<Status>({ phase: 'idle' })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', secret: '' },
  })

  async function onSubmit(values: FormValues) {
    setStatus({ phase: 'submitting' })
    try {
      const response = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email, secret: values.secret, redirect }),
      })
      const data: { success?: boolean; error?: string; redirect?: string } = await response
        .json()
        .catch(() => ({ success: false }))

      if (!response.ok || !data.success) {
        const message =
          response.status === 429
            ? '試行回数の上限に達しました。1 分後に再度お試しください。'
            : response.status === 401
              ? 'メールアドレスまたは合言葉が違います。'
              : data.error ?? 'ログインに失敗しました。時間をおいて再度お試しください。'
        setStatus({ phase: 'error', message })
        return
      }

      // 成功: Cookie は Set-Cookie で既に付与済み。full navigation で遷移し、
      // middleware に新 Cookie を確実に認識させる。
      setStatus({ phase: 'success' })
      window.location.assign(data.redirect ?? '/dashboard')
    } catch {
      setStatus({
        phase: 'error',
        message: 'ネットワークエラーが発生しました。接続を確認してください。',
      })
    }
  }

  const busy = isSubmitting || status.phase === 'submitting' || status.phase === 'success'

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">メールアドレス</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
          disabled={busy}
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" role="alert" className="text-xs text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="secret">合言葉</Label>
        <Input
          id="secret"
          type="password"
          autoComplete="off"
          placeholder="••••••••••••••••"
          aria-invalid={Boolean(errors.secret)}
          aria-describedby={errors.secret ? 'secret-error' : undefined}
          disabled={busy}
          {...register('secret')}
        />
        {errors.secret ? (
          <p id="secret-error" role="alert" className="text-xs text-destructive">
            {errors.secret.message}
          </p>
        ) : null}
      </div>

      {status.phase === 'error' ? (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <span>{status.message}</span>
        </div>
      ) : null}

      <Button type="submit" variant="gradient" size="lg" className="w-full gap-2" disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            サインイン中…
          </>
        ) : (
          <>
            <KeyRound className="h-4 w-4" aria-hidden />
            合言葉でサインイン
            <ArrowRight className="h-4 w-4" aria-hidden />
          </>
        )}
      </Button>
    </form>
  )
}
