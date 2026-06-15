import { ref } from 'vue'

export const toasts = ref([])

let idCounter = 0

export const toast = {
  success(message) {
    addToast(message, 'success')
  },
  error(message) {
    addToast(message, 'error')
  },
  info(message) {
    addToast(message, 'info')
  }
}

function addToast(message, type) {
  const id = idCounter++
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }, 5000)
}
