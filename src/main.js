const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell, dialog, powerMonitor } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { onSessionsChanged, shutdown } = require('windows-media-sessions')

// Cole o Client ID e o Client Secret do app criado no Spotify Developer Dashboard
const SPOTIFY_CLIENT_ID = 'COLE_SEU_CLIENT_ID'
const SPOTIFY_CLIENT_SECRET = 'COLE_SEU_CLIENT_SECRET'
const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const SPOTIFY_SCOPES = 'user-read-currently-playing'

let islandWindow = null
let tray = null
let oauthServer = null
let oauthState = null
let accessToken = null
let refreshToken = null
let tokenExpiresAt = 0
let spotifyPollTimer = null
let spotifyPolling = false
let pararSessoes = null
let ultimoPayload = { playing: false }
let arteEnviadaPara = ''
let paginaPronta = false
let bateriaTimer = null
let lendoBateria = false
let ultimaBateria = { available: false, percent: null, charging: false }
let hitboxes = []
let cursorTimer = null
let cursorDentro = false
let segurandoMouse = false

// Palco fixo: a cápsula anima dentro da página. No Windows, setBounds não anima.
const STAGE = { width: 480, height: 250 }

function coordenadasIlha() {
  const area = screen.getPrimaryDisplay().bounds
  return {
    x: Math.round(area.x + (area.width - STAGE.width) / 2),
    y: area.y,
    width: STAGE.width,
    height: STAGE.height,
  }
}

function posicionarIlha() {
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.setBounds(coordenadasIlha())
}

function revelarJanela() {
  if (!islandWindow || islandWindow.isDestroyed()) return
  posicionarIlha()
  islandWindow.showInactive()
}

function createIsland() {
  const lugar = coordenadasIlha()
  islandWindow = new BrowserWindow({
    width: lugar.width,
    height: lugar.height,
    x: lugar.x,
    y: lugar.y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // macOS: flutua acima do dock
  if (process.platform === 'darwin') {
    islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    islandWindow.setWindowButtonVisibility(false)
  }

  islandWindow.loadFile(path.join(__dirname, 'index.html'))
  // O resto da tela continua clicável; a página pede o mouse só em cima da cápsula
  islandWindow.setIgnoreMouseEvents(true, { forward: true })
  // Teste: editor focado + clique na ilha. O editor não pode perder o cursor, e o botão ainda responde.
  // No Windows, focusable:false no construtor some com a janela transparente; a ilha só fica
  // não focável depois de aparecer.
  islandWindow.once('ready-to-show', () => {
    revelarJanela()
    islandWindow.setFocusable(false)
    revelarJanela()
  })
  // A página recarregada precisa receber a faixa que já estava tocando
  islandWindow.webContents.on('did-finish-load', () => {
    if (!islandWindow || islandWindow.isDestroyed()) return
    islandWindow.webContents.send('spotify-update', ultimoPayload)
    paginaPronta = true
  })

  // Remove da alt-tab
  islandWindow.setSkipTaskbar(true)
}

function createTray() {
  // Ícone minimalista na bandeja
  const img = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAACXBIWXMAAAsTAAALEwEAmpwYAAAANklEQVQokWP8z8BQz0ABYKJADaNOJt7JhCQYtXOYOHlUzagaVIOqQTWoBlWDalANqgHVAAC5mAgX0J4PZQAAAABJRU5ErkJggg=='
  )
  tray = new Tray(img)
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => revelarJanela() },
    { label: 'Ocultar',  click: () => islandWindow?.hide() },
    { type: 'separator' },
    { label: 'Timer 5 min', click: () => dispararTimer(5) },
    { label: 'Timer 15 min', click: () => dispararTimer(15) },
    { label: 'Timer 25 min', click: () => dispararTimer(25) },
    { type: 'separator' },
    { label: 'Conectar Spotify', click: () => conectarSpotify() },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ])
  tray.setToolTip('Dynamic Island')
  tray.setContextMenu(menu)
}

ipcMain.on('hitbox', (_event, rects) => {
  hitboxes = Array.isArray(rects) ? rects : []
})

