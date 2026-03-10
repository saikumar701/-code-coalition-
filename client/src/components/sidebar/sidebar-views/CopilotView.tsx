import { useCopilot } from "@/context/CopilotContext"
import { useFileSystem } from "@/context/FileContext"
import { useSocket } from "@/context/SocketContext"
import useResponsive from "@/hooks/useResponsive"
import { SocketEvent } from "@/types/socket"
import { FileSystemItem } from "@/types/file"
import toast from "react-hot-toast"
import { LuClipboardPaste, LuCopy, LuRepeat } from "react-icons/lu"
import ReactMarkdown from "react-markdown"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"

type CopilotCodePayload = {
    content: string
    language: string | null
}

const LANGUAGE_EXTENSION_MAP: Record<string, string> = {
    py: "py",
    python: "py",
    js: "js",
    javascript: "js",
    node: "js",
    mjs: "js",
    cjs: "js",
    ts: "ts",
    typescript: "ts",
    jsx: "jsx",
    tsx: "tsx",
    html: "html",
    css: "css",
    json: "json",
    yaml: "yml",
    yml: "yml",
    xml: "xml",
    md: "md",
    markdown: "md",
    java: "java",
    c: "c",
    "c++": "cpp",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    "c#": "cs",
    csharp: "cs",
    cs: "cs",
    go: "go",
    rust: "rs",
    rs: "rs",
    php: "php",
    ruby: "rb",
    rb: "rb",
    swift: "swift",
    kotlin: "kt",
    kt: "kt",
    sql: "sql",
    sh: "sh",
    shell: "sh",
    bash: "sh",
    zsh: "sh",
    powershell: "ps1",
    ps1: "ps1",
}

const normalizeLanguageTag = (language: string | null | undefined) => {
    if (!language) return ""
    return language.trim().toLowerCase()
}

const getFileExtension = (name: string | undefined) => {
    if (!name) return ""
    const extensionParts = name.split(".")
    if (extensionParts.length < 2) return ""
    return extensionParts.pop()?.toLowerCase() || ""
}

