import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const macos = process.platform === 'darwin' ? it : it.skip;

describe('bootstrap portátil do macOS', () => {
  macos('executa o diagnóstico a partir de um caminho com espaços sem instalar nada', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sala de tela '));
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts);
    fs.copyFileSync(
      path.join(import.meta.dirname, 'macos-bootstrap.sh'),
      path.join(scripts, 'macos-bootstrap.sh'),
    );
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

    try {
      const output = execFileSync(
        'sh',
        [path.join(scripts, 'macos-bootstrap.sh'), '--diagnostico'],
        { cwd: os.tmpdir(), encoding: 'utf8' },
      );
      expect(output).toContain('Diagnóstico concluído');
      expect(output).toContain(root);
      expect(fs.existsSync(path.join(root, '.runtime'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  macos('recusa opções desconhecidas sem iniciar ou instalar', () => {
    const result = spawnSync('sh', [path.join(import.meta.dirname, 'macos-bootstrap.sh'), '--x'], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Opção desconhecida');
  });

  it('mantém os pacotes oficiais separados para Intel e Apple Silicon', () => {
    const script = fs.readFileSync(path.join(import.meta.dirname, 'macos-bootstrap.sh'), 'utf8');
    expect(script).toContain('x86_64|amd64) NODE_ARCH=x64');
    expect(script).toContain('arm64|aarch64) NODE_ARCH=arm64');
    expect(script).toContain('darwin-$NODE_ARCH.tar.gz');
    expect(script).toContain('shasum -a 256');
  });
});
