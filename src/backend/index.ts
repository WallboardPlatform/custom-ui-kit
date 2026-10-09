export {
  createWallboardValidator,
  parseBearerToken,
  WallboardValidationError,
  wallboardRoles,
  type VerifiedIdentity,
  type WallboardRole,
  type WallboardValidator,
  type WallboardValidatorOptions,
  type ValidationErrorCode,
} from './validator.js';
export {
  assertWritableIdentity,
  resolveCustomerScope,
  type CustomerScope,
  type CustomerScopeOptions,
} from './permissions.js';