const detectLanguageFromCode = (content: string): string | null => {
    const source = content.trim()
    if (!source) return null

    if (/^<!doctype html>/i.test(source) || /^<html[\s>]/i.test(source)) return "html"
    if (/^<\?php/i.test(source)) return "php"
    if (/^\s*from\s+\w+\s+import\s+/m.test(source) || /^\s*def\s+\w+\s*\(/m.test(source)) {
        return "python"
    }
    if (/^\s*console\.log\(/m.test(source) || /^\s*function\s+\w+\s*\(/m.test(source)) {
        return "javascript"
    }

    return null
}

const extractCopilotCodePayload = (text: string): CopilotCodePayload => {
    const codeBlockRegex = /```([a-zA-Z0-9_+#.-]*)\r?\n([\s\S]*?)```/g
    const codeBlocks: { language: string; code: string }[] = []
    let match: RegExpExecArray | null = null

    while ((match = codeBlockRegex.exec(text)) !== null) {
        codeBlocks.push({
            language: normalizeLanguageTag(match[1]),
            code: match[2].trim(),
        })
    }

    if (codeBlocks.length === 0) {
        const trimmed = text.trim()
        return {
            content: trimmed,
            language: detectLanguageFromCode(trimmed),
        }
    }

    const content = codeBlocks
        .map((block) => block.code)
        .filter(Boolean)
        .join("\n\n")

    const languageFromCodeBlock =
        codeBlocks.find((block) => Boolean(block.language))?.language || null

    return {
        content,
        language: languageFromCodeBlock || detectLanguageFromCode(content),
    }
}

function CopilotView() {
    const {socket} = useSocket()
    const { viewHeight } = useResponsive()
    const { generateCode, output, isRunning, setInput } = useCopilot()
    const {
        activeFile,
        openFiles,
        fileStructure,
        createFile,
        updateFileContent,
        setActiveFile,
    } = useFileSystem()

    const resolveTargetExtension = (language: string | null): string => {
        const normalizedLanguage = normalizeLanguageTag(language)
        if (normalizedLanguage && LANGUAGE_EXTENSION_MAP[normalizedLanguage]) {
            return LANGUAGE_EXTENSION_MAP[normalizedLanguage]
        }
        if (normalizedLanguage && /^[a-z0-9]+$/i.test(normalizedLanguage)) {
            return normalizedLanguage
        }
        return getFileExtension(activeFile?.name) || "txt"
    }

    const resolveTargetFile = (language: string | null) => {
        const targetExtension = resolveTargetExtension(language)
        const activeFileExtension = getFileExtension(activeFile?.name)

        if (activeFile && activeFile.type === "file" && activeFileExtension === targetExtension) {
            return {
                fileId: activeFile.id,
                extension: targetExtension,
                file: activeFile,
                createdNewFile: false,
            }
        }

        const matchingOpenFile =
            openFiles.find(
                (file) =>
                    file.type === "file" &&
                    getFileExtension(file.name) === targetExtension,
            ) || null

        if (matchingOpenFile) {
            setActiveFile(matchingOpenFile)
            return {
                fileId: matchingOpenFile.id,
                extension: targetExtension,
                file: matchingOpenFile,
                createdNewFile: false,
            }
        }

        const fileId = createFile(fileStructure.id, `untitled.${targetExtension}`)
        return {
            fileId,
            extension: targetExtension,
            file: null as FileSystemItem | null,
            createdNewFile: true,
        }
    }

    const applyCopilotCodeToFile = (mode: "replace" | "paste") => {
        const { content: generatedCode, language } = extractCopilotCodePayload(output)
        if (!generatedCode) {
            toast.error("No code detected in Copilot output")
            return
        }

        if (mode === "replace") {
            const isConfirmed = confirm(
                "Are you sure you want to replace the code in the target file?",
            )
            if (!isConfirmed) return
        }

        const { fileId, extension, file, createdNewFile } = resolveTargetFile(language)
        const currentTargetContent =
            file?.id === activeFile?.id
                ? activeFile?.content || ""
                : file?.content || ""
        const nextContent =
            mode === "paste" && currentTargetContent
                ? `${currentTargetContent}\n${generatedCode}`
                : generatedCode

        updateFileContent(fileId, nextContent)
        if (file) {
            setActiveFile({
                ...file,
                content: nextContent,
                contentEncoding: "utf8",
            })
        }

        socket.emit(SocketEvent.FILE_UPDATED, {
            fileId,
            newContent: nextContent,
        })

        if (createdNewFile) {
            toast.success(`Created a new .${extension} file and inserted code`)
            return
        }
        toast.success(mode === "replace" ? "Code replaced successfully" : "Code pasted successfully")
    }

    const copyOutput = async () => {
        try {
            const content = extractCopilotCodePayload(output).content
            await navigator.clipboard.writeText(content)
            toast.success("Output copied to clipboard")
        } catch (error) {
            toast.error("Unable to copy output to clipboard")
            console.log(error)
        }
    }

    const pasteCodeInFile = () => {
        applyCopilotCodeToFile("paste")
    }

    const replaceCodeInFile = () => {
        applyCopilotCodeToFile("replace")
    }

    const handlePromptKeyDown = (
        event: React.KeyboardEvent<HTMLTextAreaElement>,
    ) => {
        if (event.key !== "Enter" || event.shiftKey) return
        event.preventDefault()
        if (isRunning) return
        generateCode()
    }

    return (
        <div
            className="sidebar-modern-view flex max-h-full min-h-[400px] w-full flex-col gap-3 p-4"
            style={{ height: viewHeight }}
        >
            <div className="sidebar-modern-header">
                <h1 className="view-title m-0 border-none pb-0">Copilot</h1>
            </div>
            <textarea
                className="sidebar-modern-control min-h-[120px] p-2 text-sm"
                placeholder="Ask anything: code, errors, concepts, or project questions..."
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handlePromptKeyDown}
            />
            <button
                className="sidebar-modern-btn sidebar-modern-btn--primary mt-1 flex w-full justify-center"
                onClick={generateCode}
                disabled={isRunning}
            >
                {isRunning ? "Thinking..." : "Ask Copilot"}
            </button>
            {output && (
                <div className="flex justify-end gap-4 pt-2">
                    <button className="sidebar-modern-btn h-9 w-9 p-0" title="Copy Output" onClick={copyOutput}>
                        <LuCopy
                            size={18}
                            className="cursor-pointer text-[var(--ui-text-primary)]"
                        />
                    </button>
                    <button
                        className="sidebar-modern-btn h-9 w-9 p-0"
                        title="Replace code in file"
                        onClick={replaceCodeInFile}
                    >
                        <LuRepeat
                            size={18}
                            className="cursor-pointer text-[var(--ui-text-primary)]"
                        />
                    </button>
                    <button
                        className="sidebar-modern-btn h-9 w-9 p-0"
                        title="Paste code in file"
                        onClick={pasteCodeInFile}
                    >
                        <LuClipboardPaste
                            size={18}
                            className="cursor-pointer text-[var(--ui-text-primary)]"
                        />
                    </button>
                </div>
            )}
            <div className="sidebar-modern-scroll h-full w-full overflow-y-auto p-2">
                <ReactMarkdown
                    components={{
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        code({ inline, className, children, ...props }: any) {
                            const match = /language-(\w+)/.exec(className || "")
                            const language = match ? match[1] : "javascript" // Default to JS

                            return !inline ? (
                                <SyntaxHighlighter
                                    style={dracula}
                                    language={language}
                                    PreTag="pre"
                                    className="!m-0 !h-full !rounded-lg !bg-gray-900 !p-2"
                                >
                                    {String(children).replace(/\n$/, "")}
                                </SyntaxHighlighter>
                            ) : (
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            )
                        },
                        pre({ children }) {
                            return <pre className="h-full">{children}</pre>
                        },
                    }}
                >
                    {output}
                </ReactMarkdown>
            </div>
        </div>
    )
}

export default CopilotView
