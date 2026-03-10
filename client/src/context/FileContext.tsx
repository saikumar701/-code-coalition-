import {
    FileContext as FileContextType,
    FileName,
    FileSystemItem,
    ImportFileOptions,
    Id,
} from "@/types/file"
import { SocketEvent } from "@/types/socket"
import { RemoteUser, USER_STATUS } from "@/types/user"
import {
    createInitialFileStructure,
    findParentDirectory,
    getFileById,
    isFileExist,
} from "@/utils/file"
import { saveAs } from "file-saver"
import JSZip from "jszip"
import {
    ReactNode,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react"
import { toast } from "react-hot-toast"
import { v4 as uuidv4 } from "uuid"
import { useAppContext } from "./AppContext"
import { useSocket } from "./SocketContext"

const FileContext = createContext<FileContextType | null>(null)

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

function getFileExtension(fileName: string): string {
    const parts = fileName.toLowerCase().split(".")
    return parts.length > 1 ? parts.pop() || "" : ""
}

function resolveImportedMimeType(
    fileName: string,
    mimeType: string | undefined,
    contentEncoding: "utf8" | "base64" | undefined,
): string {
    const normalizedMimeType = (mimeType || "").split(";")[0].trim().toLowerCase()
    if (normalizedMimeType && normalizedMimeType !== "application/octet-stream") {
        return normalizedMimeType
    }

    const extension = getFileExtension(fileName)
    if (extension && textMimeByExtension[extension]) {
        return textMimeByExtension[extension]
    }

    if (contentEncoding === "utf8") {
        return "text/plain"
    }

    return normalizedMimeType || "application/octet-stream"
}

const getInitialFileState = () => {
    const fileStructure = createInitialFileStructure()
    const openFiles = fileStructure.children ? [...fileStructure.children] : []
    const activeFile = openFiles[0] || null
    return { fileStructure, openFiles, activeFile }
}

export const useFileSystem = (): FileContextType => {
    const context = useContext(FileContext)
    if (!context) throw new Error("useFileSystem must be used within FileContextProvider")
    return context
}

function FileContextProvider({ children }: { children: ReactNode }) {
    const { socket } = useSocket()
    const { drawingData, status, currentUser, autoSaveEnabled } = useAppContext()
    const [initialFileState] = useState(getInitialFileState)

    const [fileStructure, setFileStructure] = useState<FileSystemItem>(
        initialFileState.fileStructure
    )
    const [openFiles, setOpenFiles] = useState<FileSystemItem[]>(
        initialFileState.openFiles
    )
    const [activeFile, setActiveFile] = useState<FileSystemItem | null>(
        initialFileState.activeFile
    )

    const resetFileState = useCallback(() => {
        const nextState = getInitialFileState()
        setFileStructure(nextState.fileStructure)
        setOpenFiles(nextState.openFiles)
        setActiveFile(nextState.activeFile)
    }, [])

    useEffect(() => {
        if (status !== USER_STATUS.ATTEMPTING_JOIN || !currentUser.roomId) return
        resetFileState()
    }, [currentUser.roomId, resetFileState, status])

    // Recursive helper to traverse and update file structure
    const traverseAndUpdate = useCallback(
        (
            item: FileSystemItem,
            updateFn: (item: FileSystemItem) => FileSystemItem | null
        ): FileSystemItem | null => {
            const updated = updateFn(item)
            if (updated === null) return null
            if (updated.children) {
                return {
                    ...updated,
                    children: updated.children
                        .map(child => traverseAndUpdate(child, updateFn))
                        .filter((child): child is FileSystemItem => child !== null)
                }
            }
            return updated
        },
        []
    )

    const mergeActiveFileIntoStructure = useCallback(
        (
            structure: FileSystemItem,
            currentActiveFile: FileSystemItem | null,
        ) => {
            if (!currentActiveFile || currentActiveFile.type !== "file") return structure
            return traverseAndUpdate(structure, (item) =>
                item.type === "file" && item.id === currentActiveFile.id
                    ? { ...item, content: currentActiveFile.content || "" }
                    : item,
            ) as FileSystemItem
        },
        [traverseAndUpdate],
    )

    const saveWorkspaceNow = useCallback(() => {
        if (status !== USER_STATUS.JOINED || !currentUser.roomId) {
            toast.error("Join a room to save workspace")
            return
        }

        socket.emit(SocketEvent.WORKSPACE_SYNC, {
            fileStructure: mergeActiveFileIntoStructure(fileStructure, activeFile),
        })
        toast.success("Workspace saved")
    }, [
        activeFile,
        currentUser.roomId,
        fileStructure,
        mergeActiveFileIntoStructure,
        socket,
        status,
    ])

    // Toggle directory open/close state
    const toggleDirectory = useCallback((dirId: Id) => {
        setFileStructure(prev =>
            traverseAndUpdate(prev, item =>
                item.id === dirId && item.type === "directory"
                    ? { ...item, isOpen: !item.isOpen }
                    : item
            ) as FileSystemItem
        )
    }, [traverseAndUpdate])

    // Collapse all directories
    const collapseDirectories = useCallback(() => {
        setFileStructure(prev =>
            traverseAndUpdate(prev, item =>
                item.type === "directory" ? { ...item, isOpen: false } : item
            ) as FileSystemItem
        )
    }, [traverseAndUpdate])

    // Create directory
    const createDirectory = useCallback(
        (parentDirId: string, newDir: string | FileSystemItem, sendToSocket = true): Id => {
            const newDirectory: FileSystemItem =
                typeof newDir === "string"
                    ? { id: uuidv4(), name: newDir, type: "directory", children: [], isOpen: false }
                    : newDir

            const targetParentId = parentDirId || fileStructure.id

            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.id === targetParentId
                        ? { ...item, children: [...(item.children || []), newDirectory] }
                        : item
                ) as FileSystemItem
            )

            if (sendToSocket) {
                socket.emit(SocketEvent.DIRECTORY_CREATED, { parentDirId: targetParentId, newDirectory })
            }

            return newDirectory.id
        },
        [fileStructure.id, socket, traverseAndUpdate]
    )

    // Update directory children
    const updateDirectory = useCallback(
        (dirId: string, children: FileSystemItem[], sendToSocket = true) => {
            const targetDirId = dirId || fileStructure.id

            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.id === targetDirId ? { ...item, children } : item
                ) as FileSystemItem
            )

            setOpenFiles([])
            setActiveFile(null)

            if (targetDirId === fileStructure.id) {
                toast.dismiss()
                toast.success("Files and folders updated")
            }

            if (sendToSocket) {
                socket.emit(SocketEvent.DIRECTORY_UPDATED, { dirId: targetDirId, children })
            }
        },
        [fileStructure.id, socket, traverseAndUpdate]
    )

    // Rename directory
    const renameDirectory = useCallback(
        (dirId: string, newDirName: string, sendToSocket = true): boolean => {
            const parent = findParentDirectory(fileStructure, dirId)
            if (!parent) {
                toast.error("Cannot rename the root directory.")
                return false
            }

            const isNameTaken = parent.children?.some(
                item => item.name === newDirName && item.id !== dirId && item.type === "directory"
            )

            if (isNameTaken) {
                toast.error("A folder with that name already exists in this directory.")
                return false
            }

            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.id === dirId ? { ...item, name: newDirName } : item
                ) as FileSystemItem
            )

            if (sendToSocket) {
                socket.emit(SocketEvent.DIRECTORY_RENAMED, { dirId, newDirName })
            }

            toast.success("Folder renamed successfully.")
            return true
        },
        [fileStructure, socket, traverseAndUpdate]
    )

    // Delete directory
    const deleteDirectory = useCallback(
        (dirId: string, sendToSocket = true) => {
            if (dirId === fileStructure.id) {
                toast.error("Cannot delete the root directory.")
                return
            }

            // Collect all file IDs to close
            const collectFileIds = (item: FileSystemItem): string[] => {
                if (item.type === "file") return [item.id]
                return (item.children || []).flatMap(collectFileIds)
            }

            const itemToDelete = getFileById(fileStructure, dirId)
            if (itemToDelete) {
                const fileIdsToClose = collectFileIds(itemToDelete)
                fileIdsToClose.forEach(id => closeFile(id))
            }

            setFileStructure(prev => traverseAndUpdate(prev, item =>
                item.id === dirId ? null : item
            ) as FileSystemItem)

            if (sendToSocket) {
                socket.emit(SocketEvent.DIRECTORY_DELETED, { dirId })
            }

            toast.success("Folder deleted successfully.")
        },
        [fileStructure, socket, traverseAndUpdate]
    )

    // Close file
    const closeFile = useCallback((fileId: Id) => {
        setOpenFiles(prev => {
            const fileIndex = prev.findIndex(file => file.id === fileId)
            if (fileIndex === -1) return prev

            setActiveFile(current => {
                if (current?.id !== fileId) return current
                
                // Save content before closing
                if (current.content !== undefined) {
                    updateFileContent(current.id, current.content)
                }

                // Set next active file
                if (prev.length > 1) {
                    return fileIndex > 0 ? prev[fileIndex - 1] : prev[fileIndex + 1]
                }
                return null
            })

            return prev.filter(file => file.id !== fileId)
        })
    }, [])

    // Open file
    const openFile = useCallback((fileId: Id) => {
        const file = getFileById(fileStructure, fileId)
        if (!file) return

        // Save current active file content
        if (activeFile?.id && activeFile.content !== undefined) {
            updateFileContent(activeFile.id, activeFile.content)
        }

        setOpenFiles(prev => {
            const isAlreadyOpen = prev.some(f => f.id === fileId)
            const updatedFiles = prev.map(f =>
                f.id === activeFile?.id ? { ...f, content: activeFile.content || "" } : f
            )
            return isAlreadyOpen ? updatedFiles : [...updatedFiles, file]
        })

        setActiveFile(file)
    }, [fileStructure, activeFile])

    // Create file
    const createFile = useCallback(
        (parentDirId: string, file: FileName | FileSystemItem, sendToSocket = true): Id => {
            const targetParentId = parentDirId || fileStructure.id
            const parentDir = getFileById(fileStructure, targetParentId)
            if (!parentDir || parentDir.type !== "directory") {
                throw new Error("Parent directory not found")
            }

            let newFile: FileSystemItem

            if (typeof file === "string") {
                let name = file
                let num = 1
                while (isFileExist(parentDir, name)) {
                    const [baseName, ext] = name.split(".")
                    name = `${baseName}(${num}).${ext}`
                    num++
                }
                newFile = {
                    id: uuidv4(),
                    name,
                    type: "file",
                    content: "",
                    contentEncoding: "utf8",
                    mimeType: "text/plain",
                }
            } else {
                newFile = file
            }

            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.id === targetParentId
                        ? { ...item, children: [...(item.children || []), newFile], isOpen: true }
                        : item
                ) as FileSystemItem
            )

            setOpenFiles(prev => [...prev, newFile])
            setActiveFile(newFile)

            if (sendToSocket) {
                socket.emit(SocketEvent.FILE_CREATED, { parentDirId: targetParentId, newFile })
            }

            return newFile.id
        },
        [fileStructure, socket, traverseAndUpdate]
    )

    // Import file
    const importFile = useCallback(
        (
            parentDirId: string,
            fileName: string,
            fileContent: string,
            sendToSocket = false,
            options?: ImportFileOptions,
        ): Id | null => {
            const contentEncoding = options?.contentEncoding || "utf8"
            const shouldOpenInEditor = Boolean(options?.openInEditor)
            const mimeType = resolveImportedMimeType(
                fileName,
                options?.mimeType,
                contentEncoding,
            )
            const newFile: FileSystemItem = {
                id: uuidv4(),
                name: fileName,
                type: "file",
                content: fileContent,
                contentEncoding,
                mimeType,
            }

            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.id === parentDirId
                        ? { ...item, children: [...(item.children || []), newFile] }
                        : item
                ) as FileSystemItem
            )

            if (shouldOpenInEditor) {
                setOpenFiles((prevOpenFiles) => {
                    const exists = prevOpenFiles.some((file) => file.id === newFile.id)
                    return exists ? prevOpenFiles : [...prevOpenFiles, newFile]
                })
                setActiveFile(newFile)
            }

            if (sendToSocket) {
                socket.emit(SocketEvent.FILE_CREATED, { parentDirId, newFile })
            }

            return newFile.id
        },
        [socket, traverseAndUpdate]
    )

    // Helper functions for path-based operations
    const createDirectoryByPath = useCallback((path: string) => {
        const parts = path.split("/").filter(Boolean)
        let parent = fileStructure.id
        parts.forEach(p => {
            parent = createDirectory(parent, p, false)
        })
    }, [fileStructure.id, createDirectory])

    const createFileByPath = useCallback((path: string, content: string) => {
        const parts = path.split("/")
        const fileName = parts.pop()!
        let parent = fileStructure.id

        parts.filter(Boolean).forEach(p => {
            parent = createDirectory(parent, p, false)
        })

        const newFileId = createFile(parent, fileName, false)
        updateFileContent(newFileId, content)
    }, [fileStructure.id, createDirectory, createFile])

    // Import ZIP file
    const importZip = useCallback(async (file: File) => {
        const zip = await JSZip.loadAsync(file)
        for (const path in zip.files) {
            const zipEntry = zip.files[path]
            if (zipEntry.dir) {
                createDirectoryByPath(path)
            } else {
                const content = await zipEntry.async("string")
                createFileByPath(path, content)
            }
        }
    }, [createDirectoryByPath, createFileByPath])

    // Apply tree structure
    const applyTree = useCallback((parentId: Id, nodes: FileSystemItem[]) => {
        nodes.forEach(node => {
            if (node.type === "directory") {
                const newId = createDirectory(parentId, node.name, false)
                if (node.children) applyTree(newId, node.children)
            } else {
                createFile(parentId, node.name, false)
            }
        })
    }, [createDirectory, createFile])

    // Update file content
    const updateFileContent = useCallback(
        (fileId: string, newContent: string) => {
            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.type === "file" && item.id === fileId
                        ? { ...item, content: newContent, contentEncoding: "utf8" }
                        : item
                ) as FileSystemItem
            )

            setOpenFiles(prev =>
                prev.map(file =>
                    file.id === fileId
                        ? { ...file, content: newContent, contentEncoding: "utf8" }
                        : file,
                )
            )

            setActiveFile(prev =>
                prev?.id === fileId
                    ? { ...prev, content: newContent, contentEncoding: "utf8" }
                    : prev
            )
        },
        [traverseAndUpdate]
    )

    // Rename file
    const renameFile = useCallback(
        (fileId: string, newName: string, sendToSocket = true): boolean => {
            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.type === "file" && item.id === fileId ? { ...item, name: newName } : item
                ) as FileSystemItem
            )

            setOpenFiles(prev => prev.map(file => (file.id === fileId ? { ...file, name: newName } : file)))

            setActiveFile(prev => (prev?.id === fileId ? { ...prev, name: newName } : prev))

            if (sendToSocket) {
                socket.emit(SocketEvent.FILE_RENAMED, { fileId, newName })
            }

            return true
        },
        [socket, traverseAndUpdate]
    )

    // Delete file
    const deleteFile = useCallback(
        (fileId: string, sendToSocket = true) => {
            setFileStructure(prev =>
                traverseAndUpdate(prev, item =>
                    item.type === "file" && item.id === fileId ? null : item
                ) as FileSystemItem
            )

            setOpenFiles(prev => prev.filter(file => file.id !== fileId))
            setActiveFile(prev => (prev?.id === fileId ? null : prev))

            toast.success("File deleted successfully")

            if (sendToSocket) {
                socket.emit(SocketEvent.FILE_DELETED, { fileId })
            }
        },
        [socket, traverseAndUpdate]
    )

    // Download files and folders as ZIP
    const downloadFilesAndFolders = useCallback(() => {
        const zip = new JSZip()

        const addToZip = (item: FileSystemItem, parentPath = "") => {
            const currentPath = parentPath + item.name + (item.type === "directory" ? "/" : "")
            if (item.type === "file") {
                zip.file(currentPath, item.content || "")
            } else if (item.children) {
                item.children.forEach(child => addToZip(child, currentPath))
            }
        }

        fileStructure.children?.forEach(child => addToZip(child))

        zip.generateAsync({ type: "blob" }).then(content => {
            saveAs(content, "download.zip")
        })
    }, [fileStructure])

    // Socket event handlers
    const handleUserJoined = useCallback(
        ({ user }: { user: RemoteUser }) => {
            socket.emit(SocketEvent.SYNC_FILE_STRUCTURE, {
                fileStructure,
                openFiles,
                activeFile,
                socketId: user.socketId,
            })
            socket.emit(SocketEvent.SYNC_DRAWING, { drawingData, socketId: user.socketId })
        },
        [activeFile, drawingData, fileStructure, openFiles, socket]
    )

    const handleRemoteFileUpdated = useCallback(
        ({ fileId, newContent }: { fileId: string; newContent: string }) => {
            updateFileContent(fileId, newContent)
            setActiveFile((prev) =>
                prev?.id === fileId ? { ...prev, content: newContent } : prev
            )
        },
        [updateFileContent]
    )

    const handleFileStructureSync = useCallback(
        ({
            fileStructure,
            openFiles,
            activeFile,
        }: {
            fileStructure: FileSystemItem
            openFiles: FileSystemItem[]
            activeFile: FileSystemItem | null
        }) => {
            setFileStructure(fileStructure)
            setOpenFiles(openFiles)
            setActiveFile(activeFile)
            toast.dismiss()
        },
        []
    )

    // Socket listeners
    useEffect(() => {
        const handlers = {
            [SocketEvent.USER_JOINED]: handleUserJoined,
            [SocketEvent.SYNC_FILE_STRUCTURE]: handleFileStructureSync,
            [SocketEvent.DIRECTORY_CREATED]: ({ parentDirId, newDirectory }: any) =>
                createDirectory(parentDirId, newDirectory, false),
            [SocketEvent.DIRECTORY_UPDATED]: ({ dirId, children }: any) =>
                updateDirectory(dirId, children, false),
            [SocketEvent.DIRECTORY_RENAMED]: ({ dirId, newName }: any) =>
                renameDirectory(dirId, newName, false),
            [SocketEvent.DIRECTORY_DELETED]: ({ dirId }: any) => deleteDirectory(dirId, false),
            [SocketEvent.FILE_CREATED]: ({ parentDirId, newFile }: any) =>
                createFile(parentDirId, newFile, false),
            [SocketEvent.FILE_UPDATED]: handleRemoteFileUpdated,
            [SocketEvent.FILE_RENAMED]: ({ fileId, newName }: any) => renameFile(fileId, newName, false),
            [SocketEvent.FILE_DELETED]: ({ fileId }: any) => deleteFile(fileId, false),
            "folder:import": ({ parentId, tree }: any) => applyTree(parentId, tree),
        }

        const entries = Object.entries(handlers)
        entries.forEach(([event, handler]) => {
            socket.on(event, handler)
        })

        return () => {
            entries.forEach(([event, handler]) => {
                socket.off(event, handler)
            })
        }
    }, [
        socket,
        handleUserJoined,
        handleFileStructureSync,
        createDirectory,
        updateDirectory,
        renameDirectory,
        deleteDirectory,
        createFile,
        handleRemoteFileUpdated,
        renameFile,
        deleteFile,
        applyTree,
    ])

    // Keep the server workspace synchronized with the current file tree.
    // Even when auto-save is OFF, sync with a slower debounce so project state
    // still persists for run/rejoin flows.
    useEffect(() => {
        if (status !== USER_STATUS.JOINED || !currentUser.roomId) return

        const debounceMs = autoSaveEnabled ? 200 : 2000
        const timeout = setTimeout(() => {
            socket.emit(SocketEvent.WORKSPACE_SYNC, {
                fileStructure: mergeActiveFileIntoStructure(fileStructure, activeFile),
            })
        }, debounceMs)

        return () => clearTimeout(timeout)
    }, [
        activeFile,
        currentUser.roomId,
        fileStructure,
        autoSaveEnabled,
        mergeActiveFileIntoStructure,
        socket,
        status,
    ])

    // Flush latest workspace when the tab is being closed/refreshed.
    useEffect(() => {
        if (status !== USER_STATUS.JOINED || !currentUser.roomId) return

        const flushWorkspace = () => {
            socket.emit(SocketEvent.WORKSPACE_SYNC, {
                fileStructure: mergeActiveFileIntoStructure(fileStructure, activeFile),
            })
        }

        window.addEventListener("pagehide", flushWorkspace)
        window.addEventListener("beforeunload", flushWorkspace)
        return () => {
            window.removeEventListener("pagehide", flushWorkspace)
            window.removeEventListener("beforeunload", flushWorkspace)
        }
    }, [
        activeFile,
        currentUser.roomId,
        fileStructure,
        mergeActiveFileIntoStructure,
        socket,
        status,
    ])

    const value = useMemo(
        () => ({
            fileStructure,
            openFiles,
            activeFile,
            setActiveFile,
            closeFile,
            toggleDirectory,
            collapseDirectories,
            createDirectory,
            updateDirectory,
            renameDirectory,
            deleteDirectory,
            openFile,
            createFile,
            importFile,
            importZip,
            updateFileContent,
            renameFile,
            deleteFile,
            saveWorkspaceNow,
            downloadFilesAndFolders,
        }),
        [
            fileStructure,
            openFiles,
            activeFile,
            closeFile,
            toggleDirectory,
            collapseDirectories,
            createDirectory,
            updateDirectory,
            renameDirectory,
            deleteDirectory,
            openFile,
            createFile,
            importFile,
            importZip,
            updateFileContent,
            renameFile,
            deleteFile,
            saveWorkspaceNow,
            downloadFilesAndFolders,
        ]
    )

    return <FileContext.Provider value={value}>{children}</FileContext.Provider>
}

export { FileContextProvider }
export default FileContext
