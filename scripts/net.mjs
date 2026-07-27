import dns from 'node:dns'

import { ProxyAgent, setGlobalDispatcher } from 'undici'

/*
 * Network setup shared by the fetching scripts.
 *
 * Node's built-in `fetch` ignores HTTP_PROXY / HTTPS_PROXY. Every other tool on the machine
 * honours them, so on a proxied network the symptom is not a clean failure but intermittent
 * ECONNRESET and connect timeouts on the larger downloads -- which looks exactly like a bad
 * connection and invites piling on retries that can't help.
 *
 * Node 22 added `NODE_USE_ENV_PROXY`; until then the proxy has to be wired up explicitly.
 */

const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy

export function configureNetwork() {
  // Node 20 prefers AAAA records; githubusercontent's IPv6 hangs on some networks.
  dns.setDefaultResultOrder('ipv4first')

  if (!PROXY) return
  setGlobalDispatcher(new ProxyAgent(PROXY))
  console.log(`using proxy ${PROXY}`)
}
