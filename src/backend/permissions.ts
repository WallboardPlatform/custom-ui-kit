import { WallboardValidationError, type VerifiedIdentity } from './validator.js';

/** Include all three fields in application database ownership checks. */
export interface CustomerScope {
  readonly serverUrl: string;
  readonly customerId: number;
  readonly userEmail: string;
}

export interface CustomerScopeOptions {
  /** Requested customer; regular users may only choose their own customer. */
  customerId?: number;
  /** Application-owned allowlist; ADMIN does not automatically own every tenant. */
  allowedAdminCustomerIds?: readonly number[];
}

export function resolveCustomerScope(identity: VerifiedIdentity, options: CustomerScopeOptions = {}): CustomerScope {
  const customerId = options.customerId ?? identity.customerId;
  if (typeof customerId !== 'number' || !Number.isSafeInteger(customerId) || customerId <= 0) {
    throw new WallboardValidationError('forbidden', 403, 'Choose an application-authorized customer.');
  }
  if (identity.role === 'ADMIN') {
    if (!options.allowedAdminCustomerIds?.includes(customerId)) {
      throw new WallboardValidationError('forbidden', 403, 'This application has not authorized the administrator for that customer.');
    }
  } else if (customerId !== identity.customerId) {
    throw new WallboardValidationError('forbidden', 403, 'The current user cannot access that customer.');
  }
  return Object.freeze({ serverUrl: identity.serverUrl, customerId, userEmail: identity.email });
}

/** A conservative building block; applications still define their own write policy. */
export function assertWritableIdentity(identity: VerifiedIdentity): void {
  if (identity.readOnly || identity.role === 'VIEWER' || identity.role === 'DEVICE_USER') {
    throw new WallboardValidationError('forbidden', 403, 'This identity has read-only application access.');
  }
}
