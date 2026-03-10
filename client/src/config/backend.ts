const normalizedEnvBackendUrl = (import.meta.env.VITE_BACKEND_URL || "")
    .trim()
    .replace(/\/+$/, "")

const devProtocol = window.location.protocol === "https:" ? "https:" : "http:"
const devHostName = window.location.hostname || "localhost"
const fallbackBackendUrl = import.meta.env.DEV
    ? `${devProtocol}//${devHostName}:3000`
    : window.location.origin

const BACKEND_URL = normalizedEnvBackendUrl || fallbackBackendUrl

export { BACKEND_URL }
