/**
 * Generic UI utilities (shadcn/ui 標準)
 *
 * 親 SSOT §3.6 / §6.3 S0-02
 */

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
