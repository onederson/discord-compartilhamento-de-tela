# Relatório do Hardening Beta 2.0

## Contexto e Objetivo

Este projeto é uma cópia do Discord screenshare original, criada especificamente para evitar danos à versão validada. O objetivo foi:

- Melhorar código, confiabilidade, features, UX, visual, segurança e manutenibilidade
- **Preservar todo comportamento que já funciona bem** — não importar alterações do upstream Git
- Evitar o erro anterior: aplicar mudanças do repositório original que não faziam sentido nesta versão customizada

O usuário enfatizou:
> "meu projeto hoje tem um dos melhores resultados entregues, mas sei que tem espaço pra melhoria tanto em código, quanto em features quanto em visual"
> "elevando esse projeto a perfeição [...] mas se atenha a não quebrar o que ja funciona"

## Arquitetura do Projeto

### Pipeline de transmissão

1. **Captura no navegador**: `getDisplayMedia()` ou `getUserMedia()`
2. **Codificação com WebCodecs**: H.264 preferencial, VP8/VP9 fallback
3. **Transmissão via WebSocket binário**: relay Node.js
4. **Decodificação no viewer**: `VideoDecoder` + canvas
5. **Áudio**: `AudioEncoder`/`AudioDecoder` + Web Audio, ou helper nativo WASAPI/Opus no Windows Firefox

### Módulos principais

- `shared/broadcaster.js`: pipeline compartilhado de captura → encode → transmit
- `client/src/main.js`: UI da Activity, ciclo de vida da sala, estado do viewer, reconexão, controles
- `client/src/player.js`: player de vídeo com decoder/canvas
- `client/src/audio.js`: decodificação Opus e agendamento de áudio
- `client/src/recovery.js`: decisões de recuperação do viewer
- `server/index.js`: API HTTP, autenticação, roteamento WebSocket, relay, áudio nativo
- `server/rooms.js`: salas em memória, broadcasters, slots, opt-in watching, keyframes, backpressure
- `server/tokens.js`: tokens assinados com HMAC-SHA256
- `server/public/share.js`: UI standalone da página de captura e conexão de controle
- `server/public/share.html` / `share.css`: markup e sistema visual estilo Apple
- `scripts/diagnostics.mjs`: diagnóstico local e sanitização
- `scripts/updater.mjs`: atualizador conservador do upstream

### Protocolo de pacotes

Formato binário: `[1 byte slot][1 byte tipo][8 byte timestamp][8 byte send time][payload]`

Tipos:
- video keyframe
- video delta
- audio packet

Comportamento do viewer:
- assistir é opt-in
- precisa de keyframe antes de deltas
- servidor rastreia viewers primed
- keyframes são solicitados em novos viewers, erros de decoder, reconexões e stalls
- backpressure descarta frames para viewers lentos

## Metodologia de Validação

Para proteger o que já funciona, foi validado pelas interfaces existentes:
- Ações nas páginas
- Rotas HTTP
- Mensagens WebSocket
- Funções públicas de autenticação/diagnóstico

Isso cobre transmissão, troca de tela, reconexão, privacidade e acessibilidade sem migrar tecnologias.

## Linha de Base Inicial

**Node**: v24.15.0  
**Engine**: >=22 <25

**Resultado inicial**:
- 26 arquivos de teste passaram
- 428 testes passaram
- 4 testes ignorados (específicos de outros sistemas)
- Lint: passou
- Prettier check: passou
- Build client de produção: passou

Build: Vite succeeded, 79 modules transformados, `client/dist/assets/index-Kt79S873.js` gerado.

## Planejamento Executado

### Fase 1: Auditoria e linha de base
✅ Confirmado repositório correto (cópia)
✅ Confirmado working tree limpo inicialmente
✅ Identificado histórico validado com UX (status dinâmico, handover de tela, foco)
✅ Executada suíte completa como referência

### Fase 2: Hardening de autenticação
✅ Adicionados testes para estruturas de token malformadas
✅ Corrigida comparação timing-safe para multibyte
✅ Preservado formato e APIs de token existentes

### Fase 3: Confiabilidade de reconexão
✅ Reproduzido e corrigido perda de estado de assistir
✅ Adicionados checks de identidade de stream para evitar violações de privacidade
✅ Protegido estado da sala contra eventos de socket antigo

### Fase 4: Robustez de WebSocket
✅ Hardened parsing em cliente e servidor
✅ Adicionado timeout de handshake
✅ Preservados sockets através de mensagens malformadas

### Fase 5: Privacidade de diagnóstico
✅ Melhorada sanitização para URLs, fragments, JSON, erros serializados, dados circulares
✅ Adicionados testes para limites e valores sensíveis

