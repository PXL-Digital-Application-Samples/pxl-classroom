// Every confirmation the app asks, asked in the page (DESIGN.md §6, "A
// confirmation is asked in the page").
//
// `window.confirm()` cannot name its button - it says OK whatever is about to
// happen - and cannot be styled. The Teams tab moved off it first; this is the
// one service every confirmation goes through now, rendered by ONE host,
// `ConfirmHost.vue`, mounted beside the router view in App.vue.
//
// `askConfirm(question)` resolves `true` or `false`, so a caller reads as it
// did with confirm(): `if (!(await askConfirm({...}))) return`. A route guard
// returns the promise, which vue-router waits for.
//
// The rules - what a newer question, a navigation and a second answer do -
// are in lib/confirm-state.js, pure so the unit tests can run them; this file
// only gives them the reactive holder the host renders.

import { ref } from 'vue'
import { createConfirmService } from './confirm-state.js'

/** The question on screen, or null. Read by ConfirmHost.vue. */
export const pendingConfirm = ref(null)

export const { askConfirm, askText, answerConfirm, dismissConfirm, askDiscard } = createConfirmService(pendingConfirm)
