// Exit-code contract (stable, machine-readable):
//   0 successful API response or local command
//   1 unexpected internal failure
//   2 invalid command or input (usage); no request was sent
//   3 missing or invalid configuration/credentials; no request was sent
//   4 network, DNS, TLS, or timeout failure reaching the host
//   5 the API responded with a non-success HTTP status
//   6 local file or bundled-contract failure
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 3;
export const EXIT_NETWORK = 4;
export const EXIT_HTTP = 5;
export const EXIT_LOCAL = 6;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_USAGE,
  ) {
    super(message);
  }
}
