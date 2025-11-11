'use client'

import { AlertCircle, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from './button'

interface ErrorMessageProps {
  title?: string
  message: string
  onDismiss?: () => void
  variant?: 'error' | 'warning' | 'info'
}

export default function ErrorMessage({ 
  title, 
  message, 
  onDismiss,
  variant = 'error' 
}: ErrorMessageProps) {
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  const variantClasses = {
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  }

  const handleDismiss = () => {
    setDismissed(true)
    if (onDismiss) {
      onDismiss()
    }
  }

  return (
    <div className={`border rounded-lg p-4 ${variantClasses[variant]}`}>
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          {title && <h4 className="font-semibold mb-1">{title}</h4>}
          <p className="text-sm">{message}</p>
        </div>
        {onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            className="h-6 w-6 p-0 hover:bg-transparent"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  )
}




