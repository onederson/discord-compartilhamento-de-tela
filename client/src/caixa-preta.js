/**
 * Caixa-preta da atividade.
 *
 * Quando o Discord derruba o iframe ("Recarregar atividade"), o processo morre
 * sem rodar mais nada: nenhum erro chega ao servidor, e o que aconteceu antes
 * se perde. Aqui cada evento importante vai para uma trilha curta gravada no
 * localStorage a cada passo. Ela sobrevive à morte do iframe, e a próxima
 * abertura da atividade a encontra:
 *
 * - sessão anterior com `fim` marcado: o iframe foi descarregado normalmente
 *   (pagehide), e a trilha já foi enviada por beacon naquela hora;
 * - sessão anterior sem `fim`: o processo morreu sem aviso (crash, falta de
 *   memória, GPU) — é o caso que interessa, e a trilha é enviada agora.
 *
 * A trilha guarda só texto técnico curto: nada de nomes, tokens ou links.
 */

const CHAVE = 'caixa-preta';
const LIMITE = 50;

export function createCaixaPreta({ storage, agora = () => Date.now(), limite = LIMITE } = {}) {
  let sessao = null;

  function salvar() {
    try {
      storage?.setItem(CHAVE, JSON.stringify(sessao));
    } catch {
      /* armazenamento cheio ou bloqueado: a trilha fica só em memória */
    }
  }

  function lerAnterior() {
    try {
      const bruto = storage?.getItem(CHAVE);
      const anterior = bruto ? JSON.parse(bruto) : null;
      return anterior && Array.isArray(anterior.trilha) ? anterior : null;
    } catch {
      return null;
    }
  }

  /**
   * Abre a sessão desta carga do iframe e devolve a anterior, se houver.
   * @returns {{anterior: object|null, morreuSemAviso: boolean}}
   */
  function iniciar(contexto = {}) {
    const anterior = lerAnterior();
    sessao = {
      id: Math.random().toString(36).slice(2, 10),
      inicio: agora(),
      fim: null,
      contexto,
      trilha: [],
    };
    salvar();
    return { anterior, morreuSemAviso: Boolean(anterior && !anterior.fim) };
  }

  /** Acrescenta um evento: `+12.3s ws.close code=1006`. */
  function registrar(evento, dados = null) {
    if (!sessao) return;
    const segundos = ((agora() - sessao.inicio) / 1000).toFixed(1);
    const extra = dados
      ? ' ' +
        Object.entries(dados)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
          .join(' ')
      : '';
    sessao.trilha.push(`+${segundos}s ${evento}${extra}`);
    sessao.ultimo = agora();
    if (sessao.trilha.length > limite) sessao.trilha.splice(0, sessao.trilha.length - limite);
    salvar();
  }

  /** Marca saída limpa. Quem chama decide enviar a trilha (beacon). */
  function encerrar(motivo) {
    if (!sessao) return null;
    registrar('fim', { motivo });
    sessao.fim = agora();
    salvar();
    return resumo(sessao);
  }

  function resumo(s = sessao) {
    if (!s) return null;
    return {
      sessao: s.id,
      // Sessão que morreu sem aviso não tem fim: vale o último sinal de vida.
      duracaoS: Math.round(((s.fim ?? s.ultimo ?? s.inicio) - s.inicio) / 1000),
      haQuantoS: Math.round((agora() - (s.fim ?? s.ultimo ?? s.inicio)) / 1000),
      contexto: s.contexto,
      trilha: [...s.trilha],
    };
  }

  return { iniciar, registrar, encerrar, resumo, lerAnterior };
}
