<script setup lang="ts">
import { ref, watch } from 'vue';
import { WB, readCompleteList, type WbDevice } from '@wallboard/custom-ui-kit';
import { WbAppFrame, WbAuthGate, WbConnectivityBanner, WbCustomerScopeGate, useWallboard, type CustomerOption } from '@wallboard/custom-ui-kit/vue';
import DeviceBoard from './DeviceBoard.vue';

const demo = new URLSearchParams(location.search).has('demo');
const { client, state } = useWallboard();
const customers = ref<CustomerOption[]>([]); const selected = ref<number | null>(null); const loading = ref(false); const error = ref<string | undefined>();
watch(() => state.value.status === 'authenticated' ? `${state.value.user?.email}|${state.value.user?.role}|${state.value.user?.customerId}` : null, async (_key, _previous, onCleanup) => {
  const user = state.value.user;
  const controller = new AbortController(); onCleanup(() => controller.abort());
  customers.value = []; selected.value = null; error.value = undefined;
  if (user?.role !== 'ADMIN') return;
  loading.value = true;
  try {
    const result = await readCompleteList<CustomerOption>(client.api, WB.customer, { instance: true, select: 'id,name', size: 100, sort: 'name,asc', signal: controller.signal });
    if (!controller.signal.aborted) customers.value = result;
  } catch (failure) { if (!controller.signal.aborted) error.value = failure instanceof Error ? failure.message : 'Could not load customers.'; }
  finally { if (!controller.signal.aborted) loading.value = false; }
});
const sample: WbDevice[] = [
  { id: 'demo-lobby', name: 'Lobby welcome', deviceStatus: 'ONLINE', platform: 'ANDROID' },
  { id: 'demo-cafe', name: 'Café menu', deviceStatus: 'ONLINE', platform: 'SAMSUNG' },
  { id: 'demo-meeting', name: 'Meeting room', deviceStatus: 'OFFLINE', platform: 'LG' },
  { id: 'demo-entrance', name: 'Main entrance', deviceStatus: 'ONLINE', platform: 'WINDOWS' },
];
</script>

<template>
  <WbConnectivityBanner />
  <WbAppFrame title="Device overview" :subtitle="demo ? 'Demo · synthetic devices' : 'Your screens, at a glance'">
    <DeviceBoard v-if="demo" :sample="sample" />
    <WbAuthGate v-else>
      <WbCustomerScopeGate v-model="selected" :customers="customers" :loading="loading" :error="error">
        <template #default="{ customerId }"><DeviceBoard :key="customerId" :customer-id="customerId" /></template>
      </WbCustomerScopeGate>
    </WbAuthGate>
    <template #footer>Built with the Wallboard Custom UI Kit. This example reads device data.</template>
  </WbAppFrame>
</template>
