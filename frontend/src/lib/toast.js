import { ref } from 'vue'

export const toasts = ref([])

let idCounter = 0

// Success/info auto-dismiss quickly; errors carry remediation text (often two
// sentences) and stay long enough to read — and can always be dismissed or
// paused (hover) via the Toast component.
const DURATION_MS = { success: 5000, info: 7000, error: 15000 }

export const toast = {
  success(message, options) {
    addToast(message, 'success', options)
  },
  error(message, options) {
    addToast(message, 'error', options)
  },
  info(message, options) {
    addToast(message, 'info', options)
  }
}

export function dismissToast(id) {
  const t = toasts.value.find((t) => t.id === id)
  if (t?.timer) clearTimeout(t.timer)
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function pauseToast(id) {
  const t = toasts.value.find((t) => t.id === id)
  if (t?.timer) {
    clearTimeout(t.timer)
    t.timer = null
  }
}

export function resumeToast(id) {
  const t = toasts.value.find((t) => t.id === id)
  if (t && !t.timer) {
    t.timer = setTimeout(() => dismissToast(id), DURATION_MS[t.type] ?? 5000)
  }
}

function addToast(message, type, options = {}) {
  const id = idCounter++
  const entry = { id, message, type, link: options.link || null, timer: null }
  entry.timer = setTimeout(() => dismissToast(id), DURATION_MS[type] ?? 5000)
  toasts.value.push(entry)
}