### Fase 6: Segurança do atualizador
✅ Preservado comportamento conservador
✅ Adicionada cobertura para evitar sobrescrever checkouts customizados

### Fase 7: Acessibilidade e interface
✅ Adicionado trapping de foco em modais
✅ Adicionada navegação por teclado em radios
✅ Preservado foco visível e reduced-motion

### Fase 8: Página de captura
✅ Adicionada distinção connection/live
✅ Adicionado resumo de qualidade e indicadores de status
✅ Adicionados controles de tema acessíveis por teclado
✅ Estabilizadas atualizações DOM da lista de watchers

## Mudanças por Arquivo

### `server/tokens.js`

**Objetivo**: Fortalecer validação de tokens

**Mudanças**:
- Rejeita assinaturas multibyte que anteriormente bypassavam o check de comprimento string
- Rejeita tokens com partes extras separadas por ponto
- Rejeita payloads que decodificam para `null`, arrays, strings, números ou valores inválidos
- Rejeita valores `exp` inválidos
- Trata expiração no timestamp exato atual como expirado

**Testes adicionados**: `server/tokens.test.js` (26 testes)

### `client/src/main.js`

**Objetivo**: Proteger reconexão, foco, acessibilidade e estado da sala

**Mudanças**:
- Guards de reconexão/geração de sessão para evitar que eventos de WebSocket antigo mutem sala atual
- Cancelamento de timers de reconexão pendentes ao sair ou mudar de sala
- Cleanup de timeout de handshake para sockets que nunca atingem `open`
- Parsing seguro e ignorando mensagens WebSocket malformadas
- Preservação de intenção do viewer através de reconexões apenas quando identidade de stream permanece
- Sem re-watch automático quando slot é reusado por outro usuário ou fonte
- Detalhes de status para estado de conexão
- Modal de detalhes técnicos de conexão
- Ação de diagnóstico copy contendo apenas métricas técnicas seguras
- Recuperação de viewer sem reiniciar broadcaster
- Gerenciamento de foco em modais
- Restauração de foco para o botão que abriu o modal
- Navegação de teclado em quality radio usando arrow keys e roving `tabIndex`
- Tratamento de Escape
- Logging local mais seguro com throttling e sanitização
- Comportamento atualizado de room-leave/beacon

**Arquivo agora substancialmente mais longo** — foco em seção de conexão, helpers de modal, controles de qualidade e listeners de teclado/lifecycle no final do arquivo.

### `client/src/recovery.js`

**Objetivo**: Expandir helpers de recuperação para preservar identidade de stream

**Mudanças**:
- Streams recuperáveis preservam identidade de stream
- Não reusam automaticamente slot que agora pertence a outro usuário/fonte

### `client/src/style.css`

**Objetivo**: Estilos para novos estados de conexão/status

**Mudanças**:
- Estados visuais de conexão/status
- Styling de painel/modal de detalhes
- Controles de diagnóstico
- Styling de foco acessível
- Cores de estado de UI
- Layout para novos controles de status/conexão
- Preservado layout responsivo e reduced-motion

### `client/index.html`

**Objetivo**: Markup para novos controles

**Mudanças**:
- Status de conexão
- Detalhes de conexão
- Métricas técnicas
- Ações de diagnóstico/copy
- Alvos de foco em modais e labels

### `scripts/diagnostics.mjs`

**Objetivo**: Melhorar privacidade e robustez

**Mudanças**:
- Sanitiza fragments de URL, incluindo `identity`
- Sanitiza valores de query com credenciais
- Sanitiza JSON embutido e erros serializados
- Trata referências circulares
- Limita profundidade, chaves de objeto, entradas de array e tamanhos de texto
- Preserva comportamento de opt-in de diagnóstico local
- Mantém comportamento de upload HTTPS-only com exceções localhost

**Testes adicionados**: `scripts/diagnostics.test.js`

### `scripts/updater.mjs`

**Objetivo**: Hardened updater behavior

**Mudanças**:
- Recusa remotes não-oficiais
- Recusa checkouts modificados
- Recusa checkouts divergentes
- Aplica apenas updates fast-forward de `origin/main` oficial
- Preserva branches e arquivos customizados locais

**Testes adicionados**: `scripts/updater.test.js`

### `server/index.js`

**Objetivo**: Robustez no parsing de WebSocket

**Mudanças**:
- JSON malformado é ignorado em vez de causar `msg.type` em `null` ou throw
- Payloads JSON null/não-objeto são descartados com segurança
- Comportamento de validação de source/slot existente permanece intacto

### `server/index-ws.test.js`

**Objetivo**: Cobertura de casos edge de WebSocket

**Testes adicionados**:
- JSON malformado
- JSON null/não-objeto
- Mensagens binárias/controle inválidas
- Valores de slot inválidos
- Preservação de sockets vivos após input malformado

