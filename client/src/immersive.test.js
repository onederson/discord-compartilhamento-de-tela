/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { enterImmersive, fullscreenElement, leaveImmersive } from './immersive.js';

describe('visualizacao imersiva', () => {
  it('mantem o fallback CSS e ainda orienta o Discord quando fullscreen e negado', async () => {
    const element = { requestFullscreen: vi.fn().mockRejectedValue(new TypeError('negado')) };
    const setOrientationLockState = vi.fn().mockResolvedValue({});
    const sdk = { commands: { setOrientationLockState } };

    const result = await enterImmersive({ element, documentLike: {}, sdk, landscapeState: 3 });

    expect(result).toEqual({ native: false, orientation: true });
    expect(setOrientationLockState).toHaveBeenCalledWith({
      lock_state: 3,
      picture_in_picture_lock_state: 3,
      grid_lock_state: 3,
    });
  });

  it('usa fullscreen e orientacao nativos fora da Activity', async () => {
    const element = { requestFullscreen: vi.fn().mockResolvedValue(undefined) };
    const orientation = { lock: vi.fn().mockResolvedValue(undefined) };

    const result = await enterImmersive({ element, documentLike: {}, screenLike: { orientation } });

    expect(element.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(orientation.lock).toHaveBeenCalledWith('landscape');
    expect(result).toEqual({ native: true, orientation: true });
  });

  it('sai do fullscreen e libera as duas orientacoes', async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const unlock = vi.fn();
    const setOrientationLockState = vi.fn().mockResolvedValue({});

    const result = await leaveImmersive({
      documentLike: { fullscreenElement: {}, exitFullscreen },
      screenLike: { orientation: { unlock } },
      sdk: { commands: { setOrientationLockState } },
      unlockedState: 1,
    });

    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledOnce();
    expect(setOrientationLockState).toHaveBeenCalledWith({
      lock_state: 1,
      picture_in_picture_lock_state: 1,
      grid_lock_state: 1,
    });
    expect(result).toEqual({ native: true, orientation: true });
  });

  it('reconhece o prefixo WebKit usado por navegadores moveis antigos', () => {
    const ativo = {};
    expect(fullscreenElement({ webkitFullscreenElement: ativo })).toBe(ativo);
  });
});
