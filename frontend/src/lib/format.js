import { config } from './config.js'

export function formatDate(iso, timezone = null) {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: timezone || config.timezone,
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZoneName: 'short',
    })
  } catch {
    try {
      return new Date(iso).toISOString()
    } catch {
      return iso
    }
  }
}

export function isPast(iso) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && t <= Date.now()
}

/**
 * Always a duration, never a date: the result is wrapped in "in …" / "… ago",
 * so an absolute date here reads as "in 30 Aug 2026". Every caller already
 * shows the exact timestamp alongside (the deadline card's label, or a title
 * tooltip), so this only ever needs to answer "how long?".
 */
export function formatRelative(iso) {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diffMs)) return ''
  const abs = Math.abs(diffMs)
  const future = diffMs < 0
  const min = 60_000, hr = 3_600_000, day = 86_400_000
  let s
  if (abs < hr) s = `${Math.max(1, Math.round(abs / min))}m`
  else if (abs < day) s = `${Math.round(abs / hr)}h`
  else if (abs < 60 * day) s = `${Math.round(abs / day)}d`
  else if (abs < 730 * day) s = `${Math.round(abs / (30 * day))}mo`
  else s = `${Math.round(abs / (365 * day))}y`
  return future ? `in ${s}` : `${s} ago`
}

