# Como funciona (para quem mexe no código)

Este arquivo existe só para explicar as decisões que não se adivinham lendo o
código. Para instalar e usar, veja o [README](../README.md).

## Por que a tela é capturada numa aba separada

Duas restrições do Discord definiram o desenho inteiro:

1. **A atividade roda num iframe de outro domínio.** Nesse contexto o navegador
   nega `getDisplayMedia()` — a função que pede a tela — a menos que o Discord
   marque o iframe com `allow="display-capture"`, o que ele não faz.
2. **WebRTC não existe em atividades.** A documentação do Discord diz que só
   WebSocket é suportado. Sem P2P, sem SFU.

Então a captura acontece **fora** do sandbox, numa aba normal do navegador, e os
quadros vão por WebSocket para o servidor, que os repassa para quem assiste:

```
QUEM MOSTRA                        SERVIDOR              QUEM ASSISTE
aba normal do navegador                                  atividade (iframe)
  getDisplayMedia  ✅                                          │
  VideoEncoder                                                 │
  └──── WebSocket binário ────►  repassa sem                   │
                                 abrir o quadro ───────────────►
                                                          VideoDecoder → canvas
```

Quem assiste nunca sai do Discord. Só quem mostra passa por uma aba.

Se um dia o Discord conceder `display-capture`, o botão **"Testar captura no
iframe"** (no painel de detalhes) passa a funcionar — e aí a aba externa pode
sumir. A atividade já tenta capturar internamente antes de cair para a aba.

## Por que WebCodecs e não MediaRecorder

A primeira versão usava `MediaRecorder` + Media Source Extensions e ficava em
~3 segundos de atraso. O formato de container impõe um piso: o pedaço só sai
depois de fechado, e o player precisa acumular buffer para não engasgar.

WebCodecs elimina os dois. Cada quadro é codificado, enviado e desenhado
individualmente, sem container. E, ao contrário de `display-capture`, WebCodecs
não é bloqueado dentro do iframe.

## Keyframe sob demanda

Quem chega no meio de uma transmissão não consegue decodificar nada até receber
um quadro completo. Em vez de guardar um antigo, o servidor **pede um novo** ao
transmissor quando alguém começa a assistir — a tela aparece em ~1 quadro.

O servidor também barra quadros incompletos para quem ainda não recebeu um
completo: alimentar um decodificador frio com eles só produz erro.

## Assistir é opt-in

O servidor não manda os quadros de uma tela para ninguém que não tenha pedido
explicitamente. É o que segura a banda: filtrar só na exibição gastaria a mesma
saída de rede. Por isso cada tela aparece primeiro como um convite
("Assistir tela") em vez de já começar a tocar.

## Salas

- **No Discord:** não há lista. A atividade entra direto na sala daquela call.
  Com `DISCORD_BOT_TOKEN` configurado, o servidor confirma com o Discord quem
  está no canal de voz; sem ele, o escopo é a instância da atividade.
- **No site:** não existe call para herdar, então a lista de salas é a única
  forma de as pessoas se encontrarem. Salas podem ter senha.

Salas vivem em memória e fecham sozinhas 12 segundos depois de esvaziar — a
carência existe porque recarregar a página desconecta e reconecta.

## Som

O áudio vai pelo mesmo socket e pelo mesmo cabeçalho do vídeo, distinguido só
pelo byte de tipo. Há dois caminhos, ambos codificados em Opus a 96 kbps:

- Chromium usa a faixa retornada por `getDisplayMedia()`. Uma guia é isolada
  por construção. O áudio do monitor inteiro é aceito somente após a escolha
  explícita no diálogo do navegador e vem acompanhado de aviso, pois pode
  incluir Discord, notificações e todos os outros sons do computador.
- Firefox não implementa áudio em `getDisplayMedia()` nem
  `MediaStreamTrackProcessor`. No Windows, o servidor inicia
  `audio-loopback.exe`, que usa WASAPI Process Loopback para capturar somente a
  árvore de processos de `firefox.exe`. O helper entrega PCM estéreo de 48 kHz
  em blocos de 20 ms; o servidor codifica Opus e usa o mesmo tipo 3 do protocolo.
  A thread WASAPI usa prioridade multimídia e não escreve diretamente no pipe:
  uma fila limitada absorve pausas curtas do Node e descarta áudio antigo antes
  que uma leitura lenta vire atraso crescente. Um watchdog encerra o helper se
  ele nascer mas não confirmar `READY` em oito segundos.

