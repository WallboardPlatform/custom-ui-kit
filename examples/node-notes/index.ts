import { createWallboardValidator } from '../../src/backend/index.js';
import { createNotesServer } from './server.js';
import { NotesStore } from './store.js';

const serverUrl = process.env.WB_SERVER_URL;
const allowedOrigin = process.env.NOTES_ALLOWED_ORIGIN;
if (!serverUrl || !allowedOrigin) {
  throw new Error('Set WB_SERVER_URL and NOTES_ALLOWED_ORIGIN before starting the example.');
}
const adminIds = process.env.NOTES_ADMIN_CUSTOMER_IDS?.split(',').map((value) => Number(value.trim())) ?? [];
if (adminIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  throw new Error('NOTES_ADMIN_CUSTOMER_IDS must contain comma-separated positive customer IDs.');
}
const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Configure a valid PORT.');
const store = new NotesStore(process.env.NOTES_DATABASE ?? 'notes.sqlite');
const server = createNotesServer({
  validator: createWallboardValidator({ serverUrl }),
  store,
  allowedOrigin,
  allowWrites: process.env.NOTES_ALLOW_WRITES === 'true',
  allowedAdminCustomerIds: adminIds,
});
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Notes example listening on http://${host}:${port}`);
});
function stop(): void {
  server.close(() => {
    store.close();
    process.exitCode = 0;
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
