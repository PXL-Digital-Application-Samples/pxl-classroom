<script setup>
import { computed } from 'vue'

// The URL where the frontend is hosted (used for homepage and callback)
const hostUrl = computed(() => window.location.origin + import.meta.env.BASE_URL)

const manifest = computed(() => {
  return JSON.stringify({
    name: "PXL Classroom Provisioner",
    url: hostUrl.value,
    hook_attributes: {
      url: hostUrl.value,
    },
    redirect_url: hostUrl.value,
    public: true,
    default_permissions: {
      actions: "write",
      administration: "write",
      contents: "write",
      metadata: "read",
      secrets: "write"
    },
    default_events: [],
    request_oauth_on_install: true,
    setup_url: hostUrl.value,
    setup_on_update: false
  })
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
    <div class="sm:mx-auto sm:w-full sm:max-w-md">
      <h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
        Automated App Setup
      </h2>
      <p class="mt-2 text-center text-sm text-gray-600">
        Click the button below to instantly generate the central GitHub App with all correct permissions.
      </p>
    </div>

    <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
      <div class="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
        <form action="https://github.com/settings/apps/new" method="post">
          <input type="hidden" name="manifest" :value="manifest" />
          
          <div class="mt-6">
            <button type="submit" class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              Create GitHub App
            </button>
          </div>
        </form>

        <div class="mt-6 text-sm text-gray-500">
          <h3 class="font-medium text-gray-900 mb-2">Next Steps:</h3>
          <ol class="list-decimal pl-5 space-y-1">
            <li>Click the button above and select your Organization.</li>
            <li>Click <strong>Create GitHub App</strong> at the bottom of the GitHub page.</li>
            <li>Download the generated <strong>Private Key</strong>.</li>
            <li>Copy the <strong>App ID</strong> and <strong>Client ID</strong>.</li>
            <li>Add them as secrets to your main repository and re-run the Deployment Action!</li>
          </ol>
        </div>
      </div>
    </div>
  </div>
</template>
