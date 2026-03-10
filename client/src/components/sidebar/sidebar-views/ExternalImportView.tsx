import {
    AccountImportPayload,
    fetchDriveFileContent,
    fetchDriveFiles,
    fetchGithubDirectoryEntries,
    fetchGithubFileContent,
    fetchGithubFolderFiles,
    fetchGithubRepos,
    GithubFolderImportEntry,
    getOAuthAuthorizeUrl,
    GoogleDriveEntry,
    GithubEntry,
    GithubRepo,
    importExternalFile,
    OAuthProvider,
} from "@/api/externalImportApi"
import { BACKEND_URL } from "@/config/backend"
import { useFileSystem } from "@/context/FileContext"
import useResponsive from "@/hooks/useResponsive"
import { FileSystemItem } from "@/types/file"
import { useEffect, useMemo, useState } from "react"
import toast from "react-hot-toast"
import { SiGithub, SiGoogledrive } from "react-icons/si"

interface OAuthPopupMessage {
    type: "oauth-success" | "oauth-error"
    provider: OAuthProvider
    accessToken?: string
    error?: string
}

const oauthTokensStorageKey = "external-import-oauth-tokens-v1"
const oauthProviderStorageKey = "external-import-provider-v1"

const normalizePath = (value: string): string =>
    value
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/")

const readStoredOauthTokens = (): Partial<Record<OAuthProvider, string>> => {
    try {
        const raw = localStorage.getItem(oauthTokensStorageKey)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Partial<Record<OAuthProvider, unknown>>
        const tokens: Partial<Record<OAuthProvider, string>> = {}
        if (typeof parsed.github === "string" && parsed.github.trim()) {
            tokens.github = parsed.github.trim()
        }
        if (typeof parsed.gdrive === "string" && parsed.gdrive.trim()) {
            tokens.gdrive = parsed.gdrive.trim()
        }
        return tokens
    } catch {
        return {}
    }
}

const readStoredProvider = (): OAuthProvider => {
    try {
        const raw = (localStorage.getItem(oauthProviderStorageKey) || "").trim()
        return raw === "github" ? "github" : "gdrive"
    } catch {
        return "gdrive"
    }
}

const buildDirectoryPathIndex = (
    node: FileSystemItem,
    parentPath = "",
    index = new Map<string, string>(),
): Map<string, string> => {
    if (node.type !== "directory") return index

    const currentPath = normalizePath(parentPath)
    index.set(currentPath, node.id)

    ;(node.children || []).forEach((child) => {
        if (child.type !== "directory") return
        const childPath = normalizePath(
            currentPath ? `${currentPath}/${child.name}` : child.name,
        )
        buildDirectoryPathIndex(child, childPath, index)
    })

    return index
}

