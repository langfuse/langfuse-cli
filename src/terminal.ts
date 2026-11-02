// Escape untrusted text before adding the output's own line breaks.
export function escapeTerminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
