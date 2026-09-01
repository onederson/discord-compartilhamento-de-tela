/**
 * Executa o build e, se ele falhar, permite uma única reparação das
 * dependências antes de tentar novamente.
 *
 * As operações entram por parâmetro para a política ser testável sem instalar
 * pacotes nem gerar arquivos. Cada operação devolve o resultado de spawnSync.
 */
export function executarBuildComReparo({ build, reparar }) {
  const primeira = build();
  if (primeira?.status === 0) {
    return { ok: true, reparado: false, tentativas: 1, detalhes: '' };
  }

  const conserto = reparar();
  if (conserto?.status !== 0) {
    return {
      ok: false,
      reparado: false,
      tentativas: 1,
      etapa: 'dependencias',
      detalhes: juntarSaidas(primeira, conserto),
    };
  }

  const segunda = build();
  if (segunda?.status === 0) {
    return { ok: true, reparado: true, tentativas: 2, detalhes: '' };
  }

  return {
    ok: false,
    reparado: true,
    tentativas: 2,
    etapa: 'build',
    detalhes: juntarSaidas(primeira, segunda),
  };
}

function juntarSaidas(...resultados) {
  return resultados
    .flatMap((resultado) => [resultado?.error?.message, resultado?.stdout, resultado?.stderr])
    .map((parte) => String(parte ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}
