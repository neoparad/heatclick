'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { verifySession } from '@/lib/auth'

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const [isVerified, setIsVerified] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    let cancelled = false

    async function checkAuth() {
      try {
        const user = await verifySession()
        if (cancelled) return

        if (!user) {
          router.replace(`/auth/login?redirect=${encodeURIComponent(pathname)}`)
          return
        }

        setIsVerified(true)
      } catch {
        if (!cancelled) {
          router.replace('/auth/login')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    checkAuth()
    return () => { cancelled = true }
  }, [router, pathname])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!isVerified) return null

  return <>{children}</>
}
