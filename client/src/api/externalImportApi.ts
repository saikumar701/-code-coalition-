import { BACKEND_URL } from "@/config/backend"

type OAuthProvider = "github" | "gdrive"

interface ExternalImportResult {
    provider: "github" | "gdrive" | "direct"
    fileName: string
    mimeType: string
    size: number
    isLikelyText: boolean
    textContent: string
    base64Content: string | null
}

interface ExternalImportOptions {
    driveAccessToken?: string
    githubAccessToken?: string
}

interface OAuthStartResponse {
    provider: OAuthProvider
    authorizeUrl: string
}

interface GithubRepo {
    id: number
    name: string
    full_name: string
    private: boolean
    owner: {
        login: string
    }
    default_branch: string
}

interface GithubEntry {
    name: string
    path: string
    type: "file" | "dir"
    size?: number
    download_url?: string | null
    sha?: string
    url: string
}

interface AccountImportPayload {
    fileName: string
    mimeType: string
    content: string
    contentEncoding: "utf8" | "base64"
    size: number
}

interface GithubFolderImportEntry {
    relativePath: string
    payload: AccountImportPayload
}

interface GoogleDriveEntry {
    id: string
    name: string
    mimeType: string
    size?: string
    modifiedTime?: string
}

const textMimePattern =
    /^(text\/|application\/(json|javascript|typescript|xml|x-www-form-urlencoded)|image\/svg\+xml)/i

const toBase64 = (bytes: Uint8Array): string => {
    let binary = ""
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize)
        binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
}

const normalizeGithubPath = (value: string): string =>
    value
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/")

const ensureResponseOk = async (
    response: Response,
    fallbackMessage: string,
): Promise<void> => {
    if (response.ok) return

    const payload = await response.json().catch(() => null)
    const message =
        typeof payload?.error === "string"
            ? payload.error
            : typeof payload?.message === "string"
                ? payload.message
                : fallbackMessage
    throw new Error(`${message} (status ${response.status})`)
}

const importExternalFile = async (
    url: string,
    options?: ExternalImportOptions,
): Promise<ExternalImportResult> => {
    const response = await fetch(`${BACKEND_URL}/api/import/external`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            url,
            driveAccessToken: options?.driveAccessToken || "",
            githubAccessToken: options?.githubAccessToken || "",
        }),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
        const message =
            typeof payload?.error === "string"
                ? payload.error
                : "Failed to import file from external source."
        throw new Error(message)
    }

    return payload as ExternalImportResult
}

const getOAuthAuthorizeUrl = async (provider: OAuthProvider): Promise<string> => {
    const origin = window.location.origin
    const response = await fetch(
        `${BACKEND_URL}/api/oauth/${provider}/start?origin=${encodeURIComponent(origin)}`,
    )
    await ensureResponseOk(response, `Failed to start ${provider} OAuth.`)
    const payload = (await response.json()) as OAuthStartResponse
    return payload.authorizeUrl
}

const fetchGithubRepos = async (accessToken: string): Promise<GithubRepo[]> => {
    const response = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
        },
    })
    await ensureResponseOk(response, "Failed to fetch GitHub repositories.")
    return (await response.json()) as GithubRepo[]
}

