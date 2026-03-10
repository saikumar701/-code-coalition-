import { useEffect, useRef, useState } from "react"
import { useFileSystem } from "@/context/FileContext"
import useResponsive from "@/hooks/useResponsive"
import { FileSystemItem, Id } from "@/types/file"
import { getFileById, sortFileSystemItem } from "@/utils/file"
import cn from "classnames"
import {
    Check,
    FilePlus,
    FileUp,
    Folder as FolderIcon,
    FolderPlus,
    FolderUp,
    Upload,
    X,
} from "lucide-react"
import { toast } from "react-hot-toast"
import TreeNode from "./TreeNode"

const textMimeByExtension: Record<string, string> = {
    c: "text/x-csrc",
    cpp: "text/x-c++src",
    css: "text/css",
    go: "text/x-go",
    h: "text/x-csrc",
    hpp: "text/x-c++src",
    html: "text/html",
    java: "text/x-java-source",
    js: "text/javascript",
    json: "application/json",
    jsx: "text/javascript",
    md: "text/markdown",
    py: "text/x-python",
    rs: "text/x-rust",
    sh: "text/x-shellscript",
    sql: "text/x-sql",
    ts: "text/typescript",
    tsx: "text/typescript",
    txt: "text/plain",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
}

const likelyBinaryExtensions = new Set([
    "7z",
    "avi",
    "bmp",
    "class",
    "dll",
    "doc",
    "docx",
    "exe",
    "gif",
    "gz",
    "ico",
    "jar",
    "jpeg",
    "jpg",
    "mov",
    "mp3",
    "mp4",
    "pdf",
    "png",
    "ppt",
    "pptx",
    "so",
    "tar",
    "wav",
    "webm",
    "webp",
    "xls",
    "xlsx",
    "zip",
])

function getFileExtension(fileName: string): string {
    const splitName = fileName.toLowerCase().split(".")
    return splitName.length > 1 ? splitName.pop() || "" : ""
}

function resolveMimeTypeForFile(file: File): string {
    if (file.type) return file.type
    const extension = getFileExtension(file.name)
    if (extension && textMimeByExtension[extension]) {
        return textMimeByExtension[extension]
    }
    if (extension && likelyBinaryExtensions.has(extension)) {
        return "application/octet-stream"
    }
    return "text/plain"
}

function isLikelyTextFile(file: File, resolvedMimeType: string): boolean {
    if (resolvedMimeType.startsWith("text/")) return true
    if (
        /(json|javascript|typescript|xml|csv|yaml|yml|svg|markdown|x-python|x-java|x-go|x-rust|x-shell|x-c)/i.test(
            resolvedMimeType,
        )
    ) {
        return true
    }

    const extension = getFileExtension(file.name)
    if (!extension) return !file.type
    return !likelyBinaryExtensions.has(extension)
}

