<template>
  <div id="app-root">
    <!-- The beta channel (lib/channel.js). On every route, because a beta that
         looks exactly like production is how a test edit lands on a live
         course without anybody noticing which tab it was made in. -->
    <div v-if="channel" class="channel-banner" role="note">
      <strong>Beta</strong>
      <span v-if="BUILD_SHORT_SHA" class="channel-banner-sha">{{ BUILD_SHORT_SHA }}</span>
      <span>Changes here are real: same courses, same students as the live app.</span>
      <a :href="liveUrl">Open the live app</a>
    </div>
    <router-view />
    <!-- Every confirmation the app asks (lib/confirm.js), after the view so it
         stacks over the view's own dialogs. -->
    <ConfirmHost />
    <Toast />
    <!-- Rendered here, not inside a view, and deliberately. The drawer is
         position: fixed, so any ancestor carrying a transform (fade-in leaves
         one) would become its containing block and put it off-screen. -->
    <HelpDrawer />
  </div>
</template>

<script setup>
import Toast from './components/Toast.vue'
import ConfirmHost from './components/ConfirmHost.vue'
import HelpDrawer from './components/HelpDrawer.vue'
import { buildChannel, publicBaseUrl } from './lib/channel.js'
import { BUILD_SHORT_SHA } from './lib/build-info.js'

const channel = buildChannel()
const liveUrl = publicBaseUrl()
</script>
