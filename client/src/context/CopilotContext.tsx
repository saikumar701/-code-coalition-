import { ICopilotContext } from "@/types/copilot"
import { BACKEND_URL } from "@/config/backend"
import axios from "axios"
import { ReactNode, createContext, useContext, useState } from "react"
import toast from "react-hot-toast"

const CopilotContext = createContext<ICopilotContext | null>(null)

const COPILOT_ENDPOINT = BACKEND_URL
    ? `${BACKEND_URL}/api/copilot/generate`
    : "/api/copilot/generate"

// eslint-disable-next-line react-refresh/only-export-components
export const useCopilot = () => {
    const context = useContext(CopilotContext)
    if (context === null) {
        throw new Error(
            "useCopilot must be used within a CopilotContextProvider",
        )
    }
    return context
}

const CopilotContextProvider = ({ children }: { children: ReactNode }) => {
    const [input, setInput] = useState<string>("")
    const [output, setOutput] = useState<string>("")
    const [isRunning, setIsRunning] = useState<boolean>(false)

    const generateCode = async () => {
        const trimmedInput = input.trim()
        if (!trimmedInput) {
            toast.error("Please write a prompt")
            return
        }

        const toastId = toast.loading("Generating code...")
        setIsRunning(true)

        try {
            const response = await axios.post(
                COPILOT_ENDPOINT,
                {
                    prompt: trimmedInput,
                    // Use Gemini by default; server will fall back if omitted.
                    model: "gemini-2.5-flash",
                    systemPrompt:
                        "You are Code Coalition Copilot. You can answer general questions, explain errors, and generate code. If the user asks for code, provide runnable code in fenced markdown blocks and keep explanations concise. If the user asks general questions, respond normally in clear markdown.",
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                    },
                    timeout: 60000,
                },
            )

            const generatedText =
                response.data?.text ||
                response.data?.output ||
                response.data?.candidates?.[0]?.content?.parts
                    ?.map((part: { text?: string }) => part.text || "")
                    .join("\n")

            if (!generatedText || typeof generatedText !== "string") {
                throw new Error("Empty response from Copilot API")
            }

            setOutput(generatedText.trim())
            toast.success("Code generated successfully", { id: toastId })
        } catch (error) {
            let message = "Failed to generate the code"
            if (axios.isAxiosError(error)) {
                message =
                    (error.response?.data?.error as string) ||
                    error.message ||
                    message
            }
            toast.error(message, { id: toastId })
        } finally {
            setIsRunning(false)
        }
    }

    return (
        <CopilotContext.Provider
            value={{
                setInput,
                output,
                isRunning,
                generateCode,
            }}
        >
            {children}
        </CopilotContext.Provider>
    )
}

export { CopilotContextProvider }
export default CopilotContext