function FileStructureView() {
    const {
        fileStructure,
        createFile,
        createDirectory,
        collapseDirectories,
        importFile,
    } = useFileSystem()
    const explorerRef = useRef<HTMLDivElement | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const folderInputRef = useRef<HTMLInputElement | null>(null)
    const createInputRef = useRef<HTMLInputElement | null>(null)
    const [selectedDirId, setSelectedDirId] = useState<Id>(fileStructure.id)
    const [createMode, setCreateMode] = useState<"file" | "directory" | null>(null)
    const [createName, setCreateName] = useState("")
    const { minHeightReached } = useResponsive()

    useEffect(() => {
        setSelectedDirId(fileStructure.id)
    }, [fileStructure.id])

    useEffect(() => {
        if (!createMode || !createInputRef.current) return
        createInputRef.current.focus()
    }, [createMode])

    const resolveSelectedDirectoryId = () => selectedDirId || fileStructure.id

    const startCreate = (mode: "file" | "directory") => {
        setCreateMode(mode)
        setCreateName("")
    }

    const cancelCreate = () => {
        setCreateMode(null)
        setCreateName("")
    }

    const submitCreate = () => {
        if (!createMode) return
        const trimmedName = createName.trim()
        if (!trimmedName) {
            toast.error(`Enter a ${createMode === "file" ? "file" : "folder"} name`)
            return
        }

        const targetDirectoryId = resolveSelectedDirectoryId()
        if (createMode === "file") {
            createFile(targetDirectoryId, trimmedName)
        } else {
            const newDirectoryId = createDirectory(targetDirectoryId, trimmedName)
            setSelectedDirId(newDirectoryId)
        }

        setCreateMode(null)
        setCreateName("")
    }

    const handleCreateKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault()
            submitCreate()
            return
        }
        if (event.key === "Escape") {
            event.preventDefault()
            cancelCreate()
        }
    }

    const handleCollapseAll = () => {
        collapseDirectories()
        setSelectedDirId(fileStructure.id)
    }

    const handleImportFilesClick = () => {
        fileInputRef.current?.click()
    }

    const handleImportFolderClick = () => {
        folderInputRef.current?.click()
    }

    const readFileContent = (
        file: File,
    ): Promise<{ content: string; contentEncoding: "utf8" | "base64"; mimeType: string }> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader()
            const resolvedMimeType = resolveMimeTypeForFile(file)
            const shouldReadAsText = isLikelyTextFile(file, resolvedMimeType)

            reader.onload = () => {
                if (shouldReadAsText) {
                    resolve({
                        content: (reader.result as string) || "",
                        contentEncoding: "utf8",
                        mimeType: resolvedMimeType,
                    })
                    return
                }

                const dataUrl = String(reader.result || "")
                const base64Content = dataUrl.includes(",") ? dataUrl.split(",")[1] : ""
                resolve({
                    content: base64Content,
                    contentEncoding: "base64",
                    mimeType: resolvedMimeType || "application/octet-stream",
                })
            }

            reader.onerror = reject
            if (shouldReadAsText) {
                reader.readAsText(file)
            } else {
                reader.readAsDataURL(file)
            }
        })

    const getOrCreateDirectoryId = (
        directoryPathCache: Map<string, string>,
        importRootId: Id,
        pathFromImportRoot: string,
        directoryName: string,
        parentId: Id,
    ) => {
        const cacheKey = `${importRootId}:${pathFromImportRoot}`
        const cachedDirectoryId = directoryPathCache.get(cacheKey)
        if (cachedDirectoryId) return cachedDirectoryId

        const parentNode = getFileById(fileStructure, parentId)
        const existingDirectory =
            parentNode?.type === "directory"
                ? parentNode.children?.find(
                      (item) => item.type === "directory" && item.name === directoryName,
                  )
                : null

        const directoryId = existingDirectory?.id || createDirectory(parentId, directoryName)
        directoryPathCache.set(cacheKey, directoryId)
        return directoryId
    }

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files
        if (!files || files.length === 0) return

        const targetDirectoryId = resolveSelectedDirectoryId()
        for (let index = 0; index < files.length; index += 1) {
            const file = files[index]
            const filePayload = await readFileContent(file)
            importFile(targetDirectoryId, file.name, filePayload.content, true, {
                contentEncoding: filePayload.contentEncoding,
                mimeType: filePayload.mimeType,
            })
        }

        event.target.value = ""
    }

    const handleFolderChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files
        if (!files || files.length === 0) return

        const targetDirectoryId = resolveSelectedDirectoryId()
        const directoryPathCache = new Map<string, string>()

        for (let index = 0; index < files.length; index += 1) {
            const file = files[index]
            const filePayload = await readFileContent(file)
            const relativePath = (file.webkitRelativePath || file.name).split("/").filter(Boolean)
            if (relativePath.length === 0) continue

            const directoryParts = relativePath.slice(0, -1)
            const fileName = relativePath[relativePath.length - 1]

            let currentParentId = targetDirectoryId
            let traversedPath = ""

            for (const dirPart of directoryParts) {
                traversedPath = traversedPath ? `${traversedPath}/${dirPart}` : dirPart
                currentParentId = getOrCreateDirectoryId(
                    directoryPathCache,
                    targetDirectoryId,
                    traversedPath,
                    dirPart,
                    currentParentId,
                )
            }

            importFile(currentParentId, fileName, filePayload.content, true, {
                contentEncoding: filePayload.contentEncoding,
                mimeType: filePayload.mimeType,
            })
        }

        event.target.value = ""
    }

    const openPathInTerminal = (relativePath: string) => {
        window.dispatchEvent(
            new CustomEvent("terminal:cd", {
                detail: { path: relativePath || "." },
            }),
        )
    }

    const sortedFileStructure = sortFileSystemItem(fileStructure)
    const actionButtonClassName = "sidebar-modern-btn h-10 w-10 rounded-xl p-0 text-slate-50"

    return (
        <div className="file-explorer-view sidebar-modern-view flex h-full flex-grow flex-col">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
                accept="*/*"
            />
            <input
                ref={folderInputRef}
                type="file"
                multiple
                onChange={handleFolderChange}
                className="hidden"
                {...({ webkitdirectory: "", directory: "" } as any)}
            />
            <div className="sidebar-modern-header px-3 py-2">
                <h2 className="ui-muted-text text-xs font-semibold uppercase tracking-wide">
                    Explorer
                </h2>
                <div className="flex gap-1">
                    <button
                        className={actionButtonClassName}
                        onClick={() => startCreate("file")}
                        title="New File"
                    >
                        <FilePlus size={20} />
                    </button>
                    <button
                        className={actionButtonClassName}
                        onClick={() => startCreate("directory")}
                        title="New Folder"
                    >
                        <FolderPlus size={20} />
                    </button>
                    <button
                        className={actionButtonClassName}
                        onClick={handleImportFilesClick}
                        title="Import Files"
                    >
                        <FileUp size={20} />
                    </button>
                    <button
                        className={actionButtonClassName}
                        onClick={handleImportFolderClick}
                        title="Import Folder"
                    >
                        <Upload size={20} />
                    </button>
                    <button
                        className={actionButtonClassName}
                        onClick={handleCollapseAll}
                        title="Collapse Folders"
                    >
                        <FolderUp size={20} />
                    </button>
                </div>
            </div>

            {createMode && (
                <div className="sidebar-modern-card mx-2 mt-2 space-y-2 p-3">
                    <p className="ui-muted-text text-xs font-medium uppercase tracking-wide">
                        {createMode === "file" ? "New File" : "New Folder"}
                    </p>
                    <input
                        ref={createInputRef}
                        type="text"
                        value={createName}
                        onChange={(event) => setCreateName(event.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        placeholder={
                            createMode === "file" ? "example.tsx" : "new-folder"
                        }
                        className="sidebar-modern-control px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={submitCreate}
                            className="sidebar-modern-btn sidebar-modern-btn--primary h-9 px-3"
                            title="Create"
                        >
                            <Check size={18} />
                        </button>
                        <button
                            type="button"
                            onClick={cancelCreate}
                            className="sidebar-modern-btn h-9 px-3"
                            title="Cancel"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>
            )}

            <div
                className={cn("sidebar-modern-scroll mt-2 flex-grow overflow-auto p-2", {
                    "h-[calc(80vh-170px)]": !minHeightReached,
                    "h-[85vh]": minHeightReached,
                })}
                ref={explorerRef}
                onClick={(event) => {
                    if (event.target === event.currentTarget) {
                        setSelectedDirId(fileStructure.id)
                    }
                }}
            >
                {sortedFileStructure.children && sortedFileStructure.children.length > 0 ? (
                    sortedFileStructure.children.map((item: FileSystemItem) => (
                        <TreeNode
                            key={item.id}
                            node={item}
                            selectedDirId={selectedDirId}
                            pathSegments={[]}
                            parentDirectoryId={fileStructure.id}
                            onSelectDirectory={setSelectedDirId}
                            onOpenInTerminal={openPathInTerminal}
                        />
                    ))
                ) : (
                    <div className="ui-muted-text flex h-full flex-col items-center justify-center px-4 text-sm">
                        <FolderIcon size={52} className="mb-3 opacity-55" />
                        <p className="mb-2 text-center">No files yet</p>
                        <p className="text-center text-xs">
                            Use New File or New Folder to start
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}

export default FileStructureView
