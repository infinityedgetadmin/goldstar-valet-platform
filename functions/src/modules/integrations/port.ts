export interface SecretWriter {
  /**
   * Creates the secret (if it doesn't already exist) and adds a new version holding `value`.
   * Returns the full resource name of the created version
   * (`projects/{p}/secrets/{secretId}/versions/{n}`).
   */
  setSecret(secretId: string, value: string): Promise<{ version: string }>;
}