**Resultado**: 34 testes passaram

### `server/public/share.html`

**Objetivo**: Markup da página de captura com status e qualidade

**Mudanças**:
- `quality-summary`
- `control-status`
- Status de conexão/live
- Informações de qualidade
- Controles de tema acessíveis
- Descrições de status
- Query strings de cache-busting em assets atualizadas
- Script inline de tema agora suporta navegação por teclado e mantém estado ativo

### `server/public/share.js`

**Objetivo**: Lógica da página de captura

**Mudanças**:
- Rendering de quality summary
- Updates de qualidade a partir de mensagens de controle da Activity
- Distinção entre conectividade do WebSocket de controle e mídia ao vivo
- Texto de status de conexão
- Status de reconexão
- Comportamento de acessibilidade de tema/controle
- Updates estáveis da lista de watchers sem substituição DOM desnecessária
- Comportamento do pill de status da página de captura

### `server/public/share.css`

**Objetivo**: Estilos da página de captura

**Mudanças**:
- Resumo de qualidade
- Status de conexão de controle
- Distinção live/offline
- Banners de status
- Estados de foco
- Controles de tema
- Layout responsivo
- Variáveis dark/light existentes preservadas
- Adicionado `color-scheme` para contraste nativo do sistema

### Novos arquivos de teste

- `client/src/main.test.js`: 19 testes de integração jsdom para UI principal
- `server/public/share.test.js`: 4 testes de integração jsdom para página de captura

## Problemas Encontrados e Corrigidos

### 1. Falha na comparação timing-safe de token

**Problema**: Multibyte signature tinha mesmo comprimento de caractere mas diferente comprimento de byte, causando `RangeError: Input buffers must have the same byte length`

**Correção**: Comparar comprimentos de byte-buffer antes de `timingSafeEqual()`

### 2. Falhas na validação de estrutura de token

**Problemas**:
- Partes extras aceitas porque destructuring ignorava partes posteriores
- Payloads `null` causavam erro de acesso `payload.exp`
- Payloads primitivos aceitos
- Valores `exp` inválidos aceitos
- Expiração no timestamp exato não rejeitada

**Correções**:
- Requerer exatamente duas partes
- Requerer payload decodificado como objeto plain não-null
- Validar `exp` como timestamp numérico positivo finito
- Rejeitar `exp <= current time`

### 3. Reconexão de viewer perdeu estado de watch

**Problema**: `stream-start` sempre fazia `watching.delete(msg.slot)`, apagando estado de assistir após reconexão

**Correção**: Rastrear identidade de stream e preservar watching apenas quando stream reanunciado corresponde ao usuário/fonte assistido anteriormente

### 4. Reuso de slot violava privacidade

**Problema**: Se slot 0 reusado por outro usuário ou mudou de screen para camera, cliente enviava `watch` automaticamente

**Correção**: Preservar intenção de watch por identidade de stream, não número de slot sozinho

### 5. WebSocket antigo afetava sala atual

**Problema**: Eventos atrasados de `close`, `error`, `message` de sala anterior afetavam sala ativa

**Correções**:
- Introduzir checks de identidade de conexão/sessão
- Ignorar callbacks a menos que evento pertença ao WebSocket/sessão atual
- Cancelar timers de reconexão pendentes ao sair ou substituir sala
- Preservar URL da sala e estado durante falhas de conexão transitórias

### 6. Timeout de handshake não fechava socket stalled

**Problema**: Socket que nunca disparava `open` permanecia connecting após timeout

**Correção**: Adicionar timeout de handshake que fecha socket se permanecer connecting muito tempo, com cleanup em `open`/`close`

### 7. Mensagens WebSocket malformadas crashavam página

**Problema**: Strings como `{`, `null`, arrays e dados binários causavam exceções de parsing ou acesso de propriedade

**Correção**: Parse apenas texto, wrapping JSON parsing em `try/catch`, ignorar mensagens não-objeto

### 8. Mensagens WebSocket malformadas crashavam servidor

**Problema**: Servidor parseava JSON para `null`, então acessava `msg.type`, causando `TypeError: Cannot read properties of null (reading 'type')`

**Correção**: Após parsing, requerer objeto não-null antes de ler `msg.type`

### 9. Diagnostics vazavam credenciais e falhavam em estruturas circulares

**Problemas**:
- Fragments de URL como `#identity=...` não sanitizados
- Campos de credencial JSON embutidos permaneciam visíveis
- Texto arbitrário `token=...` não sanitizado
- Objetos circulares causavam `RangeError: Maximum call stack size exceeded`

