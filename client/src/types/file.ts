type Id = string
type FileName = string
type FileContent = string
type FileContentEncoding = "utf8" | "base64"

interface FileSystemItem {
    id: string
    name: FileName
    type: "file" | "directory"
    children?: FileSystemItem[]
    content?: FileContent
    contentEncoding?: FileContentEncoding
    mimeType?: string
    isOpen?: boolean
}

interface ImportFileOptions {
    contentEncoding?: FileContentEncoding
    mimeType?: string
    openInEditor?: boolean
}

interface FileContext {
    fileStructure: FileSystemItem
    openFiles: FileSystemItem[]
    activeFile: FileSystemItem | null
    setActiveFile: (file: FileSystemItem) => void
    closeFile: (fileId: Id) => void
    toggleDirectory: (dirId: Id) => void
    collapseDirectories: () => void
    createDirectory: (parentDirId: Id, name: FileName) => Id
    updateDirectory: (dirId: Id, children: FileSystemItem[]) => void
    renameDirectory: (dirId: Id, newName: FileName) => void
    deleteDirectory: (dirId: Id) => void
    createFile: (parentDirId: Id, name: FileName) => Id
    updateFileContent: (fileId: Id, content: FileContent) => void
    openFile: (fileId: Id) => void
    renameFile: (fileId: Id, newName: FileName) => boolean
    deleteFile: (fileId: Id) => void
    saveWorkspaceNow: () => void
    downloadFilesAndFolders: () => void
    importFile: (
        parentDirId: Id,
        fileName: string,
        fileContent: string,
        sendToSocket?: boolean,
        options?: ImportFileOptions,
    ) => Id | null,
    importZip: (file: File, parentId?: string) => Promise<void>
}

export { FileSystemItem, FileContent, FileContext, Id, FileName, FileContentEncoding, ImportFileOptions }