const fetchGithubDirectoryEntries = async ({
    accessToken,
    owner,
    repo,
    path = "",
    branch,
}: {
    accessToken: string
    owner: string
    repo: string
    path?: string
    branch: string
}): Promise<GithubEntry[]> => {
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/")
    const endpoint = encodedPath
        ? `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
        : `https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`
    const response = await fetch(endpoint, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
        },
    })
    await ensureResponseOk(response, "Failed to fetch repository files.")
    const payload = await response.json()
    return (Array.isArray(payload) ? payload : [payload]) as GithubEntry[]
}

const fetchGithubFileContent = async ({
    accessToken,
    owner,
    repo,
    path,
    branch,
}: {
    accessToken: string
    owner: string
    repo: string
    path: string
    branch: string
}): Promise<AccountImportPayload> => {
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/")
    const endpoint = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    const response = await fetch(endpoint, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
        },
    })
    await ensureResponseOk(response, "Failed to fetch file content from GitHub.")
    const payload = await response.json()

    const fileName = String(payload?.name || path.split("/").pop() || "github-file")
    const mimeType = textMimePattern.test(String(payload?.type || ""))
        ? "text/plain"
        : "application/octet-stream"

    if (typeof payload?.content === "string" && payload.content.length > 0) {
        const normalizedBase64 = payload.content.replace(/\n/g, "")
        const decoder = new TextDecoder("utf-8", { fatal: false })
        const bytes = Uint8Array.from(atob(normalizedBase64), (char) => char.charCodeAt(0))
        const textContent = decoder.decode(bytes)
        const hasNullByte = bytes.includes(0)

        if (!hasNullByte) {
            return {
                fileName,
                mimeType: "text/plain",
                content: textContent,
                contentEncoding: "utf8",
                size: bytes.byteLength,
            }
        }

        return {
            fileName,
            mimeType,
            content: normalizedBase64,
            contentEncoding: "base64",
            size: bytes.byteLength,
        }
    }

    const downloadUrl = typeof payload?.download_url === "string" ? payload.download_url : ""
    if (!downloadUrl) {
        throw new Error("Unable to read this GitHub file.")
    }

    const rawResponse = await fetch(downloadUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })
    await ensureResponseOk(rawResponse, "Failed to download this GitHub file.")
    const mime = rawResponse.headers.get("content-type") || "application/octet-stream"
    const arrayBuffer = await rawResponse.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const looksText = textMimePattern.test(mime) && !bytes.includes(0)

    if (looksText) {
        const textContent = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
        return {
            fileName,
            mimeType: mime,
            content: textContent,
            contentEncoding: "utf8",
            size: bytes.byteLength,
        }
    }

    const base64 = toBase64(bytes)
    return {
        fileName,
        mimeType: mime,
        content: base64,
        contentEncoding: "base64",
        size: bytes.byteLength,
    }
}

const fetchDriveFiles = async (accessToken: string): Promise<GoogleDriveEntry[]> => {
    const endpoint =
        "https://www.googleapis.com/drive/v3/files?pageSize=100&q=trashed=false&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc"
    const response = await fetch(endpoint, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })
    await ensureResponseOk(response, "Failed to fetch Google Drive files.")
    const payload = await response.json()
    return (payload?.files || []) as GoogleDriveEntry[]
}

const fetchDriveFileContent = async ({
    accessToken,
    fileId,
    fileName,
    mimeType,
}: {
    accessToken: string
    fileId: string
    fileName: string
    mimeType: string
}): Promise<AccountImportPayload> => {
    const isGoogleWorkspaceFile = mimeType.startsWith("application/vnd.google-apps.")
    let downloadResponse: Response

    if (isGoogleWorkspaceFile) {
        const exportMime =
            mimeType === "application/vnd.google-apps.spreadsheet"
                ? "text/csv"
                : mimeType === "application/vnd.google-apps.presentation"
                    ? "application/pdf"
                    : "text/plain"
        const exportEndpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
        downloadResponse = await fetch(exportEndpoint, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })
    } else {
        const downloadEndpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
        downloadResponse = await fetch(downloadEndpoint, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })
    }

    await ensureResponseOk(downloadResponse, "Failed to download Google Drive file.")
    const responseMimeType = downloadResponse.headers.get("content-type") || mimeType
    const arrayBuffer = await downloadResponse.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const looksText = textMimePattern.test(responseMimeType) && !bytes.includes(0)

    if (looksText) {
        return {
            fileName,
            mimeType: responseMimeType,
            content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
            contentEncoding: "utf8",
            size: bytes.byteLength,
        }
    }

    const base64 = toBase64(bytes)
    return {
        fileName,
        mimeType: responseMimeType,
        content: base64,
        contentEncoding: "base64",
        size: bytes.byteLength,
    }
}

const fetchGithubFolderFiles = async ({
    accessToken,
    owner,
    repo,
    path = "",
    branch,
    maxFiles = 400,
}: {
    accessToken: string
    owner: string
    repo: string
    path?: string
    branch: string
    maxFiles?: number
}): Promise<GithubFolderImportEntry[]> => {
    const basePath = normalizeGithubPath(path)
    const pendingDirectories: string[] = [basePath]
    const importedFiles: GithubFolderImportEntry[] = []

    while (pendingDirectories.length > 0) {
        const currentPath = pendingDirectories.shift() || ""
        const entries = await fetchGithubDirectoryEntries({
            accessToken,
            owner,
            repo,
            path: currentPath,
            branch,
        })

        for (const entry of entries) {
            if (entry.type === "dir") {
                pendingDirectories.push(normalizeGithubPath(entry.path))
                continue
            }

            if (entry.type !== "file") {
                continue
            }

            if (importedFiles.length >= maxFiles) {
                throw new Error(
                    `This import has more than ${maxFiles} files. Import a smaller folder.`,
                )
            }

            const payload = await fetchGithubFileContent({
                accessToken,
                owner,
                repo,
                path: entry.path,
                branch,
            })

            const normalizedEntryPath = normalizeGithubPath(entry.path)
            const relativePath = basePath
                ? normalizedEntryPath.startsWith(`${basePath}/`)
                    ? normalizedEntryPath.slice(basePath.length + 1)
                    : payload.fileName
                : normalizedEntryPath

            importedFiles.push({
                relativePath: normalizeGithubPath(relativePath) || payload.fileName,
                payload,
            })
        }
    }

    return importedFiles
}

export type {
    ExternalImportOptions,
    AccountImportPayload,
    ExternalImportResult,
    GithubFolderImportEntry,
    GithubEntry,
    GithubRepo,
    GoogleDriveEntry,
    OAuthProvider,
}
export {
    fetchDriveFileContent,
    fetchDriveFiles,
    fetchGithubDirectoryEntries,
    fetchGithubFileContent,
    fetchGithubFolderFiles,
    fetchGithubRepos,
    getOAuthAuthorizeUrl,
    importExternalFile,
}
