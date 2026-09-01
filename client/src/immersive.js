/**
 * Fullscreen progressivo para o visualizador.
 *
 * Dentro da Activity, o Discord pode negar a Fullscreen API ao iframe. Nesse
 * caso o layout imersivo em CSS continua ativo, enquanto o SDK ainda consegue
 * pedir a orientação horizontal nos clientes Android/iOS. Fora do Discord,
 * usamos as APIs nativas do navegador quando elas existem.
 */

const chamar = async (alvo, nome, ...args) => {
  const fn = alvo?.[nome];
  if (typeof fn !== 'function') return false;

  try {
    await fn.call(alvo, ...args);
    return true;
  } catch {
    return false;
  }
};

export function fullscreenElement(documentLike = document) {
  return documentLike?.fullscreenElement ?? documentLike?.webkitFullscreenElement ?? null;
}

async function orientarDiscord(sdk, estado) {
  const definir = sdk?.commands?.setOrientationLockState;
  if (typeof definir !== 'function') return false;

  try {
    await definir.call(sdk.commands, {
      lock_state: estado,
      picture_in_picture_lock_state: estado,
      grid_lock_state: estado,
    });
    return true;
  } catch {
    // Clientes antigos não conhecem o comando. O navegador e o CSS assumem.
    return false;
  }
}

export async function enterImmersive({
  element,
  documentLike = document,
  screenLike = screen,
  sdk = null,
  landscapeState = 3,
} = {}) {
  // Começa o comando do Discord sem esperar pela tentativa do navegador: no
  // iframe móvel essa é a rota principal e não deve ficar atrás de uma API que
  // o host pode demorar para negar.
  const discordOrientationPromise = orientarDiscord(sdk, landscapeState);
  let native = Boolean(fullscreenElement(documentLike));

  if (!native && element) {
    native =
      (await chamar(element, 'requestFullscreen', { navigationUI: 'hide' })) ||
      (await chamar(element, 'webkitRequestFullscreen'));
  }

  const discordOrientation = await discordOrientationPromise;
  let browserOrientation = false;

  // O lock dos navegadores costuma exigir fullscreen real. Não tentamos no
  // iframe negado para não produzir rejeições inúteis a cada toque.
  if (native && !discordOrientation) {
    browserOrientation = await chamar(screenLike?.orientation, 'lock', 'landscape');
  }

  return { native, orientation: discordOrientation || browserOrientation };
}

export async function leaveImmersive({
  documentLike = document,
  screenLike = screen,
  sdk = null,
  unlockedState = 1,
} = {}) {
  const discordOrientation = await orientarDiscord(sdk, unlockedState);

  // unlock() é síncrono em alguns navegadores e assíncrono em outros.
  await chamar(screenLike?.orientation, 'unlock');

  let native = false;
  if (fullscreenElement(documentLike)) {
    native =
      (await chamar(documentLike, 'exitFullscreen')) ||
      (await chamar(documentLike, 'webkitExitFullscreen'));
  }

  return { native, orientation: discordOrientation };
}
