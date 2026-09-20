import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

import siteConfiguration from './.figma/make/site.json'

/**
 * HTTPS for LAN testing.
 *
 * Opt-in via DEV_HTTPS=1 (see `npm run dev:lan`) so the Figma Make harness,
 * which runs plain `pnpm run dev`, keeps serving HTTP as before. Needed because
 * getUserMedia only works in a secure context, and a LAN IP is not one.
 */
function devHttps() {
  if (process.env.DEV_HTTPS !== '1') return undefined

  const key = path.resolve(__dirname, 'certs/dev-key.pem')
  const cert = path.resolve(__dirname, 'certs/dev-cert.pem')

  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    throw new Error('DEV_HTTPS=1 but certs/ is missing. Run: npm run cert')
  }

  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
}

export default defineConfig(({ mode }) => {
  const emitSourcemaps = mode === 'development'
  const https = devHttps()

  return {
    // Frontend source lives in frontend/; the backend is a separate tree that
    // Vite never sees. This config stays at the repo root because the Figma
    // Make harness runs `pnpm run dev` / `pnpm run build` from here and
    // deploys the root-level dist/.
    root: path.resolve(__dirname, 'frontend'),
    publicDir: path.resolve(__dirname, 'frontend/public'),
    base: process.env.FIGMA_PUBLIC_URL ? `${process.env.FIGMA_PUBLIC_URL}/` : '/',
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      sourcemap: emitSourcemaps ? 'inline' : false,
      minify: !emitSourcemaps,
    },
    plugins: [
      react(),
      tailwindcss(),
      figmaSiteConfiguration(siteConfiguration),
      figmaErrorOverlayReplay(),
      figmaReactRefreshBoundaryFallback(),
      figmaMakeKitPlugin({ storiesGlob: '/src/**/*.stories.{ts,tsx,js,jsx}' }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './frontend/src'),
      },
    },
    server: {
      host: process.env.FIGMA_DEV_SERVER_HOST || '0.0.0.0',
      port: parseInt(process.env.PORT || '8443'),
      strictPort: true,
      https,
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
          // Keep the browser's Host, and tell the API which scheme the browser
          // actually used, so links it generates (patient join URLs) point back
          // at the address the staff member is really browsing rather than at
          // the API's own localhost.
          changeOrigin: false,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq: any, req: any) => {
              proxyReq.setHeader('x-forwarded-proto', https ? 'https' : 'http')
              if (req.headers.host) proxyReq.setHeader('x-forwarded-host', req.headers.host)
            })
          },
        },
        // Signaling runs over the same origin as the app, so the browser never
        // has to deal with cross-origin WebSockets or CORS preflights.
        '/ws': {
          target: 'ws://localhost:4000',
          ws: true,
          changeOrigin: false,
        },
      },
      watch: {
        ignored: ['**/.figma/**'],
      },
    },
    preview: {
      host: process.env.FIGMA_DEV_SERVER_HOST || '0.0.0.0',
      port: parseInt(process.env.PORT || '8443'),
    },
  }
})

function figmaSiteConfiguration(config: any): Plugin {
  return {
    name: 'figma-site-configuration',
    configureServer(server) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.url?.split('?')[0] !== '/robots.txt') return next()
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('User-agent: *\nAllow: /\n')
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return {
          html,
          tags: [
            { tag: 'meta', attrs: { name: 'description', content: config.description || 'Clinic website' }, injectTo: 'head' },
          ],
        }
      },
    },
  }
}

function figmaErrorOverlayReplay(): Plugin {
  return {
    name: 'figma-error-overlay-replay',
  }
}

function figmaReactRefreshBoundaryFallback(): Plugin {
  return {
    name: 'figma-react-refresh-boundary-fallback',
  }
}

function figmaMakeKitPlugin(_options: any): Plugin {
  return {
    name: 'figma-make-kit-plugin',
  }
}
