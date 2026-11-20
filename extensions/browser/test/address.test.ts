// What's typed in the address bar, as where to go: a web address as it is, a bare host given its scheme (plain http on
// this computer and its network), an HTML file's path in the working folder, anything else a search.
import { describe, expect, it } from 'vitest'
import { asksFirst, destination, isLocalHost, webAddress } from '../src/address.ts'

describe('the address bar', () => {
  it('goes to a web address as it is', () => {
    expect(destination('https://example.com/a?b=1#c')).toEqual({ url: 'https://example.com/a?b=1#c' })
    expect(destination('  http://localhost:5173/  ')).toEqual({ url: 'http://localhost:5173/' })
    expect(destination('HTTPS://Example.com')).toEqual({ url: 'HTTPS://Example.com' })
  })

  it('gives a bare host https, or http on this computer and its network', () => {
    expect(destination('example.com')).toEqual({ url: 'https://example.com' })
    expect(destination('docs.example.co.uk/guide?x=1')).toEqual({ url: 'https://docs.example.co.uk/guide?x=1' })
    expect(destination('example.com:8443/a')).toEqual({ url: 'https://example.com:8443/a' })
    expect(destination('8.8.8.8')).toEqual({ url: 'https://8.8.8.8' })
    expect(destination('localhost:5173')).toEqual({ url: 'http://localhost:5173' })
    expect(destination('localhost')).toEqual({ url: 'http://localhost' })
    expect(destination('127.0.0.1:3000/as/me')).toEqual({ url: 'http://127.0.0.1:3000/as/me' })
    expect(destination('[::1]:3000')).toEqual({ url: 'http://[::1]:3000' })
    expect(destination('192.168.1.20:8080')).toEqual({ url: 'http://192.168.1.20:8080' })
    expect(destination('10.0.0.5')).toEqual({ url: 'http://10.0.0.5' })
    expect(destination('app.localhost:3000')).toEqual({ url: 'http://app.localhost:3000' })
    expect(destination('printer.local')).toEqual({ url: 'http://printer.local' })
    // A machine on the network, by its name and a port.
    expect(destination('workbox:5173')).toEqual({ url: 'http://workbox:5173' })
  })

  it('opens an HTML file in the working folder by its path', () => {
    expect(destination('report.html')).toEqual({ path: 'report.html' })
    expect(destination('./docs/page.htm')).toEqual({ path: 'docs/page.htm' })
    expect(destination('out/v1.2/index.html')).toEqual({ path: 'out/v1.2/index.html' })
    // A host's page is a web page.
    expect(destination('example.com/index.html')).toEqual({ url: 'https://example.com/index.html' })
  })

  it('searches for anything else, with the engine set', () => {
    expect(destination('how do frames work')).toEqual({ url: 'https://duckduckgo.com/?q=how%20do%20frames%20work' })
    expect(destination('superego', 'google')).toEqual({ url: 'https://www.google.com/search?q=superego' })
    expect(destination('c++ & rust')).toEqual({ url: 'https://duckduckgo.com/?q=c%2B%2B%20%26%20rust' })
    // One word that isn't a host's name: no dot, or no top-level domain after it.
    expect(destination('superego')).toEqual({ url: 'https://duckduckgo.com/?q=superego' })
    expect(destination('v1.2')).toEqual({ url: 'https://duckduckgo.com/?q=v1.2' })
    expect(destination('mailto:me@example.com')).toEqual({ url: 'https://duckduckgo.com/?q=mailto%3Ame%40example.com' })
  })

  it('goes nowhere for nothing typed', () => {
    expect(destination('')).toBeUndefined()
    expect(destination('   ')).toBeUndefined()
  })

  it('reads a web address from a bare one, and nothing else', () => {
    expect(webAddress('localhost:3000')).toBe('http://localhost:3000')
    expect(webAddress('example.com')).toBe('https://example.com')
    expect(webAddress('two words')).toBeUndefined()
    expect(webAddress('report')).toBeUndefined()
  })

  it('knows this computer and its network', () => {
    for (const host of ['localhost', 'LOCALHOST', 'x.localhost', '127.0.0.1', '[::1]', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', 'nas.local']) expect(isLocalHost(host)).toBe(true)
    for (const host of ['example.com', '172.32.0.1', '8.8.8.8', 'localhost.example.com']) expect(isLocalHost(host)).toBe(false)
  })
})

describe("a page the agent opened", () => {
  it('waits for the user beyond this computer and its network', () => {
    for (const url of ['https://example.com/?d=x', 'http://8.8.8.8/', 'https://workbox.tail1ffbc8.ts.net/', 'http://localhost.example.com/', 'http://127.0.0.1.nip.io/', 'http://[2001:db8::1]/', 'ftp://example.com/', 'nonsense']) {
      expect(asksFirst(url), url).toBe(true)
    }
  })

  it('loads at once here or near: localhost, private addresses, .local, a one-part name', () => {
    for (const url of ['http://localhost:5173/', 'http://app.localhost/', 'http://127.0.0.1:3000/', 'http://[::1]:8080/', 'http://10.0.0.2/', 'http://192.168.1.4:8000/', 'http://printer.local/', 'http://workbox:5173/']) {
      expect(asksFirst(url), url).toBe(false)
    }
  })
})
