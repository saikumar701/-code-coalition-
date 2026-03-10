interface Language {
    language: string
    version: string
    aliases: string[]
}

interface RunDiagnostic {
    line: number
    column?: number
    message: string
}

interface RunContext {
    setInput: (input: string) => void
    output: string
    outputMode: "text" | "html"
    previewUrl: string
    isRunning: boolean
    isStoppingRunner: boolean
    hasRunError: boolean
    diagnostics: RunDiagnostic[]
    diagnosticFileId: string | null
    supportedLanguages: Language[]
    selectedLanguage: Language
    setSelectedLanguage: (language: Language) => void
    runCode: () => void
    stopProjectRunner: () => void
    openPreviewInNewTab: () => void
}

export { Language, RunContext, RunDiagnostic }
