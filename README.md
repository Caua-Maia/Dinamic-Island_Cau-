# Dynamic Island para Windows

Cápsula flutuante no topo do monitor primário, no estilo da Dynamic Island. Só Windows.

## Como rodar

```bash
npm install
npm start
```

## Estrutura

```
dynamic-island/
├── src/
│   ├── main.js        ← processo principal (Electron)
│   ├── preload.js     ← ponte IPC
│   └── index.html     ← cápsula (HTML/CSS/JS)
├── package.json
└── README.md
```

## Controles

- **Ctrl+Shift+I** — mostra ou oculta a ilha
- **Bandeja** — Mostrar, Ocultar, timers (5/15/25 min) e Sair
- **Arraste horizontal** na cápsula — troca entre música, bateria, timer e relógio
- Passe o mouse no centro da borda de cima para revelar a ilha escondida

## API (DevTools da página)

```js
window.showNotification('Mensagens', 'Ana: Oi!')
window.showMusic()
window.showTimer()
window.showIdle()
window.startIslandTimer(5)
```

- `showNotification(app, msg)` — alerta temporário
- `showMusic()` — abre a página de música
- `showTimer()` — abre a página de timer
- `showIdle()` — limpa o alerta e recolhe a ilha
- `startIslandTimer(minutos)` — inicia um timer
