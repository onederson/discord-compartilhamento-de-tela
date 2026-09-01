export const STREAM_STALL_MS = 3_500;
export const RECOVERY_COOLDOWN_MS = 2_500;

/** Decide sem efeitos colaterais se um stream iniciado parou de desenhar. */
export function shouldRecoverStream({
  visible,
  started,
  lastFrameAt,
  lastRecoveryAt = 0,
  now = Date.now(),
  stallMs = STREAM_STALL_MS,
  cooldownMs = RECOVERY_COOLDOWN_MS,
}) {
  return Boolean(
    visible &&
    started &&
    Number.isFinite(lastFrameAt) &&
    now - lastFrameAt >= stallMs &&
    now - lastRecoveryAt >= cooldownMs,
  );
}

/** Mantém somente intenções que ainda correspondem a transmissões no ar. */
export function recoverableSlots(watching, available) {
  return [...watching].filter((slot) => available.has(slot));
}
