export interface AuthUser {
  /** Subject (unique user ID from IdP) */
  sub: string;
  /** Email address */
  email?: string;
  /** Display name */
  name?: string;
}
