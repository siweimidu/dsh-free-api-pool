/**
 * Renders the real client.js against the REAL host half and the REAL vault (162 keys),
 * so load time and readability are measured against the data the user actually has.
 * The host half is booted in-process with a stub `webServer.register`; /dsh-free-pool/*
 * is proxied to it. No probing happens on open, so this measures the panel, not the network.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'

const PLUGIN = 'C:/Users/35238/.dsh/profiles/desktop/dsh-free-api-pool'
const REACT = 'C:/Users/35238/.dsh/profiles/node_modules/react/umd/react.development.js'
const REACT_DOM = 'C:/Users/35238/.dsh/profiles/node_modules/react-dom/umd/react-dom.development.js'

// The harness must never mutate the user's real vault: run against a scratch copy.
import { copyFileSync, existsSync } from 'node:fs'
const SCRATCH = PLUGIN + '/test/.scratch-vault.json'
if (existsSync(PLUGIN + '/data/vault.json')) copyFileSync(PLUGIN + '/data/vault.json', SCRATCH)
process.env.DFP_VAULT_FILE = SCRATCH

const mod = await import('file:///' + PLUGIN + '/lib/index.js?t=' + Date.now())
let handler = null
mod.apply(
  { inject: (deps, fn) => fn({ webServer: { register: (r) => { handler = r.handler; return () => {} } }, effect: () => {} }) },
  { credentialsFile: 'C:/Users/35238/Documents/夸克密码.csv' },
)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(PLUGIN + '/test/harness.html')); return }
  if (p === '/react.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(REACT)); return }
  if (p === '/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(REACT_DOM)); return }
  if (p === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(PLUGIN + '/lib/client.js')); return }
  if (p.startsWith('/dsh-free-pool/')) { handler(req, res); return }
  res.writeHead(404); res.end('nope')
})

const port = Number(process.env.PORT || 8792)
server.listen(port, '127.0.0.1', () => console.log('real harness on http://127.0.0.1:' + port))
