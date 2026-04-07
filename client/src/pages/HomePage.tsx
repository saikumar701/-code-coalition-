import { useState } from "react"
import illustration from "@/assets/illustration.png"
import trainCatGif from "@/assets/misskalem-cat-14030_512.gif"
import FormComponent from "@/components/forms/FormComponent"

type MenuType = "features" | "about" | null

function HomePage() {
    const [openMenu, setOpenMenu] = useState<MenuType>(null)

    return (
        <div className="relative min-h-[100dvh] overflow-x-hidden bg-gray-950 text-gray-100">
            {/* NAVBAR */}
            <nav className="relative z-50 border-b border-gray-800">
                <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
                    <h1 className="text-lg font-semibold tracking-wide">
                        Code-Coalition
                    </h1>

                    <div className="relative hidden items-center gap-6 text-sm text-gray-300 sm:flex">
                        <button className="hover:text-white">Docs</button>

                        <button
                            className="hover:text-white"
                            onClick={() =>
                                setOpenMenu(openMenu === "features" ? null : "features")
                            }
                        >
                            Features
                        </button>

                        <button
                            className="hover:text-white"
                            onClick={() =>
                                setOpenMenu(openMenu === "about" ? null : "about")
                            }
                        >
                            About
                        </button>

                        {openMenu && (
                            <div className="absolute right-0 top-10 z-50 w-80 rounded-xl border border-gray-800 bg-gray-900 p-4 shadow-xl">
                                {openMenu === "features" && (
                                    <ul className="space-y-2 text-sm text-gray-300">
                                        <li>• AI Assistant</li>
                                        <li>• Live cursor tracking</li>
                                        <li>• Chat Box</li>
                                        <li>• Collaborative Board</li>
                                        <li>• Multiple Themes</li>
                                        <li>• Multi-language Support</li>
                                        <li>• Screen Sharing</li>
                                        <li>• Github and Gdrive file integration</li>
                                        <li>• File sharing</li>
                                        <li>• Teminal and Preview</li>
                                    </ul>
                                )}

                                {openMenu === "about" && (
                                    <p className="text-sm leading-relaxed text-gray-300">
                                        This is a major academic project developed by
                                        <span className="font-medium text-white">
                                            {" "}A. Aditthii{" "}
                                        </span>
                                        and
                                        <span className="font-medium text-white">
                                            {" "}A. Saikumar
                                        </span>,
                                        Cloud Computing final year students,
                                        Team No. 22.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </nav>

            {/* MAIN CONTENT */}
            <main className="mx-auto grid min-h-[calc(100dvh-56px)] w-full max-w-7xl grid-cols-1 items-start gap-8 px-4 pb-24 pt-6 sm:px-6 sm:pb-28 sm:pt-10 md:grid-cols-2 md:items-center md:gap-10">
                <section className="flex flex-col justify-center space-y-5 sm:space-y-6">
                    <span className="w-fit rounded-md bg-teal-500/10 px-3 py-1 text-xs font-medium text-teal-400">
                        Real-time Collaboration
                    </span>

                    <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">
                        A focused workspace for
                        <br />
                        collaborative coding
                    </h2>

                    <p className="max-w-xl text-sm leading-relaxed text-gray-400 sm:text-base">
                        Create secure rooms, collaborate in real time, and work together
                        without configuration overhead.
                    </p>

                    <img
                        src={illustration}
                        alt="Collaboration"
                        className="w-full max-w-xl self-center filter-none md:self-start"
                    />
                </section>

                <section className="flex items-center justify-center md:justify-end">
                    <div className="w-full max-w-md">
                        <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-5 shadow-lg">
                            <FormComponent />
                        </div>
                    </div>
                </section>
            </main>

            <div className="homepage-train-track hidden sm:block" aria-hidden="true">
                <img src={trainCatGif} alt="" className="homepage-train-cat" />
            </div>
        </div>
    )
}

export default HomePage
