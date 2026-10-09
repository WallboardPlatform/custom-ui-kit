import { computed, defineComponent, h, inject, onMounted, onScopeDispose, shallowRef, type App, type InjectionKey, type PropType } from 'vue';
import type { WallboardClient } from '../browser/index.js';

const CLIENT: InjectionKey<WallboardClient> = Symbol('wallboard-client');

export function createWallboardPlugin(client: WallboardClient) {
  return { install(app: App) { app.provide(CLIENT, client); } };
}

export function useWallboard() {
  const client = inject(CLIENT);
  if (!client) throw new Error('Install createWallboardPlugin(client) before using Wallboard components.');
  const state = shallowRef(client.getState());
  const unsubscribe = client.subscribe((next) => { state.value = next; });
  onScopeDispose(unsubscribe);
  return { client, state, api: client.api, user: computed(() => state.value.user) };
}

export const WbAuthGate = defineComponent({
  name: 'WbAuthGate',
  props: { title: { type: String, default: 'Sign in to your Wallboard' }, description: { type: String, default: 'Use your Wallboard account to open this application.' } },
  setup(props, { slots }) {
    const { client, state } = useWallboard();
    const loginError = shallowRef<string | null>(null);
    onMounted(() => { if (state.value.status === 'idle') void client.initialize().catch(() => {}); });
    const signIn = async () => {
      loginError.value = null;
      try { await client.signIn(); } catch (error) { loginError.value = error instanceof Error ? error.message : 'Sign-in failed.'; }
    };
    return () => {
      if (state.value.status === 'authenticated') return slots.default?.();
      if (state.value.status === 'idle' || state.value.status === 'checking') return h('div', { class: 'wb-state', role: 'status' }, slots.loading?.() ?? 'Connecting to Wallboard…');
      return h('section', { class: 'wb-card wb-signin' }, [
        h('span', { class: 'wb-eyebrow' }, 'WALLBOARD'), h('h2', props.title), h('p', props.description),
        state.value.error || loginError.value ? h('p', { class: 'wb-error', role: 'alert' }, loginError.value ?? state.value.error?.message) : null,
        slots.anonymous?.({ signIn }) ?? h('button', { class: 'wb-button', onClick: signIn }, 'Continue with Wallboard'),
      ]);
    };
  },
});

export const WbAppFrame = defineComponent({
  name: 'WbAppFrame',
  props: { title: { type: String, required: true }, subtitle: String },
  setup(props, { slots }) {
    const { client, user } = useWallboard();
    return () => h('div', { class: 'wb-app' }, [
      h('header', { class: 'wb-header' }, [
        h('div', { class: 'wb-brand' }, [h('span', { class: 'wb-mark', 'aria-hidden': true }, 'W'), h('div', [h('strong', props.title), props.subtitle ? h('small', props.subtitle) : null])]),
        h('nav', { class: 'wb-actions', 'aria-label': 'Account' }, [slots.actions?.(), user.value ? h('span', { class: 'wb-user' }, user.value.name || user.value.email) : null, user.value ? h('button', { class: 'wb-button wb-button-quiet', onClick: () => client.signOut() }, 'Sign out') : null]),
      ]), h('main', { class: 'wb-main' }, slots.default?.()),
      slots.footer ? h('footer', { class: 'wb-footer' }, slots.footer()) : null,
    ]);
  },
});

export interface CustomerOption { id: number; name: string; }

export const WbCustomerScopeGate = defineComponent({
  name: 'WbCustomerScopeGate',
  props: {
    modelValue: { type: Number as PropType<number | null>, default: null },
    customers: { type: Array as PropType<CustomerOption[]>, default: () => [] },
    loading: Boolean, error: String,
  },
  emits: { 'update:modelValue': (_id: number | null) => true },
  setup(props, { slots, emit }) {
    const { user } = useWallboard();
    return () => {
      if (!user.value) return null;
      if (user.value.role !== 'ADMIN') return user.value.customerId ? slots.default?.({ customerId: user.value.customerId }) : h('p', { class: 'wb-error', role: 'alert' }, 'Your account has no customer scope.');
      const chosen = props.customers.find((customer) => customer.id === props.modelValue);
      return h('div', [
        h('div', { class: 'wb-scope' }, [h('label', { for: 'wb-customer-scope' }, 'Customer'),
          h('select', { id: 'wb-customer-scope', class: 'wb-input', value: chosen?.id ?? '', disabled: props.loading, onChange: (event: Event) => { const value = (event.target as HTMLSelectElement).value; emit('update:modelValue', value ? Number(value) : null); } }, [h('option', { value: '' }, props.loading ? 'Loading customers…' : 'Choose a customer'), ...props.customers.map((customer) => h('option', { value: customer.id }, customer.name))]),
          props.error ? h('p', { class: 'wb-error', role: 'alert' }, props.error) : null,
        ]), chosen ? slots.default?.({ customerId: chosen.id }) : h('div', { class: 'wb-state' }, 'Select a customer to load its data.'),
      ]);
    };
  },
});

export const WbDataState = defineComponent({
  name: 'WbDataState',
  props: { loading: Boolean, error: String, empty: Boolean, emptyTitle: { type: String, default: 'Nothing here yet' }, emptyDescription: { type: String, default: 'Try a different filter or come back later.' } },
  emits: ['retry'],
  setup(props, { slots, emit }) {
    return () => props.loading ? h('div', { class: 'wb-state', role: 'status' }, 'Loading…') : props.error ? h('div', { class: 'wb-state', role: 'alert' }, [h('h3', 'Could not load data'), h('p', props.error), h('button', { class: 'wb-button wb-button-quiet', onClick: () => emit('retry') }, 'Try again')]) : props.empty ? h('div', { class: 'wb-state' }, [h('h3', props.emptyTitle), h('p', props.emptyDescription)]) : slots.default?.();
  },
});

export function useOnlineStatus() {
  const online = shallowRef(typeof navigator === 'undefined' || navigator.onLine);
  const update = () => { online.value = navigator.onLine; };
  onMounted(() => { window.addEventListener('online', update); window.addEventListener('offline', update); });
  onScopeDispose(() => { if (typeof window !== 'undefined') { window.removeEventListener('online', update); window.removeEventListener('offline', update); } });
  return online;
}

export const WbConnectivityBanner = defineComponent({
  name: 'WbConnectivityBanner',
  setup() { const online = useOnlineStatus(); return () => online.value ? null : h('div', { class: 'wb-offline', role: 'status' }, 'You are offline. Changes need a connection.'); },
});

/** Ignore superseded responses when filters or customer scope change. */
export function useAsyncData<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  let controller: AbortController | undefined;
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    controller?.abort(); controller = new AbortController();
    loading.value = true; error.value = null; data.value = null;
    try { const result = await loader(controller.signal); if (current === generation) data.value = result; }
    catch (failure) { if (current === generation && !controller.signal.aborted) error.value = failure instanceof Error ? failure.message : 'Request failed.'; }
    finally { if (current === generation) loading.value = false; }
  }
  onScopeDispose(() => { generation++; controller?.abort(); });
  return { data, loading, error, refresh };
}
