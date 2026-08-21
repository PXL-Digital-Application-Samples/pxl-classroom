<template>
  <header class="app-header" :class="{ 'is-sticky': sticky }">
    <div :class="contained ? 'container' : 'app-header-bare'">
      <div class="app-header-bar flex items-center justify-between gap-md">
        <div class="app-header-left flex items-center gap-sm">
          <!-- Default is the brand lockup; breadcrumb views override it. -->
          <slot name="left">
            <router-link to="/" class="app-header-logo-link" aria-label="PXL Classroom home">
              <img :src="logoUrl" alt="" class="header-logo" />
            </router-link>
            <router-link to="/" class="app-header-title">PXL Classroom</router-link>
          </slot>
        </div>

        <div class="app-header-right flex items-center gap-sm">
          <slot name="actions" />
          <ThemeToggle />
          <UserBadge v-if="user" :user="user" @logout="emit('logout')" />
        </div>
      </div>
    </div>
  </header>
</template>

<script setup>
import logoUrl from '../assets/logo.png'
import ThemeToggle from './ThemeToggle.vue'
import UserBadge from './UserBadge.vue'

// The single app bar for every route. Before this existed there were seven
// header classes across nine views, three of which (.dashboard-header on the
// two Usage views, .sandbox-header) were used but never defined - Vue's scoped
// styles do not leak, so those headers rendered with no background, no border
// and no sticky positioning at all.
//
// The right rail always carries ThemeToggle, so the theme control is reachable
// from every route including signed-out ones (DESIGN.md §5).
defineProps({
  // Passing a user renders UserBadge; omit it on signed-out or utility routes.
  user: { type: Object, default: null },
  // Wrap in .container to line the bar up with page content. Views that manage
  // their own width (Admin, Setup) pass false.
  contained: { type: Boolean, default: true },
  sticky: { type: Boolean, default: true },
})

const emit = defineEmits(['logout'])
</script>

<!-- No scoped block on purpose. Slot content is compiled in the PARENT's scope,
     so it carries the parent's data-v-* attribute and a scoped rule here would
     never reach it - the same mechanism that left .dashboard-header unstyled on
     the Usage views. The .app-header-* vocabulary lives in style.css. -->