const ExternalImportView = () => {
    const { viewHeight } = useResponsive()
    const { fileStructure, createDirectory, importFile } = useFileSystem()
    const [activeMode, setActiveMode] = useState<"link" | "account">("link")
    const [externalUrl, setExternalUrl] = useState("")
    const [isImporting, setIsImporting] = useState(false)
    const [lastImportedName, setLastImportedName] = useState<string | null>(null)
    const [oauthTokens, setOauthTokens] = useState<Partial<Record<OAuthProvider, string>>>(
        () => readStoredOauthTokens(),
    )
    const [activeAccountProvider, setActiveAccountProvider] = useState<OAuthProvider>(() =>
        readStoredProvider(),
    )

    const [driveFiles, setDriveFiles] = useState<GoogleDriveEntry[]>([])
    const [isLoadingDriveFiles, setIsLoadingDriveFiles] = useState(false)

    const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([])
    const [selectedGithubRepo, setSelectedGithubRepo] = useState<GithubRepo | null>(null)
    const [githubPath, setGithubPath] = useState("")
    const [githubEntries, setGithubEntries] = useState<GithubEntry[]>([])
    const [isLoadingGithubRepos, setIsLoadingGithubRepos] = useState(false)
    const [isLoadingGithubEntries, setIsLoadingGithubEntries] = useState(false)

    const backendOrigin = useMemo(() => {
        try {
            return new URL(BACKEND_URL).origin
        } catch {
            return window.location.origin
        }
    }, [])

    const handleImportedPayload = (
        payload: AccountImportPayload,
        parentDirId = fileStructure.id,
    ) => {
        importFile(parentDirId, payload.fileName, payload.content, true, {
            contentEncoding: payload.contentEncoding,
            mimeType: payload.mimeType,
            openInEditor: true,
        })
        setLastImportedName(payload.fileName)
        toast.success(`${payload.fileName} imported to Explorer`)
    }

    const importGithubPayloads = (
        files: GithubFolderImportEntry[],
        rootFolderName: string,
    ) => {
        const normalizedRootFolderName = rootFolderName.trim() || "github-import"
        const directoryIndex = buildDirectoryPathIndex(fileStructure)
        let openedFirstFile = false

        const ensureDirectory = (segments: string[]): string => {
            let currentPath = ""
            let parentId = fileStructure.id

            segments.forEach((segmentValue) => {
                const segment = segmentValue.trim()
                if (!segment) return

                currentPath = normalizePath(
                    currentPath ? `${currentPath}/${segment}` : segment,
                )
                const existingId = directoryIndex.get(currentPath)
                if (existingId) {
                    parentId = existingId
                    return
                }

                const createdId = createDirectory(parentId, segment)
                directoryIndex.set(currentPath, createdId)
                parentId = createdId
            })

            return parentId
        }

        files.forEach((importedFile) => {
            const normalizedRelativePath = normalizePath(
                importedFile.relativePath || importedFile.payload.fileName,
            )
            const pathSegments = normalizedRelativePath.split("/").filter(Boolean)
            const fileName =
                pathSegments.pop() || importedFile.payload.fileName || `file-${Date.now()}`
            const parentDirectoryId = ensureDirectory([
                normalizedRootFolderName,
                ...pathSegments,
            ])

            const importedId = importFile(
                parentDirectoryId,
                fileName,
                importedFile.payload.content,
                true,
                {
                    contentEncoding: importedFile.payload.contentEncoding,
                    mimeType: importedFile.payload.mimeType,
                    openInEditor: !openedFirstFile,
                },
            )
            if (!openedFirstFile && importedId) {
                openedFirstFile = true
            }
        })

        setLastImportedName(normalizedRootFolderName)
    }

    const handleLinkImport = async () => {
        const trimmedUrl = externalUrl.trim()
        if (!trimmedUrl) {
            toast.error("Paste a direct file URL")
            return
        }

        try {
            setIsImporting(true)
            const importedResource = await importExternalFile(trimmedUrl, {
                driveAccessToken: oauthTokens.gdrive || "",
                githubAccessToken: oauthTokens.github || "",
            })
            const payload: AccountImportPayload = importedResource.isLikelyText
                ? {
                      fileName: importedResource.fileName,
                      mimeType: importedResource.mimeType,
                      content: importedResource.textContent,
                      contentEncoding: "utf8",
                      size: importedResource.size,
                  }
                : {
                      fileName: importedResource.fileName,
                      mimeType: importedResource.mimeType,
                      content: importedResource.base64Content || "",
                      contentEncoding: "base64",
                      size: importedResource.size,
                  }

            handleImportedPayload(payload)
            setExternalUrl("")
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to import external file."
            toast.error(message)
        } finally {
            setIsImporting(false)
        }
    }

    const startProviderLogin = async (provider: OAuthProvider) => {
        try {
            const authorizeUrl = await getOAuthAuthorizeUrl(provider)
            const popup = window.open(
                authorizeUrl,
                `${provider}-oauth`,
                "width=620,height=760,menubar=no,toolbar=no,status=no",
            )
            if (!popup) {
                toast.error("Popup blocked. Allow popups to continue login.")
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to start OAuth login."
            toast.error(message)
        }
    }

    const fetchDriveFileList = async (token: string) => {
        try {
            setIsLoadingDriveFiles(true)
            const files = await fetchDriveFiles(token)
            setDriveFiles(files)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to load Google Drive files."
            if (/401|unauthorized|invalid credentials/i.test(message)) {
                setOauthTokens((prevTokens) => ({ ...prevTokens, gdrive: "" }))
                toast.error("Google Drive session expired. Please login again.")
                return
            }
            toast.error(message)
        } finally {
            setIsLoadingDriveFiles(false)
        }
    }

    const fetchGithubRepoList = async (token: string) => {
        try {
            setIsLoadingGithubRepos(true)
            const repos = await fetchGithubRepos(token)
            setGithubRepos(repos)
            if (!selectedGithubRepo && repos.length > 0) {
                setSelectedGithubRepo(repos[0])
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to load GitHub repositories."
            if (/401|unauthorized|invalid credentials/i.test(message)) {
                setOauthTokens((prevTokens) => ({ ...prevTokens, github: "" }))
                toast.error("GitHub session expired. Please login again.")
                return
            }
            toast.error(message)
        } finally {
            setIsLoadingGithubRepos(false)
        }
    }

    const fetchGithubFolderEntries = async ({
        token,
        repo,
        path = "",
    }: {
        token: string
        repo: GithubRepo
        path?: string
    }) => {
        try {
            setIsLoadingGithubEntries(true)
            const entries = await fetchGithubDirectoryEntries({
                accessToken: token,
                owner: repo.owner.login,
                repo: repo.name,
                path,
                branch: repo.default_branch,
            })
            const sortedEntries = [...entries].sort((left, right) => {
                if (left.type !== right.type) {
                    return left.type === "dir" ? -1 : 1
                }
                return left.name.localeCompare(right.name)
            })
            setGithubEntries(sortedEntries)
            setGithubPath(path)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to load repository entries."
            toast.error(message)
        } finally {
            setIsLoadingGithubEntries(false)
        }
    }

    useEffect(() => {
        const handleOAuthMessage = (event: MessageEvent<OAuthPopupMessage>) => {
            if (event.origin !== backendOrigin) return
            const payload = event.data
            if (!payload || !payload.provider || !payload.type) return

            if (payload.type === "oauth-error") {
                toast.error(payload.error || "OAuth login failed.")
                return
            }

            if (!payload.accessToken) {
                toast.error("OAuth login returned no access token.")
                return
            }

            setOauthTokens((prevTokens) => ({
                ...prevTokens,
                [payload.provider]: payload.accessToken,
            }))
            setActiveAccountProvider(payload.provider)
            toast.success(
                payload.provider === "github"
                    ? "Logged in to GitHub"
                    : "Logged in to Google Drive",
            )
        }

        window.addEventListener("message", handleOAuthMessage)
        return () => {
            window.removeEventListener("message", handleOAuthMessage)
        }
    }, [backendOrigin])

    useEffect(() => {
        try {
            localStorage.setItem(oauthTokensStorageKey, JSON.stringify(oauthTokens))
        } catch {
            // Ignore storage write failures.
        }
    }, [oauthTokens])

    useEffect(() => {
        try {
            localStorage.setItem(oauthProviderStorageKey, activeAccountProvider)
        } catch {
            // Ignore storage write failures.
        }
    }, [activeAccountProvider])

    useEffect(() => {
        const driveToken = oauthTokens.gdrive
        if (!driveToken) return
        void fetchDriveFileList(driveToken)
    }, [oauthTokens.gdrive])

    useEffect(() => {
        const githubToken = oauthTokens.github
        if (!githubToken) return
        void fetchGithubRepoList(githubToken)
    }, [oauthTokens.github])

    useEffect(() => {
        if (!oauthTokens.github || !selectedGithubRepo) return
        void fetchGithubFolderEntries({
            token: oauthTokens.github,
            repo: selectedGithubRepo,
            path: "",
        })
    }, [oauthTokens.github, selectedGithubRepo])

    const handleImportDriveFile = async (file: GoogleDriveEntry) => {
        const token = oauthTokens.gdrive
        if (!token) {
            toast.error("Login to Google Drive first.")
            return
        }

        try {
            setIsImporting(true)
            const payload = await fetchDriveFileContent({
                accessToken: token,
                fileId: file.id,
                fileName: file.name,
                mimeType: file.mimeType,
            })
            handleImportedPayload(payload)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to import Drive file."
            toast.error(message)
        } finally {
            setIsImporting(false)
        }
    }

    const handleImportGithubFile = async (entry: GithubEntry) => {
        const token = oauthTokens.github
        if (!token || !selectedGithubRepo) {
            toast.error("Login to GitHub and select a repository first.")
            return
        }

        try {
            setIsImporting(true)
            const payload = await fetchGithubFileContent({
                accessToken: token,
                owner: selectedGithubRepo.owner.login,
                repo: selectedGithubRepo.name,
                path: entry.path,
                branch: selectedGithubRepo.default_branch,
            })
            handleImportedPayload(payload)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to import GitHub file."
            toast.error(message)
        } finally {
            setIsImporting(false)
        }
    }

    const handleImportGithubFolder = async ({
        importPath,
        importWholeRepo = false,
    }: {
        importPath: string
        importWholeRepo?: boolean
    }) => {
        const token = oauthTokens.github
        if (!token || !selectedGithubRepo) {
            toast.error("Login to GitHub and select a repository first.")
            return
        }

        const normalizedImportPath = normalizePath(importPath)

        try {
            setIsImporting(true)
            const folderFiles = await fetchGithubFolderFiles({
                accessToken: token,
                owner: selectedGithubRepo.owner.login,
                repo: selectedGithubRepo.name,
                path: normalizedImportPath,
                branch: selectedGithubRepo.default_branch,
            })

            if (folderFiles.length === 0) {
                toast.error("No files found in this GitHub folder.")
                return
            }

            const folderName = normalizedImportPath
                ? normalizedImportPath.split("/").pop() || selectedGithubRepo.name
                : selectedGithubRepo.name
            const rootFolderName = importWholeRepo
                ? selectedGithubRepo.name
                : folderName

            importGithubPayloads(folderFiles, rootFolderName)
            toast.success(
                importWholeRepo
                    ? `${selectedGithubRepo.name} repository imported`
                    : `${folderName} folder imported`,
            )
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to import GitHub folder."
            toast.error(message)
        } finally {
            setIsImporting(false)
        }
    }

    const handleGithubEntryClick = (entry: GithubEntry) => {
        if (entry.type === "dir") {
            if (!oauthTokens.github || !selectedGithubRepo) return
            void fetchGithubFolderEntries({
                token: oauthTokens.github,
                repo: selectedGithubRepo,
                path: entry.path,
            })
            return
        }
        void handleImportGithubFile(entry)
    }

    const navigateGithubBack = () => {
        if (!oauthTokens.github || !selectedGithubRepo) return
        const pathParts = githubPath.split("/").filter(Boolean)
        pathParts.pop()
        void fetchGithubFolderEntries({
            token: oauthTokens.github,
            repo: selectedGithubRepo,
            path: pathParts.join("/"),
        })
    }

    const isDriveLoggedIn = Boolean(oauthTokens.gdrive)
    const isGithubLoggedIn = Boolean(oauthTokens.github)
    const modeButtonClass = (isActive: boolean) =>
        `flex-1 rounded-xl px-3 py-2 text-sm font-medium transition-all ${
            isActive
                ? "sidebar-modern-btn sidebar-modern-btn--primary"
                : "sidebar-modern-btn"
        }`

    return (
        <div
            className="sidebar-modern-view flex max-h-full min-h-[400px] w-full flex-col gap-3 p-4"
            style={{ height: viewHeight }}
        >
            <div className="sidebar-modern-header">
                <h1 className="view-title m-0 border-none pb-0">External Import</h1>
            </div>

            <div className="sidebar-modern-card flex p-1">
                <button
                    type="button"
                    className={modeButtonClass(activeMode === "link")}
                    onClick={() => setActiveMode("link")}
                >
                    Import via link
                </button>
                <button
                    type="button"
                    className={modeButtonClass(activeMode === "account")}
                    onClick={() => setActiveMode("account")}
                >
                    Import from account
                </button>
            </div>

            {activeMode === "link" && (
                <div className="sidebar-modern-card">
                    <label className="ui-muted-text mb-2 block text-xs">
                        Paste a direct file link from Google Drive, GitHub, or any public URL
                    </label>
                    <textarea
                        value={externalUrl}
                        onChange={(event) => setExternalUrl(event.target.value)}
                        className="sidebar-modern-control h-24 resize-none p-2 text-sm"
                        placeholder="Paste external file URL..."
                    />
                    <button
                        type="button"
                        className="sidebar-modern-btn sidebar-modern-btn--primary mt-3 w-full"
                        onClick={handleLinkImport}
                        disabled={isImporting}
                    >
                        {isImporting ? "Importing..." : "Import to Explorer"}
                    </button>
                </div>
            )}

            {activeMode === "account" && (
                <div className="sidebar-modern-scroll min-h-0 flex-1 overflow-auto p-3">
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            className={`flex items-center justify-center gap-2 ${
                                activeAccountProvider === "gdrive"
                                    ? "sidebar-modern-btn sidebar-modern-btn--primary"
                                    : "sidebar-modern-btn"
                            }`}
                            onClick={() => setActiveAccountProvider("gdrive")}
                        >
                            <SiGoogledrive />
                            Google Drive
                        </button>
                        <button
                            type="button"
                            className={`flex items-center justify-center gap-2 ${
                                activeAccountProvider === "github"
                                    ? "sidebar-modern-btn sidebar-modern-btn--primary"
                                    : "sidebar-modern-btn"
                            }`}
                            onClick={() => setActiveAccountProvider("github")}
                        >
                            <SiGithub />
                            GitHub
                        </button>
                    </div>

                    {activeAccountProvider === "gdrive" && (
                        <div className="mt-3">
                            {!isDriveLoggedIn ? (
                                <button
                                    type="button"
                                    className="sidebar-modern-btn sidebar-modern-btn--primary flex w-full items-center justify-center gap-2"
                                    onClick={() => startProviderLogin("gdrive")}
                                >
                                    <SiGoogledrive />
                                    Login to Google Drive
                                </button>
                            ) : (
                                <div className="space-y-2">
                                    <button
                                        type="button"
                                        className="sidebar-modern-btn w-full"
                                        onClick={() => {
                                            const token = oauthTokens.gdrive
                                            if (token) {
                                                void fetchDriveFileList(token)
                                            }
                                        }}
                                        disabled={isLoadingDriveFiles}
                                    >
                                        {isLoadingDriveFiles ? "Refreshing..." : "Refresh files"}
                                    </button>
                                    <div className="max-h-80 overflow-auto rounded-xl border border-slate-500/30 bg-slate-900/60">
                                        {driveFiles.length === 0 ? (
                                            <p className="ui-muted-text p-3 text-sm">
                                                No files found in Google Drive.
                                            </p>
                                        ) : (
                                            driveFiles.map((file) => (
                                                <div
                                                    key={file.id}
                                                    className="flex items-center justify-between border-b border-slate-700/70 p-2 text-sm last:border-b-0"
                                                >
                                                    <div className="min-w-0">
                                                        <p className="truncate">{file.name}</p>
                                                        <p className="ui-muted-text text-xs">
                                                            {file.mimeType}
                                                        </p>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        className="sidebar-modern-btn px-2 py-1 text-xs"
                                                        onClick={() => {
                                                            void handleImportDriveFile(file)
                                                        }}
                                                        disabled={isImporting}
                                                    >
                                                        Import
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {activeAccountProvider === "github" && (
                        <div className="mt-3 space-y-2">
                            {!isGithubLoggedIn ? (
                                <button
                                    type="button"
                                    className="sidebar-modern-btn sidebar-modern-btn--primary flex w-full items-center justify-center gap-2"
                                    onClick={() => startProviderLogin("github")}
                                >
                                    <SiGithub />
                                    Login to GitHub
                                </button>
                            ) : (
                                <>
                                    <select
                                        value={selectedGithubRepo?.full_name || ""}
                                        onChange={(event) => {
                                            const nextRepo = githubRepos.find(
                                                (repo) => repo.full_name === event.target.value,
                                            )
                                            if (nextRepo) {
                                                setSelectedGithubRepo(nextRepo)
                                            }
                                        }}
                                        className="sidebar-modern-control p-2 text-sm"
                                        disabled={isLoadingGithubRepos || githubRepos.length === 0}
                                    >
                                        {githubRepos.map((repo) => (
                                            <option key={repo.id} value={repo.full_name}>
                                                {repo.full_name}
                                            </option>
                                        ))}
                                    </select>

                                    <div className="ui-muted-text flex items-center gap-2 text-xs">
                                        <button
                                            type="button"
                                            className="sidebar-modern-btn px-2 py-1 text-xs"
                                            onClick={navigateGithubBack}
                                            disabled={!githubPath}
                                        >
                                            Back
                                        </button>
                                        <span className="truncate">
                                            /{githubPath || ""}
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <button
                                            type="button"
                                            className="sidebar-modern-btn px-2 py-1 text-xs"
                                            onClick={() => {
                                                void handleImportGithubFolder({
                                                    importPath: githubPath,
                                                    importWholeRepo: false,
                                                })
                                            }}
                                            disabled={isImporting || isLoadingGithubEntries}
                                        >
                                            {isImporting ? "Importing..." : "Import This Folder"}
                                        </button>
                                        <button
                                            type="button"
                                            className="sidebar-modern-btn px-2 py-1 text-xs"
                                            onClick={() => {
                                                void handleImportGithubFolder({
                                                    importPath: "",
                                                    importWholeRepo: true,
                                                })
                                            }}
                                            disabled={isImporting || isLoadingGithubEntries}
                                        >
                                            {isImporting ? "Importing..." : "Import Whole Repo"}
                                        </button>
                                    </div>

                                    <div className="max-h-80 overflow-auto rounded-xl border border-slate-500/30 bg-slate-900/60">
                                        {isLoadingGithubEntries ? (
                                            <p className="ui-muted-text p-3 text-sm">
                                                Loading repository files...
                                            </p>
                                        ) : githubEntries.length === 0 ? (
                                            <p className="ui-muted-text p-3 text-sm">
                                                No entries found in this folder.
                                            </p>
                                        ) : (
                                            githubEntries.map((entry) => (
                                                <button
                                                    type="button"
                                                    key={entry.path}
                                                    className="flex w-full items-center justify-between border-b border-slate-700/70 p-2 text-left text-sm transition-colors hover:bg-cyan-500/10 last:border-b-0"
                                                    onClick={() => handleGithubEntryClick(entry)}
                                                    disabled={isImporting}
                                                >
                                                    <span className="truncate">
                                                        {entry.type === "dir" ? "[DIR]" : "[FILE]"}{" "}
                                                        {entry.name}
                                                    </span>
                                                    <span className="ui-muted-text text-xs">
                                                        {entry.type === "dir"
                                                            ? "Open"
                                                            : "Import"}
                                                    </span>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div className="sidebar-modern-card ui-muted-text text-xs">
                Imported files are added to the Explorer root and synchronized to all users in the room.
                {lastImportedName && <div className="mt-1">Last imported: {lastImportedName}</div>}
            </div>
        </div>
    )
}

export default ExternalImportView
