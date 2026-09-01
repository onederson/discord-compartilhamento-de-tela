import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32' ? it : it.skip;

describe('bootstrap portatil do Windows', () => {
  windows('executa o diagnostico a partir de um caminho com espacos', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sala de tela '));
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts);
    fs.copyFileSync(
      path.join(import.meta.dirname, 'windows-bootstrap.ps1'),
      path.join(scripts, 'windows-bootstrap.ps1'),
    );
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(scripts, 'windows-bootstrap.ps1'),
          '-Diagnostico',
        ],
        { encoding: 'utf8' },
      );
      expect(output).toContain('Diagnostico concluido');
      expect(output).toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('oferece o mesmo atalho de tunel nomeado dos launchers Unix', () => {
    const script = fs.readFileSync(path.join(import.meta.dirname, 'windows-bootstrap.ps1'), 'utf8');
    expect(script).toContain('[switch]$TunelCriar');
    expect(script).toContain("& $NpmCmd run 'tunel:criar'");
  });
});