**Correções**:
- Expandido matching de chaves de query sensíveis
- Sanitizar campos de credencial serializados
- Adicionar limites recursivos de profundidade e tamanho
- Rastrear objetos/referências vistas
- Substituir referências circulares com marcador seguro
- Retener truncamento de texto e redaction baseada em chaves

### 10. Testes de acessibilidade da UI inicialmente falharam

**Problemas**:
- Foco modal não wrapava de último para primeiro
- Foco não restaurado para opener
- Navegação arrow de quality não atualizava seleção ativa ou `tabIndex`

**Correções**:
- Helper de focus-trap em modal
- Tracking de opener
- Restauração de foco ao fechar
- Roving `tabIndex` em quality radio
- Navegação ArrowLeft/ArrowRight/ArrowUp/ArrowDown
- Seleção Enter/Space
- Closure com Escape

## Estado Atual dos Testes

### Resultado mais recente

```
✓ server/public/share.test.js (4 tests)
✓ client/src/main.test.js (19 tests)

Test Files  2 passed
Tests       23 passed
```

Último teste confirmou: "mantém o foco no modal e devolve ao botão que o abriu"

### Linha de base completa

Antes das mudanças:
- 26 arquivos de teste
- 428 testes passaram
- 4 testes ignorados

Após as mudanças (últimas execuções):
- 464 testes passaram (execuções estáveis)
- Worker encerramento inesperado ocorreu uma vez intermitentemente, não reproduzido

## Onde Exatamente Parou

### ✅ Completado
- Auditoria da cópia e arquitetura
- Linha de base inicial (428 testes)
- Hardening de autenticação
- Hardening de reconexão e proteção de estado
- Robustez de WebSocket (cliente e servidor)
- Privacidade de diagnóstico
- Segurança do atualizador
- Acessibilidade (modal, teclado, foco)
- Página de captura (status, qualidade, tema)
- Testes de regressão para todas as correções

### ⏳ Pendente
1. Executar suíte completa após mudanças da página de captura
2. Executar:
   - `npm run lint`
   - `npm run format:check`
   - `npm run build`
   - `npm run smoke`
   - `npm run smoke:controle`
   - `npm run smoke:audio` (onde suportado)
3. Inspecionar saída de testes para regressões fora das suítes alvo
4. Revisar `git diff --stat` e diff completo para mudanças acidentais
5. Verificar arquivos gerados e query strings de cache-busting
6. Verificar que nenhum dado sensível foi adicionado a arquivos rastreados
7. Verificar status da branch
8. Criar branch local: `release/2.0-beta`
9. **Não fazer push**
10. Reportar:
    - arquivos alterados exatos
    - testes e comandos passados
    - testes ignorados
    - testes que ainda requerem máquina servidor
    - limitações conhecidas e instruções de rollback

## Limitações de Validação

O que foi verificado localmente mas requer validação real na máquina servidor:

- Comportamento de Discord Activity e caminhos `.proxy`
- Captura real de screen/window/game
- Captura de jogo com OpenGL/Vulkan
- Encoding H.264 com hardware em Chrome/Edge/Brave
- Captura fallback Firefox
- Áudio nativo WASAPI
- Reconexão sob interrupção de rede real
- Layout de Activity mobile/embedded
- Troca de tela/hot-swap com viewers ativos
- Prompts de permissão de browser e gestos de usuário
- Startup do servidor com `.env` de produção
- Configuração real de tunnel e portal Discord

## Instruções de Rollback

Se necessário, para voltar ao estado antes do hardening:

```bash
cd "C:\Users\Vendel\Downloads\discord-screenshare-main - Copia"
git checkout dev
git branch -D release/2.0-beta
```

Isso restaurará o estado da branch `dev` antes das mudanças de hardening.

## Próximos Passos

Para finalizar a entrega beta:

1. Executar validação completa (testes, lint, format, build, smoke)
2. Revisar diffs e verificar arquivos gerados
3. Criar branch `release/2.0-beta`
4. Documentar claramente o que foi validado localmente vs servidor
5. Preparar instruções de teste na máquina servidor

## Git Status Atual

Arquivos modificados:
- `client/index.html`
- `client/src/main.js`
- `client/src/recovery.js`
- `client/src/style.css`
- `scripts/diagnostics.mjs`
- `scripts/diagnostics.test.js`
- `scripts/updater.mjs`
- `scripts/updater.test.js`
- `server/index-ws.test.js`
- `server/index.js`
- `server/public/share.html`
- `server/public/share.js`
- `server/public/share.css`
- `server/public/share.test.js`
- `server/tokens.js`
- `server/tokens.test.js`
- `client/src/main.test.js`

Branch atual: `dev` (tracking `origin/dev`)

Branch alvo: `release/2.0-beta` (a ser criada, sem push)
