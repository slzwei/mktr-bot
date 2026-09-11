/** Pure guard: callers may validate deployment inputs without starting a gateway. */
export function assertStrongEslPassword(password: string | undefined): asserts password is string {
  if (!password || password.trim().toLowerCase() === "cluecon" || password.length < 16 || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error("MKTR_FREESWITCH_ESL_PASSWORD must be at least 16 characters, must not be the default password, and must not contain control characters.");
  }
}

export function assertGatewayStartupConfiguration(configuration: { telephonyMode: string; freeswitch: { password: string } }): void {
  if (configuration.telephonyMode === "freeswitch") assertStrongEslPassword(configuration.freeswitch.password);
}
