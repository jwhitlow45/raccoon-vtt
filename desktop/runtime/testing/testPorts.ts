/**
 * The fixed ports the desktop integration and e2e tests listen on. They sit
 * below 32768, under Linux's ephemeral range (32768 to 60999 by default).
 * Any client connection on the machine can take a port in that range as its
 * own end, and one it closed from its own end stays in TIME_WAIT for 60 s.
 * Linux refuses a listener on that port until then, even with SO_REUSEADDR,
 * so a supervisor started on it ends as portInUse. macOS and Windows start
 * their ranges at 49152. testPorts.test.ts holds every port to the rule, and
 * on Linux to the machine's own range.
 */
export const TEST_PORTS = {
  appServer: 30402,
  lockFirst: 30410,
  lockSecond: 30411,
  postgresLeftFirst: 30412,
  postgresLeftNext: 30413,
  postgresOwnerFirst: 30414,
  postgresOwnerSecond: 30415,
  restore: 30431,
  upgrade: 30432,
  shellE2e: 30500,
  windowE2e: 30600,
} as const;
