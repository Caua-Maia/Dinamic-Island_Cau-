const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell, dialog, powerMonitor } = require('electron')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('log-level', '3')
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
const SPOTIFY_SCOPES = 'user-read-currently-playing user-modify-playback-state'

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
const CHARGING_LEITURAS_PARA_MUDAR = 2
let filaLeituraCharging = []
let forcarChargingNaProximaLeitura = null
let primeiraLeituraBateria = true
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
    islandWindow.webContents.send('power-update', ultimaBateria)
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

// Longe do topo, o cursor é olhado devagar. Perto da cápsula, o teste fica rápido.
function vigiarCursor() {
  if (cursorTimer) return
  const pulso = () => {
    cursorTimer = null
    let espera = 500
    if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
      const cursor = screen.getCursorScreenPoint()
      const bounds = islandWindow.getBounds()
      const perto = cursor.y <= bounds.y + bounds.height + 96
        && cursor.x >= bounds.x - 64
        && cursor.x <= bounds.x + bounds.width + 64
      if (perto || cursorDentro || segurandoMouse) {
        const x = cursor.x - bounds.x
        const y = cursor.y - bounds.y
        const dentro = segurandoMouse || hitboxes.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
        if (dentro !== cursorDentro) {
          cursorDentro = dentro
          if (dentro) islandWindow.setIgnoreMouseEvents(false)
          else islandWindow.setIgnoreMouseEvents(true, { forward: true })
          islandWindow.webContents.send('pointer-over', dentro)
        }
        espera = 32
      } else {
        espera = 200
      }
    }
    cursorTimer = setTimeout(pulso, espera)
  }
  pulso()
}

function dispararTimer(minutos) {
  if (!islandWindow || islandWindow.isDestroyed()) return
  revelarJanela()
  islandWindow.webContents.executeJavaScript(`window.startIslandTimer && window.startIslandTimer(${Number(minutos) || 5})`)
}

function chargingEstavelAposLeitura(novo) {
  if (forcarChargingNaProximaLeitura !== null) {
    const fixo = !!forcarChargingNaProximaLeitura
    forcarChargingNaProximaLeitura = null
    filaLeituraCharging = [fixo, fixo]
    return fixo
  }
  filaLeituraCharging.push(!!novo)
  if (filaLeituraCharging.length > CHARGING_LEITURAS_PARA_MUDAR) {
    filaLeituraCharging.shift()
  }
  if (filaLeituraCharging.length < CHARGING_LEITURAS_PARA_MUDAR) {
    return ultimaBateria.charging
  }
  const todosTrue = filaLeituraCharging.every((v) => v === true)
  const todosFalse = filaLeituraCharging.every((v) => v === false)
  if (todosTrue) return true
  if (todosFalse) return false
  return ultimaBateria.charging
}

function enviarPower(payload) {
  const antes = { ...ultimaBateria }
  ultimaBateria = { ...ultimaBateria, ...payload }
  if (!ultimaBateria.available) {
    ultimaBateria.charging = false
    ultimaBateria.percent = null
  }
  const repetido = antes.available === ultimaBateria.available
    && antes.charging === ultimaBateria.charging
    && antes.percent === ultimaBateria.percent
  if (repetido) return
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.webContents.send('power-update', ultimaBateria)
}

const SCRIPT_BATERIA = `
$ErrorActionPreference = 'SilentlyContinue'
$percent = $null
$charging = $false
$status = $null
foreach ($b in Get-CimInstance -ClassName Win32_Battery) {
  if ($null -eq $b.EstimatedChargeRemaining) { continue }
  $pct = [int]$b.EstimatedChargeRemaining
  if ($null -eq $percent -or $pct -gt $percent) { $percent = $pct }
  $st = [int]$b.BatteryStatus
  if ($null -eq $status) { $status = $st }
  if ($st -ge 6 -and $st -le 9) { $charging = $true }
  if ($st -eq 1) { $charging = $false }
}
foreach ($w in Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus) {
  if ($w.Charging -eq $true) { $charging = $true }
  if ($w.Discharging -eq $true) { $charging = $false }
  if ($null -ne $w.ChargeRate -and [int]$w.ChargeRate -gt 0) { $charging = $true }
}
if ($status -eq 3 -and $percent -ge 98) { $charging = $false }
if ($null -eq $percent) {
  @{ available = $false; percent = $null; charging = $false } | ConvertTo-Json -Compress
} else {
  @{ available = $true; percent = $percent; charging = [bool]$charging } | ConvertTo-Json -Compress
}
`

let scriptBateria = null

