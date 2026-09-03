# Discord Compartilhamento de Tela

Compartilhe tela, janela, guia, câmera e áudio com quem está na mesma call do Discord, direto de uma **Activity** — sem instalar nada no computador de quem transmite ou assiste.

Uma pessoa compartilha, todo mundo assiste sem sair do Discord. Também funciona como site normal, fora do Discord, com salas criadas e compartilhadas por link.

> Evolução independente do [Sala de Tela de DevilNine](https://github.com/DevilNine/discord-screenshare), por sua vez inspirado no [projeto original de Jc007zZ](https://github.com/Jc007zZ/discord-screen). Modificações desta versão por **Onederson**.

---

## Sumário

1. [Visão geral](#visão-geral)
2. [Arquitetura](#arquitetura)
3. [Pré-requisitos](#pré-requisitos)
4. [Instalação e execução](#instalação-e-execução)
5. [Configuração única no Discord](#configuração-única-no-discord)
6. [Como transmitir](#como-transmitir)
7. [Jogos OpenGL e Vulkan (Zomboid, RPCS3, emuladores)](#jogos-opengl-e-vulkan-zomboid-rpcs3-emuladores)
8. [Resolução de problemas](#resolução-de-problemas)
9. [Desenvolvimento](#desenvolvimento)
10. [Privacidade e limites](#privacidade-e-limites)

---

## Visão geral

| O que faz | Como |
| --- | --- |
| Transmite tela, janela, guia ou câmera | Captura pelo navegador, codificação **WebCodecs** (H.264 por hardware quando disponível, VP9 como reserva) |
| Baixa latência (~40 ms) | Quadros vão por **WebSocket** direto ao servidor, que repassa aos espectadores — sem WebRTC, sem SFU |
| Áudio junto com a imagem | Áudio da guia/janela/sistema no Chromium; no Firefox do PC anfitrião, captura WASAPI isolada por processo |
| Vários transmissores por sala | Cada participante recebe um canal; quem assiste escolhe o que ver |
| Qualidade adaptativa | Perfis de 30/60 fps até 1080p; reduz sob congestionamento e recupera quando a rede estabiliza |
| Resiliente | Reconexão automática do transmissor e do espectador; keyframe sob demanda para quem entra depois |
| Salas protegidas | Senha com `scrypt`, tokens com escopo, painel administrativo opcional |
| Portátil | `INICIAR.bat` / `INICIAR.sh` / `INICIAR.command` baixam Node.js e `cloudflared` dentro da pasta; nada é instalado no sistema |

---

## Arquitetura

```
┌───────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────┐
│  Quem transmite           │        │  Servidor (Node.js)      │        │  Quem assiste            │
│  navegador Chromium/FF    │        │  server/index.js         │        │  Activity no Discord     │
│                           │  WS    │                          │  WS    │  ou site fora dele       │
│  getDisplayMedia          │ ─────▶ │  rooms.js: salas, slots, │ ─────▶ │  client/src/player.js    │
│  → VideoEncoder (H264)    │ quadros│  tokens, relay de pacotes│ quadros│  VideoDecoder → <canvas> │
│  → AudioEncoder (Opus)    │        │  admin.js: painel        │        │  AudioDecoder → WebAudio │
│  shared/broadcaster.js    │        │  native-audio.js: WASAPI │        │  recovery.js: retomada   │
└───────────────────────────┘        └──────────────────────────┘        └──────────────────────────┘
                                               ▲
                                               │ HTTPS público via cloudflared (Quick ou Named Tunnel)
                                               │ ou o seu domínio (docs/vps.md)
```

| Pasta | Conteúdo |
| --- | --- |
| `client/` | A Activity (Vite): lobby, palco, player, áudio, layout imersivo. Build em `client/dist`. |
| `server/` | Express + `ws`: OAuth do Discord, salas, relay, painel `/admin`, páginas estáticas (`public/share.html` é a página de captura). |
| `shared/` | `broadcaster.js` — o pipeline de captura e codificação usado pela página de captura. |
| `scripts/` | Bootstrap por sistema, assistente `configurar`, túnel, atualizador, diagnóstico e smoke tests. |
| `native/audio-loopback/` | Helper C++ (WASAPI) para áudio isolado do Firefox no Windows. |
| `docs/` | Guias por sistema e documentação técnica. |
| `infra/` | `Caddyfile` e unidade `systemd` para VPS. |

Detalhes de desempenho e decisões de projeto: [docs/como-funciona.md](docs/como-funciona.md).

---

## Pré-requisitos

**Para hospedar** (o PC ou servidor que fica ligado durante a call):

- Windows 10/11, Linux (glibc) ou macOS. O bootstrap baixa Node.js 22 e `cloudflared` dentro da pasta do projeto.
- Conexão com upload suficiente: cada espectador recebe uma cópia do fluxo (ex.: 4 espectadores em 2,5 Mb/s ≈ 10 Mb/s de upload).
- Uma aplicação registrada no [Discord Developer Portal](https://discord.com/developers/applications) (grátis, uma vez só).

**Para transmitir:** Chrome, Edge, Brave ou Opera atualizados. Firefox funciona em modo compatível (áudio isolado só no PC anfitrião Windows).

**Para assistir:** qualquer navegador moderno, inclusive dentro do Discord desktop e mobile.

---

## Instalação e execução

1. Baixe o ZIP (ou clone o repositório) e **extraia tudo** em Downloads ou Documentos. Não execute de dentro do ZIP nem em pastas protegidas como `Program Files`.
2. Inicie:

   | Sistema | Iniciar | Só diagnosticar |
   | --- | --- | --- |
   | Windows 10/11 | duplo clique em `INICIAR.bat` | `INICIAR.bat -Diagnostico` |
   | Linux | `sh INICIAR.sh` | `sh INICIAR.sh --diagnostico` |
   | macOS | duplo clique em `INICIAR.command` | `./INICIAR.command --diagnostico` |

3. Na primeira vez, o assistente pede o **Client ID** e o **Client Secret** da sua aplicação (seção abaixo). Ele baixa o runtime, valida o SHA-256, roda `npm ci`, compila o site e sobe servidor + túnel.
4. Mantenha a janela aberta. `Ctrl+C` encerra tudo. Nas próximas vezes ele reutiliza o que já baixou.

Uma cópia clonada verifica `origin/main` ao iniciar e só avança se o checkout estiver limpo. No ZIP, baixe a versão nova e preserve o seu `.env`.

Guias completos: [Windows](docs/windows.md) · [Linux](docs/linux.md) · [macOS](docs/macos.md) · [VPS/Docker](docs/vps.md)

### Endereço público

Sem configuração extra o projeto usa um **Quick Tunnel** (`trycloudflare.com`), cujo endereço muda quando o processo é recriado — bom para testar. Para um domínio fixo, rode uma vez:

```text
Windows: INICIAR.bat -TunelCriar
Linux:   sh INICIAR.sh --tunel-criar
macOS:   ./INICIAR.command --tunel-criar
```

---

## Configuração única no Discord

O Discord não permite que um programa preencha o Developer Portal por você. Faça uma vez:

1. Em [Discord Developer Portal](https://discord.com/developers/applications), crie uma aplicação.
2. Em **OAuth2**, copie o Client ID e o Client Secret para o assistente local (`npm run configurar` refaz isso quando quiser).
3. Em **Activities → Settings**, habilite Activities e Desktop; marque Android/iOS se quiser acesso móvel.
4. Em **Activities → URL Mappings**, crie o prefixo `/` e cole o domínio exibido no terminal, sem `https://`.
5. Em **OAuth2 → Redirects**, cole o endereço exibido que termina em `/auth/callback`.
6. Use o link de instalação mostrado no terminal. No Discord, entre num canal de voz, clique no **foguete** e escolha a atividade.

Se o botão **Add Redirect** abrir uma tela de erro `removeChild`, siga o [contorno documentado](docs/discord-portal.md). O Client Secret fica só no servidor; `.env` e `.cloudflared/` nunca devem ser publicados.

---

## Como transmitir

1. Na Activity, clique em **Compartilhar tela**. Na primeira vez escolha o perfil de qualidade (pode mudar depois na engrenagem).
2. Abre uma página de captura no seu navegador. Nela, **Escolher janela ou tela** abre o seletor do próprio navegador:
   - **Janela** → um aplicativo ou jogo;
   - **Tela inteira** → o monitor todo;
   - **Guia/Aba** → uma aba do navegador (é a opção que sempre oferece áudio no Chromium).
3. Marque **Compartilhar o áudio** quando o seletor oferecer. Se a imagem vier sem som, use **Escolher áudio separado** para pegar o som de uma aba ou janela.
4. Volte para o Discord — a transmissão continua enquanto a página de captura estiver aberta. **Trocar de tela ou janela** muda a origem sem derrubar quem assiste.

| Perfil | Quadros | Taxa | Quando usar |
| --- | ---: | ---: | --- |
| Leve | 30 fps | 1,5 Mb/s | upload fraco ou muitos espectadores |
| Equilibrado | 30 fps | 2,5 Mb/s | padrão: filmes, trabalho, maioria dos jogos |
| Nítido | 60 fps | 5 Mb/s | jogos rápidos, texto pequeno |
| Máximo | 60 fps | 8 Mb/s | upload forte e poucos espectadores |

A resolução vai até 1080p em todos os perfis; o encoder reduz sozinho se o computador ou a rede não acompanharem.

| Plataforma | Assistir | Transmitir tela/câmera | Áudio da tela |
| --- | :-: | :-: | --- |
| Chrome, Edge, Brave, Opera | Sim | Sim | guia / janela / sistema, conforme o navegador oferecer |
| Firefox e derivados no PC anfitrião (Windows) | Sim | Sim | isolado por processo via WASAPI |
| Firefox em outro PC | Sim | Sim | use um Chromium para áudio |
| Safari recente | Sim | depende da versão | limitado |
| Android / iOS | Sim | câmera | não |

---

## Jogos OpenGL e Vulkan (Zomboid, RPCS3, emuladores)

**Sintoma:** a transmissão funciona enquanto você está em outra janela, mas **congela para quem assiste no instante em que o jogo ganha foco**. Alt+Tab para fora e a imagem volta. Acontece em tela cheia e em janela, só com jogos OpenGL/Vulkan (Project Zomboid, RPCS3, Minecraft Java, Dolphin, Yuzu…). Jogos DirectX não são afetados.

**Causa:** em placas **NVIDIA**, o driver apresenta aplicativos OpenGL/Vulkan direto ao monitor por um caminho que a captura de tela do Windows não enxerga. Nenhuma configuração do navegador resolve.

**Correção (2 minutos, vale imediatamente):**

1. Botão direito na área de trabalho → **Painel de Controle NVIDIA** (ou NVIDIA App → Gráficos).
2. **Gerenciar configurações 3D** → **Configurações globais**.
3. **Método de apresentação Vulkan/OpenGL** (*Vulkan/OpenGL present method*): troque *Automático* por **Preferir em camadas no DXGI Swapchain**.
4. **Aplicar** e reabra o jogo. Para não mudar globalmente, faça o mesmo em *Configurações de programa* só para o jogo.

Em placas **AMD Radeon**: no AMD Software (Adrenalin Edition) → Jogos → Gráficos, desative o **Radeon Enhanced Sync** para o jogo em questão e execute o `CORRIGIR_TRANSMISSAO_JOGOS.bat` como administrador para desativar o MPO e as otimizações de jogos em janela do Windows 11.

Ferramentas incluídas para Windows:

- `CORRIGIR_TRANSMISSAO_JOGOS.bat` (como administrador) — detecta automaticamente se sua GPU é NVIDIA ou AMD, mostra as instruções de configuração e aplica ajustes de mitigação no registro do Windows (GameDVR, MPO e Windowed Optimizations; válidos após reiniciar o PC).
- `TRANSMITIR_SEM_TRAVAR.bat` — abre um navegador com perfil separado e flags que impedem o Chromium de suspender a aba coberta pelo jogo; permite alternar o motor de captura (WGC ou DXGI/GDI) para diagnóstico. Fallback, não é necessário após a correção NVIDIA/AMD.

No jogo, prefira **Janela sem bordas** (Zomboid: Opções → Exibição; RPCS3: Configuration → GPU → *Exclusive Fullscreen Mode: Disabled*).

---

## Resolução de problemas

| Problema | O que fazer |
| --- | --- |
| **Activity em branco** | Confira o Target/URL Mapping atual no portal e reabra a Activity para descartar o bundle antigo. |
| **Quem assiste fica "carregando"** | O espectador pede configuração e keyframe até o primeiro quadro chegar. Se persistir, teste o perfil Leve e desligue VPN. Se for jogo OpenGL/Vulkan, veja a seção acima. |
| **Imagem congela ao clicar no jogo** | Seção [Jogos OpenGL e Vulkan](#jogos-opengl-e-vulkan-zomboid-rpcs3-emuladores). |
| **Sem áudio** | No Chromium, marque **Compartilhar o áudio** no seletor ou use **Escolher áudio separado**. No Firefox do PC anfitrião, aguarde "Áudio isolado do Firefox ligado". |
| **"A captura travou"** na página | O navegador parou de receber quadros da origem. Quase sempre é o caso NVIDIA acima; caso contrário, escolha a tela de novo. |
| **Porta 3001 ocupada** | Feche outra instância deste projeto; não finalize processos desconhecidos. |
| **Endereço mudou / Activity parou de abrir** | Quick Tunnel recriado gera outro domínio: atualize URL Mapping e Redirect no portal, ou crie um Named Tunnel. |
| **"O site não compilou"** | O launcher reinstala dependências e tenta de novo; se falhar, copie o erro real da janela. |
| **macOS bloqueou o `.command`** | Botão direito → **Abrir**; veja o [guia macOS](docs/macos.md). |
| **Portal cai ao clicar em Redirecionamento** | Janela anônima, sem tradução/extensões; veja [docs/discord-portal.md](docs/discord-portal.md). |

Diagnóstico técnico local (sanitizado, nunca enviado por padrão) fica em `.logs/`; exporte com `npm run diagnostico:exportar`. Detalhes em [docs/diagnostico.md](docs/diagnostico.md).

---

## Desenvolvimento

Requer Node.js 22 (o mesmo do CI) ou 24.

```bash
npm ci                 # dependências (raiz, client e server são workspaces)
npm run dev            # servidor + client em modo desenvolvimento
npm run build          # compila client/dist (versionado: o servidor serve daqui)
npm test               # vitest: 400 testes de client, server, shared e scripts
npm run lint           # eslint
npm run format:check   # prettier
npm run smoke          # sobe o servidor e valida as rotas principais
```

Convenções: código e comentários em português; commits no estilo `tipo(escopo): resumo`. O CI (`.github/workflows/ci.yml`) roda lint, prettier, build, testes, smoke e o build Docker.

O helper de áudio nativo é compilado com `native/audio-loopback/build.ps1` (Visual Studio Build Tools); o binário pronto acompanha o repositório.

---

## Privacidade e limites

- Nenhuma mídia é gravada em disco; o relay repassa pacotes codificados só aos espectadores autorizados da sala.
- O Client Secret fica no servidor. O `.gitignore` exclui `.env`; nunca publique tokens ou a pasta `.cloudflared`.
- O helper WASAPI exige uma prova local em `127.0.0.1`: um participante remoto não consegue acionar o áudio do anfitrião.
- Quick Tunnel não é hospedagem de produção; o relay atual não substitui uma SFU para grandes públicos.
- Navegadores exigem gesto do usuário e nova escolha em cada captura — nenhuma página consegue escolher uma janela sozinha.
- Captura de tela no celular exige app nativo (MediaProjection / APIs iOS); veja [docs/mobile.md](docs/mobile.md).

Avisos de licenças de terceiros: [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
