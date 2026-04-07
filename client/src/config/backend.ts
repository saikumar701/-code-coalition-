const normalizedEnvBackendUrl = (import.meta.env.VITE_BACKEND_URL || "")
    .trim()
    .replace(/\/+$/, "")

const devProtocol = window.location.protocol === "https:" ? "https:" : "http:"
const devHostName = window.location.hostname || "localhost"
// Default backend for production builds when VITE_BACKEND_URL is not set.
// Keep this in sync with your deployed API base URL.
const productionDefaultUrl = "https://code-coalition-1.onrender.com"
const fallbackBackendUrl = import.meta.env.DEV
    ? `${devProtocol}//${devHostName}:3000`
    : productionDefaultUrl

const BACKEND_URL = normalizedEnvBackendUrl || fallbackBackendUrl

export { BACKEND_URL }
