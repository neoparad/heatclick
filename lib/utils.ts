import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// endDateが日付のみ(YYYY-MM-DD)の場合、当日データを含めるため 23:59:59 を補完
export function normalizeEndDate(endDate: string): string {
  if (endDate && endDate.length === 10) return endDate + ' 23:59:59'
  return endDate
}