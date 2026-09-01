/**
 * Utilidades compartilhadas entre os módulos do servidor.
 *
 * Extraído para evitar duplicação: `average`, `logDev`, `warnDev` e
 * `terminalDetalhado` existiam em cópias idênticas em index.js, rooms.js e
 * admin.js.
 */

export const terminalDetalhado = /^(0|false|off|desligado|nao|não)$/i.test(
  String(process.env.TERMINAL_LIMPO ?? ''),
);
export const logDev = (...args) => terminalDetalhado && console.log(...args);
export const warnDev = (...args) => terminalDetalhado && console.warn(...args);

export function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}
