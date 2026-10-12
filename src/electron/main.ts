// import {app, BrowserWindow} from "electron" 
// import path from 'path'
// import { isDev } from "./utils.js";

// //get the electron app and spin a browser window when ready
// app.on('ready', () => {
//     const mainWindow = new BrowserWindow({});

//     // is in dev mode run vite app on other terminal and load the 
//     // url so we get hotreloading and we wont need to restart app to check changes 
//     // -Omkar S
//     if(isDev()) { 
//         mainWindow.loadURL('http://localhost:5123')
//     }
//     else {
//         mainWindow.loadFile(path.join(app.getAppPath() + '/dist-react/index.html'))
//     }
// })


import { app, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { writeFile } from "fs/promises";
import { isDev } from "./utils.js";

app.on("ready", async () => {
    const mainWindow = new BrowserWindow({});

    if (isDev()) {
        mainWindow.loadURL("http://localhost:5123");
    } else {
        mainWindow.loadFile(
            path.join(app.getAppPath(), "dist-react", "index.html")
        );
    }

    // Get Windows user information
    const username = process.env.USERNAME;
    const userProfile = process.env.USERPROFILE;
    const localAppData = process.env.LOCALAPPDATA;

    console.log("Username:", username);
    console.log("User profile:", userProfile);

    // Project directory and file
    const projectPath = "D:\\CPP";
    const filePath = path.join(projectPath, "test_takeover.cpp");

    // Hello World C++ code
    const code = `#include <iostream>

int main() {
    std::cout << "Hello World!" << std::endl;
    return 0;
}
`;

    try {
        // Create project directory if it doesn't exist
        await fs.promises.mkdir(projectPath, { recursive: true });

        // Write C++ code to file
        await writeFile(filePath, code, "utf8");

        console.log("Created file:", filePath);

        // Locate VS Code
        const candidates = [
            path.join(
                localAppData || "",
                "Programs",
                "Microsoft VS Code",
                "Code.exe"
            ),
            "C:\\Program Files\\Microsoft VS Code\\Code.exe",
            "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe"
        ];

        const vscodePath = candidates.find(candidate =>
            fs.existsSync(candidate)
        );

        if (!vscodePath) {
            console.error("VS Code executable not found.");
            return;
        }

        // Open project and navigate to the generated file
        const vscode = spawn(
            vscodePath,
            [projectPath, "-g", `${filePath}:1:1`],
            {
                detached: true,
                stdio: "ignore",
                shell: false
            }
        );

        vscode.on("error", error => {
            console.error("Failed to open VS Code:", error.message);
        });

        vscode.unref();

    } catch (error) {
        console.error("Operation failed:", error);
    }
});
