import { nextTick } from 'vue'

/**
 * Keep an opened dropdown inside the window.
 *
 * These menus anchor to their trigger's RIGHT edge, which is right while the
 * toolbar is right-aligned. On a narrow window that toolbar WRAPS and the
 * triggers land at the left edge, so a 437px menu anchored right of a button at
 * x=15 starts at x=-315 and only its last few pixels are on screen (reported
 * 2026-09-02).
 *
 * A media query cannot fix this. The wrap point is not a fixed width: it moves
 * with what the toolbar contains, and it moves again by the width of a
 * scrollbar depending on how tall the page happens to be - measured flipping
 * either way at 950px between runs. So this measures the rendered menu and
 * shifts it only when it would actually overflow, which is what Floating UI's
 * `shift` middleware does and what `position-try-fallbacks` would do if its
 * overflow were evaluated against the viewport rather than the containing
 * block.
 *
 * Both directions, because this project has had it wrong each way round: the
 * menus were `left: 0` once and overflowed the RIGHT edge, which is why they
 * anchor right at all.
 *
 * Shared by the assignment page's menus and the assignment header
 * (AssignmentHeader.vue): one rule, so the two cannot drift.
 *
 * @param {import('vue').Ref<HTMLElement|null>} containerRef the `.dropdown-container`
 */
export async function keepMenuInView(containerRef) {
  await nextTick()
  const container = containerRef?.value
  const menu = container?.querySelector('.export-dropdown-menu')
  if (!menu) return

  // Start from the stylesheet's own anchoring before measuring, or a previous
  // clamp decides the answer for the next one.
  menu.style.left = ''
  menu.style.right = ''

  const pad = 8
  const cRect = container.getBoundingClientRect()
  const mRect = menu.getBoundingClientRect()

  if (mRect.left < pad) {
    menu.style.right = 'auto'
    menu.style.left = `${Math.round(pad - cRect.left)}px`
  } else if (mRect.right > window.innerWidth - pad) {
    menu.style.left = 'auto'
    menu.style.right = `${Math.round(pad - (window.innerWidth - cRect.right))}px`
  }
}
