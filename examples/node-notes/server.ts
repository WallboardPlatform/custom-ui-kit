import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  assertWritableIdentity,
  parseBearerToken,
  resolveCustomerScope,
  WallboardValidationError,
  type WallboardValidator,
} from '../../src/backend/index.js';
import { NotesStore, validateNoteText } from './store.js';

export interface NotesServerOptions {
  validator: Pick<WallboardValidator, 'validate'>;
  store: NotesStore;
  /** Exact browser origin, configured by the operator. Requests cannot override it. */
  allowedOrigin: string;
  /** Application permission: false by default, regardless of Wallboard role. */
  allowWrites?: boolean;
  allowedAdminCustomerIds?: readonly number[];
  maxBodyBytes?: number;
}

class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readTextBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'unsupported_media_type', 'Send an application/json body.');
  }
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxBodyBytes) {
    request.resume();
    throw new RequestError(413, 'body_too_large', 'The request body is too large.');
  }
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    function cleanup(): void {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    }
    function onData(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        cleanup();
        request.resume();
        reject(new RequestError(413, 'body_too_large', 'The request body is too large.'));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(): void {
      cleanup();
      reject(new RequestError(400, 'invalid_body', 'The request body could not be read.'));
    }
    function onAborted(): void {
      onError();
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
  let body: unknown;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid_json', 'Send a valid JSON body.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'text')) {
    throw new RequestError(400, 'invalid_note', 'Send only the note text.');
  }
  try {
    return validateNoteText((body as { text?: unknown }).text);
  } catch {
    throw new RequestError(400, 'invalid_note', 'Note text must contain 1–2,000 characters.');
  }
}

function requestedCustomerId(request: IncomingMessage): number | undefined {
  const value = request.headers['x-customer-id'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new RequestError(400, 'invalid_customer', 'X-Customer-Id must be a positive integer.');
  }
  return Number(value);
}

export function createNotesServer(options: NotesServerOptions) {
  const allowedOrigin = new URL(options.allowedOrigin);
  if (allowedOrigin.origin !== options.allowedOrigin || !['http:', 'https:'].includes(allowedOrigin.protocol)) {
    throw new Error('Configure an exact allowed browser origin, without a trailing slash or path.');
  }
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('Configure a positive body size limit.');

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Vary', 'Origin');
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== options.allowedOrigin) {
        throw new RequestError(403, 'origin_not_allowed', 'This browser origin is not allowed.');
      }
      if (origin !== undefined) {
        response.setHeader('Access-Control-Allow-Origin', options.allowedOrigin);
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const noteMatch = path.match(/^\/api\/notes\/([1-9]\d*)$/);
      if (path !== '/api/session' && path !== '/api/notes' && !noteMatch) {
        throw new RequestError(404, 'not_found', 'The endpoint does not exist.');
      }
      const allowedMethods = path === '/api/session' ? ['GET', 'OPTIONS'] :
        noteMatch ? ['PATCH', 'DELETE', 'OPTIONS'] : ['GET', 'POST', 'OPTIONS'];
      if (!allowedMethods.includes(request.method ?? '')) {
        response.setHeader('Allow', allowedMethods.join(', '));
        throw new RequestError(405, 'method_not_allowed', 'This method is not supported.');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', allowedMethods.filter((method) => method !== 'OPTIONS').join(', '));
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Customer-Id');
        response.setHeader('Access-Control-Max-Age', '600');
        response.writeHead(204);
        response.end();
        return;
      }
      if ((request.headersDistinct.authorization?.length ?? 0) !== 1) {
        throw new WallboardValidationError('invalid_token', 401, 'Send exactly one bearer authorization header.');
      }
      const accessToken = parseBearerToken(request.headers.authorization);
      const identity = await options.validator.validate(accessToken);
      const scope = resolveCustomerScope(identity, {
        customerId: requestedCustomerId(request),
        allowedAdminCustomerIds: options.allowedAdminCustomerIds,
      });
      if (path === '/api/session') {
        sendJson(response, 200, { identity, scope, writesEnabled: options.allowWrites === true &&
          !identity.readOnly && identity.role !== 'VIEWER' && identity.role !== 'DEVICE_USER' });
        return;
      }
      if (request.method === 'GET') {
        sendJson(response, 200, { notes: options.store.list(scope) });
        return;
      }
      if (options.allowWrites !== true) {
        throw new RequestError(403, 'writes_disabled', 'Application note writes are disabled.');
      }
      assertWritableIdentity(identity);
      if (request.method === 'POST') {
        const text = await readTextBody(request, maxBodyBytes);
        sendJson(response, 201, options.store.create(scope, text));
        return;
      }
      const id = Number(noteMatch![1]);
      if (!Number.isSafeInteger(id)) throw new RequestError(404, 'not_found', 'The note does not exist.');
      if (request.method === 'PATCH') {
        const text = await readTextBody(request, maxBodyBytes);
        const note = options.store.update(scope, id, text);
        if (!note) throw new RequestError(404, 'not_found', 'The note does not exist.');
        sendJson(response, 200, note);
        return;
      }
      if (!options.store.delete(scope, id)) throw new RequestError(404, 'not_found', 'The note does not exist.');
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
    })().catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof WallboardValidationError || error instanceof RequestError) {
        if (error.statusCode === 401) response.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(response, error.statusCode, { error: error.code, message: error.message });
      } else {
        // Never return raw DB errors, credentials, or upstream response bodies.
        sendJson(response, 500, { error: 'internal_error', message: 'The operation could not be completed.' });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