ipcMain.on('segurar-mouse', (_event, ativo) => {
  segurandoMouse = !!ativo
  if (segurandoMouse && islandWindow) islandWindow.setIgnoreMouseEvents(false)
})

// A página não recebe mouse na área transparente. O cursor global é comparado com a cápsula.
function vigiarCursor() {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    if (!islandWindow || islandWindow.isDestroyed() || !islandWindow.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = islandWindow.getBounds()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    const dentro = segurandoMouse || hitboxes.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    if (dentro === cursorDentro) return
    cursorDentro = dentro
    if (dentro) islandWindow.setIgnoreMouseEvents(false)
    else islandWindow.setIgnoreMouseEvents(true, { forward: true })
    islandWindow.webContents.send('pointer-over', dentro)
  }, 30)
}

function dispararTimer(minutos) {
  if (!islandWindow || islandWindow.isDestroyed()) return
  revelarJanela()
  islandWindow.webContents.executeJavaScript(`window.startIslandTimer && window.startIslandTimer(${Number(minutos) || 5})`)
}

function enviarPower(payload) {
  ultimaBateria = { ...ultimaBateria, ...payload }
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.webContents.send('power-update', ultimaBateria)
}

// Percentual real da bateria do notebook. Desktop sem bateria manda available:false.
function lerBateria() {
  if (lendoBateria || process.platform !== 'win32') return
  lendoBateria = true
  const comando = "(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress)"
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], { windowsHide: true }, (erro, stdout) => {
    lendoBateria = false
    const texto = (stdout || '').trim()
    if (erro || !texto || texto === 'null') {
      enviarPower({ available: false })
      return
    }
    try {
      const item = JSON.parse(texto)
      const bateria = Array.isArray(item) ? item[0] : item
      if (!bateria || bateria.EstimatedChargeRemaining == null) {
        enviarPower({ available: false })
        return
      }
      const status = Number(bateria.BatteryStatus)
      // 6–9 é carga de verdade. 2 é só "na tomada" e 3 é bateria cheia: a luz fica apagada.
      const charging = [6, 7, 8, 9].includes(status)
      enviarPower({ available: true, percent: Number(bateria.EstimatedChargeRemaining), charging })
    } catch {
      enviarPower({ available: false })
    }
  })
}

function iniciarBateria() {
  lerBateria()
  bateriaTimer = setInterval(lerBateria, 8000)
  // Saiu da tomada: apaga na hora, sem esperar a próxima leitura.
  powerMonitor.on('on-battery', () => {
    enviarPower({ charging: false })
    lerBateria()
  })
  // Entrou na tomada: só acende se o Windows confirmar que está carregando.
  powerMonitor.on('on-ac', () => lerBateria())
}

// Mostra ou oculta a ilha, igual aos itens da bandeja
function toggleIsland() {
  if (!islandWindow) return
  if (islandWindow.isVisible()) islandWindow.hide()
  else revelarJanela()
}

// Tokens ficam fora do código, na pasta de dados do usuário
function caminhoTokens() {
  return path.join(app.getPath('userData'), 'spotify-tokens.json')
}

function credenciaisOk() {
  const vazio = (valor) => !valor || valor.startsWith('COLE_')
  return !vazio(SPOTIFY_CLIENT_ID) && !vazio(SPOTIFY_CLIENT_SECRET)
}

function salvarTokens() {
  fs.writeFileSync(caminhoTokens(), JSON.stringify({ accessToken, refreshToken, tokenExpiresAt }))
}

function carregarTokens() {
  try {
    const salvo = JSON.parse(fs.readFileSync(caminhoTokens(), 'utf8'))
    accessToken = salvo.accessToken || null
    refreshToken = salvo.refreshToken || null
    tokenExpiresAt = salvo.tokenExpiresAt || 0
  } catch {
    // Ainda não conectou nesta máquina
  }
}

function aplicarTokens(json) {
  accessToken = json.access_token
  if (json.refresh_token) refreshToken = json.refresh_token
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000
  salvarTokens()
}

async function pedirToken(campos) {
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
  const resposta = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(campos),
  })
  if (!resposta.ok) {
    const detalhe = await resposta.text()
    throw new Error(`Falha no token (${resposta.status}): ${detalhe}`)
  }
  return resposta.json()
}