function garantirScriptBateria() {
  if (scriptBateria) return scriptBateria
  scriptBateria = path.join(app.getPath('temp'), 'dynamic-island-bateria.ps1')
  fs.writeFileSync(scriptBateria, SCRIPT_BATERIA)
  return scriptBateria
}

// Percentual real da bateria do notebook. Desktop sem bateria manda available:false.
function lerBateria() {
  if (lendoBateria || process.platform !== 'win32') return
  lendoBateria = true
  const arquivo = garantirScriptBateria()
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', arquivo],
    { windowsHide: true },
    (erro, stdout) => {
      lendoBateria = false
      const texto = (stdout || '').trim()
      if (erro || !texto || texto === 'null') {
        enviarPower({ available: false, charging: false, percent: null })
        return
      }
      try {
        const dados = JSON.parse(texto)
        if (!dados.available) {
          enviarPower({ available: false, charging: false, percent: null })
          return
        }
        let charging = chargingEstavelAposLeitura(!!dados.charging)
        if (primeiraLeituraBateria) {
          primeiraLeituraBateria = false
          charging = !!dados.charging
          filaLeituraCharging = [charging, charging]
        }
        enviarPower({
          available: true,
          percent: Number(dados.percent),
          charging,
        })
      } catch {
        enviarPower({ available: false, charging: false, percent: null })
      }
    }
  )
}

function lerBateriaComAtraso() {
  lerBateria()
  setTimeout(lerBateria, 1500)
  setTimeout(lerBateria, 4500)
}

