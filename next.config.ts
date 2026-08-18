import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Baileys, pg and the proxy agent are native-ish server libraries: let Node
  // require them directly instead of putting them through the bundler.
  serverExternalPackages: ['@whiskeysockets/baileys', 'pg', 'qrcode', 'socks-proxy-agent'],
}

export default nextConfig
