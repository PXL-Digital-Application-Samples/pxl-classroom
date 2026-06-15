import { config } from './config.js'

export function formatDate(iso, timezone = null) {
  if (!iso) return '—'
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
