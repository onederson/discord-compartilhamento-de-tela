import fs from 'node:fs';
import path from 'node:path';

import { createDiagnosticLogger, lerDiagnostico } from './diagnostics.mjs';
import { RAIZ } from './processos.mjs';

const logger = createDiagnosticLogger({ raiz: RAIZ });
const conteudo = lerDiagnostico(logger.arquivo, 1_000_000);

if (!conteudo.trim()) {
  console.log('Nenhum diagnóstico local foi registrado ainda.');
  process.exit(0);
}

const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
const pastaDeExportacao = path.join(RAIZ, '.logs', 'exports');
fs.mkdirSync(pastaDeExportacao, { recursive: true });
const destino = path.join(pastaDeExportacao, `diagnostico-${carimbo}.jsonl`);
fs.writeFileSync(destino, conteudo, { encoding: 'utf8', mode: 0o600 });
console.log(`Diagnóstico exportado para:\n${destino}`);
