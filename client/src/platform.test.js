import { describe, expect, it, vi } from 'vitest';
import { canCaptureScreen, defaultBroadcastQuality, isMobileClient } from './platform.js';

describe('adaptação de plataforma', () => {
  it('reconhece o sinal estruturado de navegador móvel', () => {
    expect(isMobileClient({ userAgentData: { mobile: true }, userAgent: '' })).toBe(true);
  });

  it('mantém feature detection como fonte de verdade para captura', () => {
    const getDisplayMedia = vi.fn();
    expect(canCaptureScreen({ mediaDevices: { getDisplayMedia } }, { VideoEncoder() {} })).toBe(
      true,
    );
    expect(canCaptureScreen({ mediaDevices: {} }, { VideoEncoder() {} })).toBe(false);
  });

  it('começa leve no celular e equilibrado no desktop', () => {
    expect(defaultBroadcastQuality(true)).toEqual({ bitrate: 1_500_000, fps: 30 });
    expect(defaultBroadcastQuality(false)).toEqual({ bitrate: 2_500_000, fps: 30 });
  });
});
