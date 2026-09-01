import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('contrato visual do fullscreen', () => {
  it('faz o palco cheio ocupar a celula sem herdar a proporcao do tile', () => {
    expect(css).toMatch(
      /\.grid\.palco\.cheia \.tile-palco\s*{[^}]*place-self:\s*stretch;[^}]*height:\s*100%;[^}]*aspect-ratio:\s*auto !important;/s,
    );
  });

  it('prende o fallback imersivo ao viewport dinamico do celular', () => {
    expect(css).toMatch(
      /#app\.cheia,[\s\S]*?#app:-webkit-full-screen\s*{[^}]*position:\s*fixed;[^}]*width:\s*100dvw;[^}]*height:\s*100dvh;/s,
    );
  });

  it('expoe o botao de tela cheia como controle de alternancia', () => {
    expect(html).toMatch(/id="fullscreen"[\s\S]*?aria-pressed="false"/);
  });
});
