import axios, { AxiosInstance } from "axios"
import { BACKEND_URL } from "@/config/backend"

const pistonBaseUrl = `${BACKEND_URL}/api/piston`

const instance: AxiosInstance = axios.create({
    baseURL: pistonBaseUrl,
    headers: {
        "Content-Type": "application/json",
    },
})

export default instance
