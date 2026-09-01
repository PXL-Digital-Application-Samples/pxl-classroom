// Keep Tab cycling inside an open dialog, and give focus back on close.
//
// This lived inline in AssignmentDetailView as `modalEl` + `trapTab` +
// a `modalReturnFocus` variable, three pieces of one behaviour spread across
// 1,800 lines of a 3,800-line view. It is not view logic at all - every modal
// in the app needs it, and the ones that do not have it are simply missing it.
//
// Returns the ref to bind and the handler to attach:
//
//   const { el, onKeydown } = useFocusTrap()
//   <div ref="el" @keydown="onKeydown">
//
// `focusFirst()` is called on mount by default, because a dialog that opens
// without moving focus leaves a keyboard user tabbing through the page behind
// it before they reach the thing that just appeared.

import { onMounted, onBeforeUnmount, ref } from 'vue'

const FOCUSABLE = 'input, textarea, select, button:not([disabled]), a[href]'

export function useFocusTrap({ autofocus = true } = {}) {
  const el = ref(null)
  // Captured before focus moves, restored after the dialog goes away, so the
  // trigger the user pressed is where they land.
  let returnFocus = null

  function focusFirst() {
    // `offsetParent === null` filters what is present but not shown - a control
    // inside a collapsed branch is not somewhere focus can usefully go.
    const first = [...(el.value?.querySelectorAll(FOCUSABLE) ?? [])].find((n) => n.offsetParent !== null)
    first?.focus()
  }

  function onKeydown(e) {
    if (e.key !== 'Tab' || !el.value) return
    const focusables = [...el.value.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    returnFocus = document.activeElement
    if (autofocus) focusFirst()
  })

  onBeforeUnmount(() => {
    // Optional-called: the trigger may itself have been removed by whatever the
    // dialog did, and losing focus to <body> is better than throwing on unmount.
    returnFocus?.focus?.()
    returnFocus = null
  })

  return { el, onKeydown, focusFirst }
}
