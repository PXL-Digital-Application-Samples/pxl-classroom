<template>
  <div id="app-root">
    <router-view />
    <Toast />
    <!-- Rendered here, not inside a view, and deliberately. The drawer is
         position: fixed, so any ancestor carrying a transform (fade-in leaves
         one) would become its containing block and put it off-screen. -->
    <HelpDrawer />
  </div>
</template>

<script setup>
import Toast from './components/Toast.vue'
import HelpDrawer from './components/HelpDrawer.vue'
</script>