async function atualizarAccessToken() {
  if (!refreshToken) throw new Error('Sem refresh token')
  const json = await pedirToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  aplicarTokens(json)
}

function enviarSpotify(payload) {
  ultimoPayload = payload
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.webContents.send('spotify-update', payload)
}

// Prefere o que está tocando; se só houver pausa, ainda mostra a faixa
function escolherSessao(sessions) {
  const faixas = (sessions || []).filter((sessao) => sessao && sessao.title)
  return faixas.find((sessao) => sessao.playbackStatus === 'playing')
    || faixas.find((sessao) => sessao.playbackStatus === 'paused')
    || null
}

function publicarSessoes(sessions) {
  const sessao = escolherSessao(sessions)
  if (!sessao) {
    arteEnviadaPara = ''
    enviarSpotify({ playing: false })
    return
  }

  const chave = `${sessao.id}|${sessao.title}`
  const payload = {
    playing: true,
    isPlaying: sessao.playbackStatus === 'playing',
    title: sessao.title,
    artist: sessao.artist || sessao.albumTitle || sessao.sourceAppDisplayName || 'Música',
    progressMs: (sessao.timeline && sessao.timeline.positionMs) || 0,
    durationMs: (sessao.timeline && sessao.timeline.durationMs) || 0,
  }
  // A capa é grande; manda de novo só quando a faixa muda.
  // Antes da página abrir, manda sempre para o primeiro frame não ficar sem imagem.
  if (sessao.thumbnail && (arteEnviadaPara !== chave || !paginaPronta)) {
    payload.art = sessao.thumbnail
    arteEnviadaPara = chave
  }
  enviarSpotify(payload)
}

// Ouve o que o Windows já mostra no volume: Spotify, navegador, etc.
function iniciarMidiaWindows() {
  if (process.platform !== 'win32' || pararSessoes) return
  pararSessoes = onSessionsChanged((sessions) => publicarSessoes(sessions))
}

const SCRIPT_MIDIA = `
param([string]$cmd = 'playpause')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = @($mgr.GetSessions())
if ($sessions.Count -eq 0) { Write-Output 'SEM_SESSAO'; exit 0 }
$session = $null
if ($cmd -eq 'playpause') {
  $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
  if (-not $session) { $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Paused' } | Select-Object -First 1 }
} else {
  $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' -or $_.GetPlaybackInfo().PlaybackStatus -eq 'Paused' } | Select-Object -First 1
}
if (-not $session) { $session = $mgr.GetCurrentSession() }
if (-not $session) { Write-Output 'SEM_ALVO'; exit 0 }
$op = switch ($cmd) {
  'next' { $session.TrySkipNextAsync() }
  'prev' { $session.TrySkipPreviousAsync() }
  default { $session.TryTogglePlayPauseAsync() }
}
$ok = Await $op ([bool])
Write-Output "OK=$ok"
`

let scriptMidia = null
let ultimoToqueMidia = 0

function garantirScriptMidia() {
  if (scriptMidia) return scriptMidia
  scriptMidia = path.join(app.getPath('temp'), 'dynamic-island-media.ps1')
  fs.writeFileSync(scriptMidia, SCRIPT_MIDIA)
  return scriptMidia
}

// Manda play, pausa e troca de faixa para a sessão que o Windows está tocando.
function enviarTeclaMidia(comando) {
  const permitidos = ['playpause', 'next', 'prev']
  if (!permitidos.includes(comando)) return
  const arquivo = garantirScriptMidia()
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', arquivo, comando],
    { windowsHide: true },
    (erro, stdout, stderr) => {
      const saida = `${stdout || ''} ${stderr || ''}`.trim()
      if (erro) console.error('Mídia:', erro.message, saida)
      else if (saida) console.log('Mídia:', saida)
    }
  )
}

ipcMain.on('media-command', (_event, comando) => {
  const agora = Date.now()
  if (agora - ultimoToqueMidia < 500) return
  ultimoToqueMidia = agora
  enviarTeclaMidia(comando)
})

function nomeArtista(item) {
  if (Array.isArray(item.artists) && item.artists.length) {
    return item.artists.map((artista) => artista.name).filter(Boolean).join(', ')
  }
  if (item.show && item.show.name) return item.show.name
  return 'Spotify'
}