A captura nativa exclui o Discord e os demais aplicativos, mas seu limite é a
árvore de processos, não o título exato da janela. Várias janelas do Firefox
sob o mesmo processo raiz podem ser ouvidas juntas. Essa limitação decorre de o
navegador não expor a relação entre a superfície escolhida e um PID. O caminho
resolve também o cenário relatado no
[issue 10 do projeto original](https://github.com/Jc007zZ/discord-screen/issues/10)
sem recorrer à mistura de áudio do sistema.

Junto vai `restrictOwnAudio` quando o navegador suporta: ele tira da captura o
que a própria página está tocando, senão quem transmite enquanto assiste devolve
o som da outra tela para a sala, em laço.

Três coisas que o desenho assume:

- **Áudio não tem keyframe.** Cada pacote Opus se decodifica sozinho, então ele
  não passa pelo bloqueio que barra vídeo sem ponto de partida. Se passasse,
  quem entra no meio ficaria mudo até o próximo keyframe.
- **Buraco em áudio é audível.** Um quadro de vídeo perdido não se nota; um
  intervalo sem amostra é um estalo. Por isso a reprodução mantém um colchão de
  80 ms — o som toca um pouco atrás do vivo, e essa folga absorve o solavanco
  da rede. Passando de 320 ms acumulados, corta e volta ao vivo: atraso somado
  não se recupera sozinho.
- **Sincronia é aceitável, não exata.** O vídeo é desenhado assim que chega; o
  som carrega o colchão. A diferença fica em algumas dezenas de milissegundos,
  abaixo do que se percebe em tela de computador. Casar os dois exigiria
  atrasar o vídeo até o áudio — mais latência para resolver um problema que não
  aparece fora de rosto falando.

A reprodução agenda cada pedaço num `AudioBufferSourceNode`, sem AudioWorklet.
O worklet daria precisão por amostra, mas exige um arquivo carregado por URL, e
dentro da atividade toda URL passa pelo proxy do Discord — um caminho a mais
para dar errado, em troca de precisão que pacotes de 20 ms não pedem.

## Protocolo

Cada pacote trafega como binário puro:

```
[1B slot][1B tipo: 1=vídeo completo 2=vídeo parcial 3=som][8B tempo][8B relógio][payload]
```

O `slot` é o número do transmissor, carimbado na origem: o servidor repassa o
buffer sem tocar nele, e quem assiste sabe para qual decodificador mandar. Até
4 transmissores por sala.

O relógio de envio serve só para medir atraso. É exato na mesma máquina; entre
máquinas diferentes, aproximado.

Controle vai em JSON: `start`, `config`, `audio-config`, `stop`
(transmissor → servidor); `slot`, `state`, `stream-start`, `config`,
`audio-config`, `relay-congestion`, `stream-stop`, `need-keyframe`, `error`
(servidor → clientes). O transmissor só começa depois de receber `slot`; isso
impede que participantes posteriores enviem quadros identificados como se
fossem do primeiro. `relay-congestion` fecha o ciclo de contrapressão: quando a
fila da maioria dos espectadores ativos estoura, o emissor reduz o bitrate em
vez de acumular atraso indefinidamente. Uma única conexão lenta não reduz a
qualidade de todos quando os demais continuam saudáveis.

## Detalhes que não são acidentais

- **`latencyMode: 'realtime'`** no codificador e **`optimizeForLatency: true`**
  no decodificador. Sem eles, ambos acumulam quadros antes de emitir — comprime
  melhor, mas é atraso que nunca mais sai.
- **Aceleração de vídeo preferida, não obrigatória.** O transmissor tenta
  `hardwareAcceleration: 'prefer-hardware'` primeiro, evitando que 1080p60
  sobrecarregue a CPU, e repete a negociação sem essa dica quando necessário.
- **Redução na origem.** A captura pede no máximo 1920×1080 e
  `resizeMode: 'crop-and-scale'`. Assim Firefox e Chromium podem reduzir um
  monitor 4K antes de entregar cada quadro ao JavaScript, evitando uma cópia
  4K cara no canvas. O nível AVC também acompanha resolução e FPS: 1080p60 usa
  H.264 Baseline nível 4.2, não o antigo nível 3.0 insuficiente.
- **Adaptação por pressão real.** Se mais de 20% dos quadros encontram o encoder
  congestionado, a fila é zerada e a saída passa de 1080p para 900p e, se
  necessário, 720p. O Firefox também adapta quando sua própria captura via
  `<video>` fica muito abaixo do alvo. Se o WebSocket acumula cerca de 250–400
  ms, quadros são descartados antes do encoder para não transformar banda
  limitada em vários segundos de atraso; após duas janelas consecutivas de
  congestionamento, o bitrate cai 25%, até o piso de 1,2 Mb/s.
  Depois de seis janelas saudáveis consecutivas, ele volta a subir em passos
  pequenos até o perfil escolhido pelo usuário; uma oscilação curta não deixa
  a transmissão presa em baixa qualidade pelo resto da sessão.
- **`frame.close()`** depois de desenhar. `VideoFrame` segura memória de GPU;
  sem isso a aba trava em segundos.
- **Descartar quadro quando a fila do codificador passa de 2.** Fila vira
  atraso permanente. Melhor perder um quadro do que carregar o atraso.
- **`track.contentHint`.** Em 30 fps usa `text`, mantendo interfaces nítidas;
  nos perfis de 60 fps usa `motion`, favorecendo vídeo e jogos.
- **Relógio em Worker no Firefox.** Como esse navegador ainda não oferece
  `MediaStreamTrackProcessor`, os quadros vêm de um `<video>`. Um Worker aciona
  a cópia no FPS escolhido mesmo quando a aba de transmissão fica em segundo
  plano, onde callbacks ligados à pintura seriam reduzidos.
- **Backpressure no relay.** Se o socket de alguém acumula mais de 2 MB, o
  servidor descarta quadros para essa pessoa em vez de enfileirar. Sem isso, um
  espectador com internet ruim derruba o processo por consumo de memória.
- **Ressincronização persistente.** Enquanto o primeiro quadro não chega, o
  espectador repete a solicitação a cada três segundos. Deltas recebidos com o
  decoder frio e erros de decodificação pedem uma configuração e um keyframe
  novos. Depois do primeiro quadro, um watchdog também detecta fluxo parado;
  `visibilitychange`, `pageshow`, reconexão WebSocket e retorno da rede disparam
  recuperação imediata. O transmissor atende o keyframe pendente até quando a
  imagem é idêntica à anterior, evitando depender de movimento do mouse para
  sair de “Conectando…” no celular.
- **`/.proxy/`** em todo fetch e WebSocket feito de dentro da atividade — é
  assim que o Discord roteia para o seu servidor.
- **Client ID vem do servidor, não do build.** Embutir no bundle obrigava a
  rebuildar a cada troca de credencial, e esquecer disso não dava erro: a
  atividade abria e só quebrava no login.

## Estrutura

```
server/
  index.js        HTTP + WebSocket, login do Discord, emissão de tokens
  native-audio.js captura WASAPI, enquadra PCM e codifica Opus
  rooms.js        salas e repasse dos quadros
  tokens.js       tokens assinados (sem biblioteca externa)
  public/share.*  a aba de captura, que roda FORA do Discord
client/
  src/main.js     interface da sala e conexão
  src/player.js   decodifica os quadros e desenha no canvas
  src/audio.js    decodifica o som e agenda a reprodução
shared/
  broadcaster.js  captura + codificação, usada pela aba e pela atividade
scripts/
  configurar.mjs  assistente de configuração
  tunel.mjs       sobe o túnel e grava o endereço no .env
  smoke.mjs       teste do servidor ponta a ponta, sem navegador
  smoke-native-audio.mjs  valida helper, Opus e relay com um processo real
native/audio-loopback/
  audio-loopback.cpp + build.ps1 + bin/audio-loopback.exe
```

## Testes

```
npm start        # numa janela
npm run smoke    # noutra
npm run smoke:audio
```

Cobre autenticação, senha de sala e bloqueio por tentativas, a máquina de
estados do keyframe, "assistir é opt-in", vários transmissores sem misturar os
streams, e isolamento entre salas e instâncias.

## Rodando enquanto mexe no código

`npm start` reconstrói o site a cada execução. Para recarregar sozinho a cada
salvamento, use `npm run dev` — ele sobe o servidor na 3001 e o site na 5173,
e é a 5173 que você abre.