function iniciarBateria() {
  lerBateria()
  bateriaTimer = setInterval(lerBateria, 45000)
  powerMonitor.on('on-battery', () => {
    forcarChargingNaProximaLeitura = false
    filaLeituraCharging = [false, false]
    lerBateria()
  })
  powerMonitor.on('on-ac', () => lerBateriaComAtraso())
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

function limparMusicaIlha() {
  arteEnviadaPara = ''
  ultimoPayload = { playing: false }
  enviarSpotify({ playing: false })
}

function sessaoComMidia(sessao) {
  if (!sessao || !String(sessao.title || '').trim()) return false
  const estado = sessao.playbackStatus
  if (estado === 'closed' || estado === 'stopped') return false
  return estado === 'playing' || estado === 'paused'
}

// Qualquer app (Spotify, Edge, YouTube…). Sem faixa ativa, a ilha zera a área de música.
function escolherSessao(sessions) {
  const faixas = (sessions || []).filter(sessaoComMidia)
  return faixas.find((sessao) => sessao.playbackStatus === 'playing')
    || faixas.find((sessao) => sessao.playbackStatus === 'paused')
    || null
}

let ultimoEnvioProgresso = 0
let progressoAgendado = null
let payloadProgresso = null

function metaDaFaixaMudou(payload) {
  if (!ultimoPayload || !ultimoPayload.playing) return true
  return ultimoPayload.title !== payload.title
    || ultimoPayload.artist !== payload.artist
    || !!ultimoPayload.isPlaying !== !!payload.isPlaying
    || ultimoPayload.durationMs !== payload.durationMs
    || !!payload.art
}

function publicarSessoes(sessions) {
  const sessao = escolherSessao(sessions)
  if (!sessao) {
    if (progressoAgendado) {
      clearTimeout(progressoAgendado)
      progressoAgendado = null
    }
    limparMusicaIlha()
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
  if (sessao.thumbnail && (arteEnviadaPara !== chave || !paginaPronta)) {
    payload.art = sessao.thumbnail
    arteEnviadaPara = chave
  }

  if (metaDaFaixaMudou(payload)) {
    if (progressoAgendado) {
      clearTimeout(progressoAgendado)
      progressoAgendado = null
    }
    ultimoEnvioProgresso = Date.now()
    enviarSpotify(payload)
    return
  }

  if (!payload.isPlaying && Math.abs((ultimoPayload.progressMs || 0) - payload.progressMs) < 800) return

  const salto = Math.abs((ultimoPayload.progressMs || 0) - payload.progressMs)
  const agora = Date.now()
  if (salto > 2500 || agora - ultimoEnvioProgresso >= 1000) {
    ultimoEnvioProgresso = agora
    enviarSpotify(payload)
    return
  }

  payloadProgresso = payload
  if (progressoAgendado) return
  progressoAgendado = setTimeout(() => {
    progressoAgendado = null
    ultimoEnvioProgresso = Date.now()
    if (payloadProgresso) enviarSpotify(payloadProgresso)
  }, 1000 - (agora - ultimoEnvioProgresso))
}

// Ouve o que o Windows já mostra no volume: Spotify, navegador, etc.
function iniciarMidiaWindows() {
  if (process.platform !== 'win32' || pararSessoes) return
  pararSessoes = onSessionsChanged((sessions) => publicarSessoes(sessions))
}

const SCRIPT_MIDIA = `
param(
  [Parameter(Position = 0)][string]$cmd = 'playpause',
  [Parameter(Position = 1)][long]$positionMs = 0
)
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
  'seek' {
    $posMs = [Math]::Max(0, $positionMs)
    $ticks = [TimeSpan]::FromMilliseconds([double]$posMs).Ticks
    $session.TryChangePlaybackPositionAsync([int64]$ticks)
  }
  default { $session.TryTogglePlayPauseAsync() }
}
$ok = Await $op ([bool])
Write-Output "OK=$ok"
`

let scriptMidia = null
let ultimoToqueMidia = 0

function garantirScriptMidia() {
  const arquivo = path.join(app.getPath('temp'), 'dynamic-island-media.ps1')
  fs.writeFileSync(arquivo, SCRIPT_MIDIA)
  scriptMidia = arquivo
  return scriptMidia
}

// Manda play, pausa, troca de faixa e seek para a sessão que o Windows está tocando.
function enviarTeclaMidia(comando, positionMs = 0) {
  const permitidos = ['playpause', 'next', 'prev', 'seek']
  if (!permitidos.includes(comando)) return
  const arquivo = garantirScriptMidia()
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', arquivo, comando]
  if (comando === 'seek') args.push(String(Math.max(0, Math.round(positionMs))))
  execFile(
    'powershell.exe',
    args,
    { windowsHide: true },
    (erro, stdout, stderr) => {
      const saida = `${stdout || ''} ${stderr || ''}`.trim()
      if (erro) console.error('Mídia:', erro.message, saida)
      else if (/OK=False/i.test(saida)) console.warn('Mídia:', saida)
    }
  )
}

ipcMain.on('media-command', (_event, comando) => {
  const agora = Date.now()
  if (agora - ultimoToqueMidia < 500) return
  ultimoToqueMidia = agora
  enviarTeclaMidia(comando)
})

async function seekSpotify(positionMs) {
  if (!accessToken) return
  try {
    if (Date.now() >= tokenExpiresAt - 30000) await atualizarAccessToken()
    const resposta = await fetch(
      `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.round(positionMs)}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (resposta.status === 401) {
      await atualizarAccessToken()
      await fetch(
        `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.round(positionMs)}`,
        { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
      )
    }
  } catch (erro) {
    console.error('Spotify seek:', erro.message)
  }
}

ipcMain.on('media-seek', (_event, positionMs) => {
  const ms = Number(positionMs)
  if (!Number.isFinite(ms) || ms < 0) return
  // SMTC usa ticks (100 ns); API do Spotify usa ms — não misturar unidades.
  enviarTeclaMidia('seek', ms)
  if (accessToken) seekSpotify(ms)
})

function nomeArtista(item) {
  if (Array.isArray(item.artists) && item.artists.length) {
    return item.artists.map((artista) => artista.name).filter(Boolean).join(', ')
  }
  if (item.show && item.show.name) return item.show.name
  return 'Spotify'
}

// Consulta a faixa atual e avisa o renderer (fallback; no Windows a sessão SMTC manda)
async function consultarTocando(tentouRenovar = false) {
  const skipSmtc = process.platform === 'win32' && !!pararSessoes
  if (skipSmtc) return
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
    limparMusicaIlha()
    return
  }
  if (!resposta.ok) throw new Error(`Player HTTP ${resposta.status}`)

  const dados = await resposta.json()
  if (!dados.is_playing || !dados.item) {
    limparMusicaIlha()
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
  if (process.platform === 'win32') return
  pulsoSpotify()
  spotifyPollTimer = setInterval(pulsoSpotify, 5000)
}

// Abre o login do Spotify no navegador; o código volta em /callback
function conectarSpotify() {
  if (!credenciaisOk()) {
    dialog.showErrorBox('Spotify', 'Cole o Client ID e o Client Secret nas constantes no topo de src/main.js.')
    return
  }
  iniciarServidorOAuth()
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
  if (oauthServer) return
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

    carregarTokens()
    iniciarMidiaWindows()
    if (refreshToken) iniciarPolling()
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
    if (cursorTimer) clearTimeout(cursorTimer)
    if (progressoAgendado) clearTimeout(progressoAgendado)
    shutdown().catch(() => {})
  })
}