// Consulta a faixa atual e avisa o renderer
async function consultarTocando(tentouRenovar = false) {
  if (!accessToken) return
  if (Date.now() >= tokenExpiresAt - 30000) await atualizarAccessToken()

  const resposta = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (resposta.status === 401 && !tentouRenovar) {
    await atualizarAccessToken()
    return consultarTocando(true)
  }
  // 204 = nenhum dispositivo tocando
  if (resposta.status === 204) {
    enviarSpotify({ playing: false })
    return
  }
  if (!resposta.ok) throw new Error(`Player HTTP ${resposta.status}`)

  const dados = await resposta.json()
  if (!dados.is_playing || !dados.item) {
    enviarSpotify({ playing: false })
    return
  }

  enviarSpotify({
    playing: true,
    title: dados.item.name || 'Sem título',
    artist: nomeArtista(dados.item),
    progressMs: dados.progress_ms || 0,
    durationMs: dados.item.duration_ms || 0,
  })
}

async function pulsoSpotify() {
  if (spotifyPolling) return
  spotifyPolling = true
  try {
    await consultarTocando()
  } catch (erro) {
    console.error('Spotify:', erro.message)
  } finally {
    spotifyPolling = false
  }
}

function iniciarPolling() {
  if (spotifyPollTimer) return
  pulsoSpotify()
  spotifyPollTimer = setInterval(pulsoSpotify, 5000)
}

// Abre o login do Spotify no navegador; o código volta em /callback
function conectarSpotify() {
  if (!credenciaisOk()) {
    dialog.showErrorBox('Spotify', 'Cole o Client ID e o Client Secret nas constantes no topo de src/main.js.')
    return
  }
  oauthState = crypto.randomBytes(16).toString('hex')
  const url = new URL('https://accounts.spotify.com/authorize')
  url.searchParams.set('client_id', SPOTIFY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI)
  url.searchParams.set('scope', SPOTIFY_SCOPES)
  url.searchParams.set('state', oauthState)
  url.searchParams.set('show_dialog', 'true')
  shell.openExternal(url.toString())
}

function iniciarServidorOAuth() {
  oauthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:8888')
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Não encontrado')
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const erro = url.searchParams.get('error')
    const pagina = (status, texto) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${texto}</p>`)
    }

    if (erro || !code || state !== oauthState) {
      pagina(400, 'Não foi possível conectar o Spotify. Pode fechar esta aba.')
      return
    }

    try {
      const json = await pedirToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      })
      aplicarTokens(json)
      iniciarPolling()
      pagina(200, 'Spotify conectado. Pode fechar esta aba e voltar à ilha.')
    } catch (falha) {
      console.error('Spotify:', falha.message)
      pagina(500, 'Erro ao concluir o login do Spotify. Pode fechar esta aba.')
    }
  })

  oauthServer.on('error', (erro) => {
    console.error('Servidor OAuth:', erro.message)
  })
  oauthServer.listen(8888, '127.0.0.1')
}

const instanciaUnica = app.requestSingleInstanceLock()
if (!instanciaUnica) {
  app.quit()
} else {
  app.on('second-instance', () => revelarJanela())

  app.whenReady().then(() => {
    createIsland()
    createTray()
    screen.on('display-metrics-changed', posicionarIlha)
    screen.on('display-added', posicionarIlha)
    screen.on('display-removed', posicionarIlha)

    const registered = globalShortcut.register('CommandOrControl+Shift+I', toggleIsland)
    if (!registered) console.warn('Não foi possível registrar o atalho Ctrl+Shift+I')

    iniciarServidorOAuth()
    carregarTokens()
    if (refreshToken) iniciarPolling()
    iniciarMidiaWindows()
    iniciarBateria()
    vigiarCursor()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (spotifyPollTimer) clearInterval(spotifyPollTimer)
    if (oauthServer) oauthServer.close()
    if (pararSessoes) pararSessoes()
    if (bateriaTimer) clearInterval(bateriaTimer)
    if (cursorTimer) clearInterval(cursorTimer)
    shutdown().catch(() => {})
  })
}
