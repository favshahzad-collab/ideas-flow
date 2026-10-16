import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite";

/*
 * Where the dev server sends `/api`. An override rather than a constant
 * because the only way to look at this UI against anything but the live
 * local database was to edit this file — and a file edited to take a look is
 * a file somebody forgets to edit back.
 */
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:3000'

/*
 * The server names people may type to reach `vite preview`, comma-separated:
 * PREVIEW_ALLOWED_HOSTS=ids-it-shahzad,ids-it-shahzad.ideas.local
 * Vite answers only to localhost and IP addresses unless told otherwise (its
 * guard against DNS rebinding), so opening the app by the server's name is
 * refused until the name is listed here. Unset keeps Vite's default.
 */
const PREVIEW_ALLOWED_HOSTS = process.env.PREVIEW_ALLOWED_HOSTS
  ?.split(',')
  .map((host) => host.trim())
  .filter(Boolean)

/*
 * HTTPS for `vite preview`, from certificate files on the server:
 *
 *   PREVIEW_HTTPS_CERT=D:/DAWS/cert/flow.ideas.com.pk-chain.pem
 *   PREVIEW_HTTPS_KEY=D:/DAWS/cert/flow.ideas.com.pk-key.pem
 *
 * or a single .pfx:  PREVIEW_HTTPS_PFX=...  (PREVIEW_HTTPS_PASSPHRASE if it has one)
 *
 * Needed for more than privacy: Microsoft sends people back from signing in
 * only to an https address (plain http is allowed for localhost alone), so
 * single sign-on cannot work without it - and without it every password and
 * confirmation crosses the network readable.
 *
 * Read once, at start: a renewed certificate takes effect on the next
 * `pm2 restart daws-web`. A path that is set but unreadable stops the server
 * rather than quietly serving plain http on the address people were told is
 * secure. Unset, nothing changes.
 */
function previewHttps() {
  const read = (variable: string) => {
    const file = process.env[variable]?.trim()
    if (!file) return undefined
    try {
      return readFileSync(file)
    } catch (error) {
      throw new Error(`${variable} is set to "${file}", which cannot be read: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  const pfx = read('PREVIEW_HTTPS_PFX')
  if (pfx) return { pfx, passphrase: process.env.PREVIEW_HTTPS_PASSPHRASE || undefined }

  const cert = read('PREVIEW_HTTPS_CERT')
  const key = read('PREVIEW_HTTPS_KEY')
  if (cert && key) return { cert, key }
  if (cert || key) {
    throw new Error('Set both PREVIEW_HTTPS_CERT and PREVIEW_HTTPS_KEY, or neither.')
  }
  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(),
  ],
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        // Tell the API who the visitor is. Without it every request arrives
        // from this proxy's own address, so the audit trail records
        // 127.0.0.1 for everybody and the sign-in limit counts the whole
        // organisation as one person. Pairs with TRUST_PROXY=1 on the API.
        xfwd: true,
      },
    },
  },
  // `vite preview` serves the real production bundle. Without the same proxy
  // it cannot reach the API, so the build could only ever be smoke-tested
  // against dev — which is also the build where StrictMode double-fires
  // effects, hiding what request traffic actually looks like in production.
  preview: {
    allowedHosts: PREVIEW_ALLOWED_HOSTS,
    https: previewHttps(),
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        // Tell the API who the visitor is. Without it every request arrives
        // from this proxy's own address, so the audit trail records
        // 127.0.0.1 for everybody and the sign-in limit counts the whole
        // organisation as one person. Pairs with TRUST_PROXY=1 on the API.
        xfwd: true,
      },
    },
  },
})


