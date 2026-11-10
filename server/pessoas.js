import fs from 'node:fs';
import path from 'node:path';

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Registro de pessoas para o painel administrativo.
 *
 * Liga o pseudônimo estável (usado nos diagnósticos) ao ID do Discord e ao
 * nome da pessoa, permitindo ao operador saber quem é quem sem expor esses
 * dados nos logs públicos.
 */
export function criarRegistroPessoas({
  arquivo,
  agora = () => Date.now(),
  diasRetencao = 30,
  pseudonimo = (uid) => String(uid),
} = {}) {
  const registros = new Map();
  let timerDebounce = null;

  function expirar() {
    const limite = agora() - diasRetencao * DIA_MS;
    for (const [chave, item] of registros.entries()) {
      const t = new Date(item.ultimaVez).getTime();
      if (Number.isNaN(t) || t < limite) {
        registros.delete(chave);
      }
    }
  }

  function carregar() {
    if (!arquivo) return;
    try {
      if (!fs.existsSync(arquivo)) return;
      const conteudo = fs.readFileSync(arquivo, 'utf8');
      const dados = JSON.parse(conteudo);
      if (dados && Array.isArray(dados.pessoas)) {
        for (const item of dados.pessoas) {
          if (!item || typeof item !== 'object') continue;
          const p = item.pessoa || (item.uid ? pseudonimo(item.uid) : null);
          if (!p || !item.uid) continue;
          registros.set(p, {
            pessoa: p,
            uid: String(item.uid),
            nome: String(item.nome ?? ''),
            convidado: Boolean(item.convidado ?? String(item.uid).startsWith('guest-')),
            primeiraVez: String(
              item.primeiraVez || item.ultimaVez || new Date(agora()).toISOString(),
            ),
            ultimaVez: String(item.ultimaVez || new Date(agora()).toISOString()),
            vezes: Number(item.vezes) || 1,
          });
        }
      }
      expirar();
    } catch {
      // Arquivo ausente ou inválido: começa vazio sem lançar.
    }
  }

  function gravar() {
    if (!arquivo) return;
    try {
      expirar();
      const pasta = path.dirname(arquivo);
      fs.mkdirSync(pasta, { recursive: true });
      const temporario = `${arquivo}.tmp`;
      const payload = {
        pessoas: Array.from(registros.values()),
      };
      fs.writeFileSync(temporario, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(temporario, arquivo);
    } catch (err) {
      console.error('[pessoas] erro ao gravar registro de pessoas:', err);
    }
  }

  function registrar(uid, nome) {
    if (uid == null) return;
    const uidStr = String(uid).trim();
    if (!uidStr) return;

    const nomeTratado = String(nome ?? '')
      .trim()
      .slice(0, 64);
    const p = pseudonimo(uidStr);
    if (!p) return;

    const agoraIso = new Date(agora()).toISOString();
    const existente = registros.get(p);

    if (existente) {
      if (nomeTratado) {
        existente.nome = nomeTratado;
      }
      existente.ultimaVez = agoraIso;
      existente.vezes = (existente.vezes || 0) + 1;
    } else {
      registros.set(p, {
        pessoa: p,
        uid: uidStr,
        nome: nomeTratado,
        convidado: uidStr.startsWith('guest-'),
        primeiraVez: agoraIso,
        ultimaVez: agoraIso,
        vezes: 1,
      });
    }

    if (!timerDebounce) {
      timerDebounce = setTimeout(() => {
        timerDebounce = null;
        gravar();
      }, 10_000);
      timerDebounce?.unref?.();
    }
  }

  function listar() {
    expirar();
    return Array.from(registros.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => new Date(b.ultimaVez).getTime() - new Date(a.ultimaVez).getTime());
  }

  function gravarAgora() {
    if (timerDebounce) {
      clearTimeout(timerDebounce);
      timerDebounce = null;
    }
    gravar();
  }

  carregar();

  return {
    registrar,
    listar,
    gravarAgora,
  };
}
