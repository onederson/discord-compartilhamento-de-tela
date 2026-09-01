# Captura de áudio por processo

`audio-loopback.exe` captura somente o áudio produzido pelo Firefox ou por um
derivado conhecido (LibreWolf, Waterfox, Floorp, Zen, Pale Moon e Mullvad
Browser) e seus processos filhos usando WASAPI Process Loopback. Se mais de um
estiver aberto, a janela mais à frente tem prioridade. Ele escreve PCM `s16le`, 48 kHz,
estéreo no stdout e não abre rede, arquivos ou microfone.

A captura roda com prioridade multimídia do Windows e usa uma fila limitada a
meio segundo entre WASAPI e stdout. Se o consumidor atrasar, áudio velho é
descartado em vez de bloquear a captura ou acumular atraso indefinidamente.

O executável versionado em `bin/` é x64 e não exige instalação. Para recompilar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/audio-loopback/build.ps1
```

O desenho é derivado do exemplo ApplicationLoopback da Microsoft, distribuído
sob licença MIT. Consulte `THIRD-PARTY-NOTICES.txt` na raiz do projeto.
