/**
 * Sign-in client form (magic link 送信)
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-01
 */

'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, MailCheck, MailWarning, ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const schema = z.object({
  email: z.string().email('メールアドレスの形式が正しくありません'),
})

type FormValues = z.infer<typeof schema>

interface SignInFormProps {
  error: string | null
  redirect?: string
}

type Status =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; email: string }
  | { phase: 'error'; message: string }

export function SignInForm({ error, redirect }: SignInFormProps) {
  const [status, setStatus] = useState<Status>(error ? { phase: 'error', message: error } : { phase: 'idle' })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  })

  async function onSubmit(values: FormValues) {
    setStatus({ phase: 'sending' })
    try {
      const response = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email, redirect }),
      })
      const data: { success?: boolean; error?: string; code?: string } = await response
        .json()
        .catch(() => ({ success: false }))

      if (!response.ok || !data.success) {
        const message =
          response.status === 429
            ? '送信回数の上限に達しました。1 時間後に再度お試しください。'
            : data.error ?? 'メールの送信に失敗しました。時間をおいて再度お試しください。'
        setStatus({ phase: 'error', message })
        return
      }

      setStatus({ phase: 'sent', email: values.email })
    } catch {
      setStatus({
        phase: 'error',
        message: 'ネットワークエラーが発生しました。接続を確認してください。',
      })
    }
  }

  if (status.phase === 'sent') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 rounded-md border border-success/30 bg-success/10 p-5 text-sm text-foreground"
      >
        <div className="flex items-start gap-3">
          <MailCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" aria-hidden />
          <div>
            <p className="font-semibold">サインインリンクを送信しました</p>
            <p className="mt-1 text-text-2">
              <span className="font-mono">{status.email}</span> 宛にメールを送信しました。
              受信トレイをご確認の上、15 分以内にリンクをクリックしてください。
            </p>
            <p className="mt-3 text-xs text-text-3">
              メールが届かない場合は、迷惑メールフォルダもご確認ください。
            </p>
          </div>
        </div>
      </div>
    )
  }

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
          disabled={isSubmitting || status.phase === 'sending'}
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" role="alert" className="text-xs text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      {status.phase === 'error' ? (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <MailWarning className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <span>{status.message}</span>
        </div>
      ) : null}

      <Button
        type="submit"
        variant="gradient"
        size="lg"
        className="w-full gap-2"
        disabled={isSubmitting || status.phase === 'sending'}
      >
        {status.phase === 'sending' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            送信中…
          </>
        ) : (
          <>
            magic link を送信
            <ArrowRight className="h-4 w-4" aria-hidden />
          </>
        )}
      </Button>
    </form>
  )
}
