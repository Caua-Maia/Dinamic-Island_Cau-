const { ipcRenderer } = require('electron')

window.island = {
  onSpotifyUpdate: (callback) => {
    ipcRenderer.on('spotify-update', (_event, data) => callback(data))
  },
  mediaCommand: (command) => ipcRenderer.send('media-command', command),
  mediaSeek: (positionMs) => ipcRenderer.send('media-seek', positionMs),
  segurar: (ativo) => ipcRenderer.send('segurar-mouse', ativo),
  setHitbox: (rects) => ipcRenderer.send('hitbox', rects),
  onPointer: (callback) => {
    ipcRenderer.on('pointer-over', (_event, dentro) => callback(dentro))
  },
  onPower: (callback) => {
    ipcRenderer.on('power-update', (_event, data) => callback(data))
  },
}
