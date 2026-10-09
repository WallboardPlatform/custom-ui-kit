<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { WB, type WbDevice, type WbPage } from '@wallboard/custom-ui-kit';
import { WbDataState, useWallboard, useAsyncData } from '@wallboard/custom-ui-kit/vue';
const props = defineProps<{ customerId?: number; sample?: WbDevice[] }>();
const { api } = useWallboard();
const filter = ref('');
const result = useAsyncData(async (signal) => {
  if (props.sample) return props.sample;
  if (!props.customerId) throw new Error('Choose a customer first.');
  const page = await api.forCustomer(props.customerId).get<WbPage<WbDevice>>(WB.device, { query: { page: 0, size: 100, select: 'id,name,deviceStatus,platform', sort: 'name,asc' }, signal });
  return Array.isArray(page) ? page : page.content;
});
onMounted(result.refresh);
const devices = computed(() => (result.data.value ?? []).filter((device) => (device.name ?? '').toLowerCase().includes(filter.value.toLowerCase())));
const online = computed(() => devices.value.filter((device) => device.deviceStatus === 'ONLINE').length);
</script>

<template>
  <div class="wb-page-heading">
    <div><span class="wb-eyebrow">DEVICE OVERVIEW</span><h1>Keep your screens in view.</h1><p>A read-only overview of the first 100 devices in your selected customer. Search, check connectivity, and build your own workflow from here.</p></div>
    <button class="wb-button wb-button-quiet" :disabled="result.loading.value" @click="result.refresh">Refresh</button>
  </div>
  <div class="wb-stats"><div><strong>{{ devices.length }}</strong><span>In this view</span></div><div><strong>{{ online }}</strong><span>Online</span></div><div><strong>{{ devices.length - online }}</strong><span>Not online</span></div></div>
  <label for="device-search" class="wb-label">Search devices</label><input id="device-search" v-model="filter" type="search" class="wb-input" placeholder="Search by name" style="display:block;width:min(100%,360px);margin:8px 0 24px">
  <WbDataState :loading="result.loading.value" :error="result.error.value ?? undefined" :empty="devices.length === 0" empty-title="No devices to show" empty-description="Try a different search or customer." @retry="result.refresh">
    <div class="wb-grid"><article v-for="device in devices" :key="device.id" class="wb-card wb-device"><div class="wb-device-icon" aria-hidden="true" /><h3>{{ device.name || 'Unnamed device' }}</h3><p>{{ device.platform || 'Platform unavailable' }}</p><span class="wb-status" :class="{ 'wb-status-offline': device.deviceStatus !== 'ONLINE' }">{{ device.deviceStatus === 'ONLINE' ? 'Online' : 'Not online' }}</span></article></div>
  </WbDataState>
</template>
