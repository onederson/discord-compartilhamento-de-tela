# Uso no Android/iOS e plano de captura nativa

## O que já é possível

[Discord Activities são executadas no desktop, web, Android e iOS](https://docs.discord.com/developers/activities/development-guides/mobile).
No Developer Portal, em **Activities → Settings**, marque Android e iOS para
que a Activity apareça nessas plataformas.

A interface atual é responsiva, respeita as áreas seguras do Discord e permite
assistir transmissões no celular. Ao ampliar uma transmissão, ela ocupa todo o
viewport disponível e o SDK pede orientação horizontal no Discord para Android
e iOS. Em navegadores externos, a aplicação usa fullscreen e bloqueio de
orientação nativos quando permitidos; se o iframe ou o navegador negar essas
APIs, o modo imersivo em CSS continua funcionando sem cortar a imagem. A câmera
também pode transmitir em aparelhos que forneçam `getUserMedia` e WebCodecs. O
primeiro uso móvel escolhe o perfil Leve (720/1080p adaptativo, 30 fps e 1,5
Mb/s) para reduzir aquecimento e perda de quadros; uma preferência posterior do
usuário é preservada.

Quando o aparelho não oferece captura de tela, a Activity explica isso antes de
abrir a página externa e mantém os controles de assistir/câmera disponíveis. O
servidor não precisa rodar no celular: todos entram pelo endereço público do
PC, Mac, Linux ou VPS.

O limite atual é transmitir a tela do próprio telefone. A própria referência do
[`getDisplayMedia()` marca a API como disponibilidade limitada](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
e exige permissão iniciada por gesto toda vez. Termux consegue executar Node em
alguns Androids, mas isso só hospedaria o relay; não concede ao navegador
acesso à tela ou ao áudio de outros aplicativos e o sistema pode encerrar o
processo em segundo plano. Por isso Termux não é tratado como solução de
captura.

## Entrega web atual — assistir e câmera

Implementado no cliente web:

1. áreas seguras do Discord/iOS e layout estreito;
2. assistir, volume e câmera sem depender de captura de tela;
3. perfil Leve inicial no mobile;
4. detecção por capacidade, sem bloquear futuros navegadores que implementem
   `getDisplayMedia`;
5. aviso visível e anunciado por leitor de tela quando a captura não existe;
6. retomada automática ao voltar do segundo plano, receber `pageshow` ou trocar
   de rede, com watchdog de quadros e novo keyframe mesmo se a tela transmitida
   estiver completamente parada.

Ainda exige validação manual em aparelhos físicos: OAuth, rotação, teclado
virtual, retorno do segundo plano, troca Wi-Fi/dados, câmera por 30 minutos e
estado térmico. Esses testes não podem ser comprovados por um runner desktop.

## Próxima fase — transmissor nativo Android

Um aplicativo Android é o caminho técnico correto para capturar a tela:

1. aplicativo Kotlin com [`MediaProjectionManager`](https://developer.android.com/reference/android/media/projection/MediaProjectionManager)
   e serviço em primeiro plano do tipo `mediaProjection`;
2. `MediaCodec` para H.264 com perfil inicial de 720p30/1,5 Mb/s;
3. [`AudioPlaybackCapture`](https://developer.android.com/media/platform/av-capture)
   no Android 10+ para áudio de aplicativos que permitem captura; conteúdo
   protegido ou apps que recusam captura continuará mudo;
4. empacotamento no protocolo binário já usado pelo relay
   (`slot`, tipo, timestamp e payload);
5. ingresso seguro por link/QR efêmero emitido pela Activity, sem colocar Client
   Secret ou token permanente no APK;
6. notificação permanente, botão Parar e reação imediata à revogação da
   permissão do sistema;
7. no [Android 14 QPR2+](https://developer.android.com/about/versions/14/features/app-screen-sharing),
   oferecer compartilhamento de um único aplicativo;
8. reduzir resolução/bitrate com calor, perda de rede e congestionamento do
   relay.

Critério de conclusão: Android 10, 12, 14 e versão atual; tela inteira, app
individual quando suportado, rotação, áudio permitido/bloqueado, revogação,
Wi-Fi/dados e chamada Discord simultânea.

## Fase posterior — transmissor nativo iOS

Em sistemas atuais, a direção preferencial é o
[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit):
seletor de conteúdo do sistema, captura de vídeo/áudio com consentimento e modo
de execução em segundo plano. A amostra oficial de captura no iOS exige iOS 27
ou posterior; para versões anteriores ainda suportadas pelo produto, é preciso
avaliar o fallback com
[ReplayKit](https://developer.apple.com/documentation/replaykit) e Broadcast
Upload Extension em uma matriz real de aparelhos.

O trabalho inclui assinatura Apple, ingresso efêmero, H.264/áudio, retomada em
segundo plano, encerramento seguro e testes de conteúdo protegido. A
distribuição exige conta Apple Developer e revisão da App Store; não existe
equivalente confiável entregue somente por ZIP.

## Decisão de arquitetura

O relay, autenticação, salas e player permanecem neste repositório. Os clientes
nativos devem ser projetos separados que implementam o protocolo existente.
Isso evita transformar a aplicação web estável em um monorepo Android/iOS e
permite publicar correções do servidor sem depender das lojas.

Antes de começar o APK, o protocolo deve ganhar versão explícita, teste de
contrato com vetores binários e endpoint para ingresso efêmero do dispositivo.
Nenhuma fase deve expor o Client Secret no celular.
